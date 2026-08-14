import Foundation
import SwiftData

/// iCloud 冲突副本（`<name> 2.canvas` / `<name> 2.nb-sync.json`）的仲裁信息
struct SyncConflict: Identifiable, Sendable, Hashable {
    enum Kind: String, Sendable { case canvas, sidecar }

    let book: String
    let kind: Kind
    let mainPath: String
    let conflictPath: String
    let mainUpdatedAt: Date?
    let conflictUpdatedAt: Date?
    let mainWords: [String]
    let conflictWords: [String]

    var id: String { "\(kind.rawValue):\(conflictPath)" }

    var changedWords: [String] {
        let mainSet = Set(mainWords)
        let copySet = Set(conflictWords)
        return Array(mainSet.symmetricDifference(copySet)).sorted()
    }
}

extension SyncConflict {
    var bookDisplayName: String {
        let base = (book as NSString).lastPathComponent
        return base.hasSuffix(".canvas") ? String(base.dropLast(".canvas".count)) : base
    }
}

/// 一次扫描的产物：一个 Canvas 词库的解析结果 + 对应边车的进度
private struct CanvasSnapshot: Sendable {
    let relative: String
    let words: [ParsedWord]
    let progress: [String: StudyProgress]
    let canvasMtime: Date?
    let sidecarMtime: Date?
}

@MainActor
final class SyncService {
    private(set) var syncDir: URL?
    private(set) var conflicts: [SyncConflict] = []
    private var timer: Timer?
    private var scanning = false
    private var lastMtimes: [String: (canvas: Date?, sidecar: Date?)] = [:]
    private let store: DataStore
    private let onConflictsChanged: ([SyncConflict]) -> Void
    private let onStatusChanged: (String) -> Void

    init(
        store: DataStore,
        onConflictsChanged: @escaping ([SyncConflict]) -> Void,
        onStatusChanged: @escaping (String) -> Void = { _ in }
    ) {
        self.store = store
        self.onConflictsChanged = onConflictsChanged
        self.onStatusChanged = onStatusChanged
    }

    /// 保存用户选择的同步目录。返回 false 表示该目录当前读不到（权限未授予或目录无效）。
    /// 调用成功后 SyncService 会在进程存活期间一直持有已开启安全作用域的 URL。
    @discardableResult
    func configure(folder url: URL) -> Bool {
        // 文档选择器返回的是安全作用域 URL：在回调内立即开启作用域并长期持有，
        // 否则离开选择器回调后访问会失效（这就是之前真机上无法同步的根因）。
        let scoped = url.startAccessingSecurityScopedResource()
        syncDir = url
        if let bookmark = try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil) {
            BookmarkStore.save(bookmark)
        }
        if scoped {
            NSLog("[SyncService] security scope active for %@", url.path)
        }
        // 作用域开启失败不代表一定不可用（模拟器/沙盒内路径不需要作用域），以能否读到目录为准。
        let readable = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) != nil
        if !readable {
            NSLog("[SyncService] selected directory is not readable: %@", url.path)
            syncDir = nil
            BookmarkStore.clear()
        }
        return readable
    }

    func start() {
        stop()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.scan() }
        }
        Task { @MainActor in await scan() }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// 全量扫描：文件 IO 全部在后台线程；未变化的文件跳过，主线程只做最小合并
    func scan() async {
        if scanning { return }
        scanning = true
        defer { scanning = false }
        guard let root = root() else {
            if BookmarkStore.load() == nil {
                onStatusChanged("未选择同步目录：请到「设置」选择 iCloud 云盘中的 NoteBar 文件夹")
            } else {
                onStatusChanged("无法访问同步目录：请到「设置」重新选择 iCloud 中的 NoteBar 文件夹")
            }
            return
        }

        let payload = await Task.detached(priority: .utility) {
            Self.collect(root: root)
        }.value

        guard let payload else {
            syncDir = nil
            onStatusChanged("同步失败：目录权限不可用，请到「设置」重新选择 iCloud 中的 NoteBar 文件夹")
            return
        }

        conflicts = payload.conflicts
        onConflictsChanged(conflicts)

        var changed = false
        for snapshot in payload.snapshots {
            let previous = lastMtimes[snapshot.relative]
            if previous?.canvas == snapshot.canvasMtime, previous?.sidecar == snapshot.sidecarMtime {
                continue
            }
            lastMtimes[snapshot.relative] = (snapshot.canvasMtime, snapshot.sidecarMtime)

            for word in snapshot.words {
                let key = StudyKey.canvas(source: snapshot.relative, nodeId: word.nodeId)
                let remote = snapshot.progress[key]?.withLegacyFieldsDerived()
                if let existing = try? store.entry(forKey: key) {
                    if existing.word != word.word { existing.word = word.word; changed = true }
                    if existing.definition != word.definition { existing.definition = word.definition; changed = true }
                    if existing.aliases != word.aliases { existing.aliases = word.aliases; changed = true }
                    if existing.color != word.color { existing.color = word.color; changed = true }
                    if existing.addedDate != word.addedDate { existing.addedDate = word.addedDate; changed = true }
                    if existing.mastered != word.mastered { existing.mastered = word.mastered; changed = true }
                    if let remote, let merged = Merge.progress(local: existing.progress, remote: remote) {
                        if merged != existing.progress { existing.progress = merged; changed = true }
                    }
                } else {
                    try? store.upsert(word: word, book: snapshot.relative, source: snapshot.relative, progress: remote)
                    changed = true
                }
            }
        }
        if changed {
            try? store.context.save()
        }
        onStatusChanged("已连接：\(root.lastPathComponent) · 最近同步 \(Self.timeString(Date()))")
    }

    /// 评分后写回边车：读磁盘 → 合并 → 原子写，全部在后台线程
    func persist(book: String, key: String, progress: StudyProgress) {
        guard let root = root() else {
            onStatusChanged("无法访问同步目录：进度未能写回 iCloud")
            return
        }
        let base = book.replacingOccurrences(of: "\\.canvas$", with: "", options: .regularExpression)
        let sidecarURL = root.appendingPathComponent("\(base).nb-sync.json")
        Task.detached(priority: .utility) {
            Self.writeProgress(progress, key: key, book: book, at: sidecarURL)
        }
    }

    /// 读取 Canvas JSON（后台 IO，主线程解析）
    func readCanvas(_ relative: String) async -> [String: Any]? {
        guard let root = root() else { return nil }
        let url = root.appendingPathComponent(relative)
        let result = await Task.detached(priority: .utility) {
            Self.readData(at: url)
        }.value
        guard let data = result else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// 写回 Canvas JSON（后台原子写）
    func writeCanvas(_ relative: String, data: [String: Any]) {
        guard let root = root() else {
            onStatusChanged("无法访问同步目录：单词内容未能写回 iCloud")
            return
        }
        let url = root.appendingPathComponent(relative)
        guard let encoded = try? JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys]) else { return }
        Task.detached(priority: .utility) {
            Self.writeAtomically(encoded, to: url)
        }
    }

    /// 冲突仲裁：保留主版本或保留副本版本，之后重新扫描
    func resolve(_ conflict: SyncConflict, keepCopy: Bool) {
        guard let root = root() else { return }
        let main = URL(fileURLWithPath: conflict.mainPath)
        let copy = URL(fileURLWithPath: conflict.conflictPath)
        let archive = copy.appendingPathExtension("resolved-\(Int(Date().timeIntervalSince1970))")
        Task.detached(priority: .utility) {
            let fm = FileManager.default
            if keepCopy {
                _ = try? fm.replaceItemAt(main, withItemAt: copy)
            } else {
                try? fm.moveItem(at: copy, to: archive)
            }
        }
        conflicts.removeAll { $0.id == conflict.id }
        lastMtimes.removeValue(forKey: conflict.book)
        onConflictsChanged(conflicts)
        Task { @MainActor in await scan() }
    }

    // MARK: - 后台实现

    /// 取当前可用的同步目录；书签解析成功后把 URL 留在进程内，保证安全作用域持续有效。
    private func root() -> URL? {
        if let dir = syncDir { return dir }
        if let resolved = BookmarkStore.resolve() {
            syncDir = resolved
            return resolved
        }
        return nil
    }

    private nonisolated static func timeString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    private nonisolated static func readData(at url: URL) -> Data? {
        var coordinatorError: NSError?
        var result: Data?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinatorError) { target in
            result = try? Data(contentsOf: target)
        }
        if let coordinatorError {
            NSLog("[SyncService] read coordination failed for %@: %@", url.path, String(describing: coordinatorError))
        }
        return result
    }

    /// 目录枚举失败（典型原因是安全作用域失效）时返回 nil，让调用方提示用户重新授权。
    private nonisolated static func collect(root: URL) -> (snapshots: [CanvasSnapshot], conflicts: [SyncConflict])? {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else {
            return nil
        }

        var files: [URL] = []
        while let url = enumerator.nextObject() as? URL { files.append(url) }

        var sidecars: [String: SidecarFile] = [:]
        var canvasMtimes: [String: Date] = [:]
        var sidecarMtimes: [String: Date] = [:]
        var canvases: [(relative: String, url: URL)] = []
        var conflicts: [SyncConflict] = []

        for url in files {
            let rel = url.path.replacingOccurrences(of: root.path + "/", with: "")
            let ext = url.pathExtension.lowercased()
            let name = url.lastPathComponent
            let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)

            if ext == "canvas" {
                if let base = conflictBase(name: name, suffix: ".canvas") {
                    let mainURL = url.deletingLastPathComponent().appendingPathComponent(base)
                    let mainRel = mainURL.path.replacingOccurrences(of: root.path + "/", with: "")
                    conflicts.append(SyncConflict(
                        book: mainRel,
                        kind: .canvas,
                        mainPath: mainURL.path,
                        conflictPath: url.path,
                        mainUpdatedAt: (try? mainURL.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate),
                        conflictUpdatedAt: mtime,
                        mainWords: canvasWords(mainURL),
                        conflictWords: canvasWords(url)
                    ))
                } else {
                    canvases.append((rel, url))
                    canvasMtimes[rel] = mtime
                }
            } else if ext == "json" && name.hasSuffix(".nb-sync.json") {
                if let base = conflictBase(name: name, suffix: ".nb-sync.json") {
                    let mainURL = url.deletingLastPathComponent().appendingPathComponent(base)
                    let mainRel = mainURL.path.replacingOccurrences(of: root.path + "/", with: "")
                    conflicts.append(SyncConflict(
                        book: mainRel.replacingOccurrences(of: "\\.nb-sync\\.json$", with: ".canvas", options: .regularExpression),
                        kind: .sidecar,
                        mainPath: mainURL.path,
                        conflictPath: url.path,
                        mainUpdatedAt: (try? mainURL.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate),
                        conflictUpdatedAt: mtime,
                        mainWords: sidecarWords(mainURL),
                        conflictWords: sidecarWords(url)
                    ))
                } else {
                    if let data = readData(at: url),
                       let sidecar = try? JSONDecoder().decode(SidecarFile.self, from: data) {
                        sidecars[sidecar.book] = sidecar
                        sidecarMtimes[sidecar.book] = mtime
                    }
                }
            }
        }

        let snapshots = canvases.map { relative, url in
            let data = readData(at: url) ?? Data()
            let words = (try? CanvasEditor.parseWords(data: data, source: relative)) ?? []
            return CanvasSnapshot(
                relative: relative,
                words: words,
                progress: sidecars[relative]?.words ?? [:],
                canvasMtime: canvasMtimes[relative],
                sidecarMtime: sidecarMtimes[relative]
            )
        }
        return (snapshots, conflicts)
    }

    private nonisolated static func conflictBase(name: String, suffix: String) -> String? {
        let escaped = NSRegularExpression.escapedPattern(for: suffix)
        guard let regex = try? NSRegularExpression(pattern: "^(.+) \\d+\(escaped)$") else { return nil }
        let range = NSRange(name.startIndex..., in: name)
        guard let match = regex.firstMatch(in: name, range: range),
              match.numberOfRanges > 1,
              let r = Range(match.range(at: 1), in: name) else { return nil }
        return "\(name[r])\(suffix)"
    }

    private nonisolated static func canvasWords(_ url: URL) -> [String] {
        guard let data = readData(at: url),
              let words = try? CanvasEditor.parseWords(data: data, source: "") else { return [] }
        return words.map(\.word).sorted()
    }

    private nonisolated static func sidecarWords(_ url: URL) -> [String] {
        guard let data = readData(at: url),
              let sidecar = try? JSONDecoder().decode(SidecarFile.self, from: data) else { return [] }
        return sidecar.words.keys.sorted()
    }

    private nonisolated static func writeProgress(_ progress: StudyProgress, key: String, book: String, at url: URL) {
        var sidecar: SidecarFile
        if let data = readData(at: url),
           let decoded = try? JSONDecoder().decode(SidecarFile.self, from: data) {
            sidecar = decoded
        } else {
            sidecar = SidecarFile(version: 1, book: book, words: [:], updatedAt: "")
        }
        sidecar.words[key] = Merge.progress(local: sidecar.words[key], remote: progress)
        sidecar.updatedAt = ISO8601DateFormatter().string(from: Date())
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(sidecar) {
            writeAtomically(data, to: url)
        }
    }

    private nonisolated static func writeAtomically(_ data: Data, to url: URL) {
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.appendingPathExtension("tmp")
        var coordinatorError: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordinatorError) { target in
            try? data.write(to: tmp, options: .atomic)
            _ = try? fm.replaceItemAt(target, withItemAt: tmp)
        }
    }
}
