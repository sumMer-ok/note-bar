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
    /// 逻辑词库名统一为 `Words/xxx.canvas`（与桌面插件契约一致）。
    /// 若用户直接选了 Words 目录本身，prefix 为空，物理路径不加 Words/。
    private var logicalPrefix = "Words/"

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
        logicalPrefix = Self.logicalPrefix(for: url)
        if let bookmark = try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil) {
            BookmarkStore.save(bookmark)
        }
        if scoped {
            NSLog("[SyncService] security scope active for %@ (prefix=%@)", url.path, logicalPrefix)
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

        let prefix = logicalPrefix
        let payload = await Task.detached(priority: .utility) {
            Self.collect(root: root, logicalPrefix: prefix)
        }.value

        guard let payload else {
            syncDir = nil
            onStatusChanged("同步失败：目录权限不可用，请到「设置」重新选择 iCloud 中的 NoteBar 文件夹")
            return
        }

        conflicts = payload.conflicts
        onConflictsChanged(conflicts)

        var changed = false
        var pendingPush: [Entry] = []
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
                    let textChanged = existing.word != word.word
                        || existing.definition != word.definition
                        || existing.aliases != word.aliases
                    if textChanged, existing.localEditedAt != nil {
                        // 本地编辑还没成功上传：保留本地内容，稍后重新推送，避免被云端旧版覆盖
                        pendingPush.append(existing)
                        changed = true
                    } else {
                        if existing.word != word.word { existing.word = word.word; changed = true }
                        if existing.definition != word.definition { existing.definition = word.definition; changed = true }
                        if existing.aliases != word.aliases { existing.aliases = word.aliases; changed = true }
                    }
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
        // 清理「词库」列表：只保留本次扫描实际存在的词库。
        // 覆盖两种情况：选错目录产生的裸文件名词库，以及此前递归扫描产生的
        // Words/Words/... 重复词库。仅在扫描到至少一个词库时执行，避免误清空。
        let currentBooks = Set(payload.snapshots.map(\.relative))
        if !currentBooks.isEmpty {
            if let all = try? store.context.fetch(FetchDescriptor<Entry>()) {
                for entry in all where !currentBooks.contains(entry.book) {
                    store.context.delete(entry)
                    changed = true
                }
            }
            if changed {
                try? store.context.save()
            }
        }
        for entry in pendingPush {
            await pushLocalEntry(entry)
        }
        onStatusChanged("已连接：\(root.lastPathComponent) · 最近同步 \(Self.timeString(Date()))")
    }

    /// 把本地未上传的单词编辑重新写回 iCloud；成功后清除「待推送」标记
    private func pushLocalEntry(_ entry: Entry) async {
        guard var canvas = await readCanvas(entry.book) else { return }
        guard CanvasEditor.updateWord(
            data: &canvas,
            nodeId: entry.nodeId,
            word: entry.word,
            definition: entry.definition,
            aliases: entry.aliases
        ) else { return }
        if await writeCanvas(entry.book, data: canvas) {
            entry.localEditedAt = nil
            try? store.context.save()
        }
    }

    /// 评分后写回边车：读磁盘 → 合并 → 原子写，全部在后台线程
    func persist(book: String, key: String, progress: StudyProgress) {
        guard let sidecarURL = physicalURL(for: book, suffix: ".nb-sync.json", replacingExtension: ".canvas") else {
            onStatusChanged("无法访问同步目录：进度未能写回 iCloud")
            return
        }
        Task {
            let ok = await Task.detached(priority: .utility) {
                guard Self.writeProgress(progress, key: key, book: book, at: sidecarURL) else { return false }
                // 读回校验：iCloud 提供器偶发不提交写入，失败时重试一次
                guard let data = Self.readData(at: sidecarURL),
                      let sidecar = try? JSONDecoder().decode(SidecarFile.self, from: data),
                      let written = sidecar.words[key] else { return false }
                return written.lastReview == progress.lastReview
            }.value
            if !ok {
                let retried = await Task.detached(priority: .utility) {
                    Self.writeProgress(progress, key: key, book: book, at: sidecarURL)
                }.value
                if !retried {
                    onStatusChanged("无法写回 iCloud：本次评分未同步到电脑端，请重试或重新选择同步目录")
                }
            }
        }
    }

    /// 读取 Canvas JSON（后台 IO，主线程解析）
    func readCanvas(_ relative: String) async -> [String: Any]? {
        guard let url = physicalURL(for: relative, suffix: "", replacingExtension: nil) else {
            onStatusChanged("无法读取同步目录：请到「设置」重新选择 iCloud 中的 NoteBar 文件夹")
            return nil
        }
        let result = await Task.detached(priority: .utility) {
            Self.readData(at: url)
        }.value
        guard let data = result else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// 写回 Canvas JSON（后台原子写）
    @discardableResult
    func writeCanvas(_ relative: String, data: [String: Any]) async -> Bool {
        guard let url = physicalURL(for: relative, suffix: "", replacingExtension: nil) else {
            onStatusChanged("无法访问同步目录：单词内容未能写回 iCloud")
            return false
        }
        guard let encoded = try? JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys]) else { return false }
        let ok = await Task.detached(priority: .utility) {
            Self.writeAtomically(encoded, to: url)
        }.value
        if ok {
            // 读回校验：若提供器没有真正提交，立即重写一次
            let committed = await Task.detached(priority: .utility) {
                Self.readData(at: url) == encoded
            }.value
            if !committed {
                let retried = await Task.detached(priority: .utility) {
                    Self.writeAtomically(encoded, to: url)
                }.value
                if !retried {
                    onStatusChanged("无法写回 iCloud：单词修改未同步到电脑端，请重试或重新选择同步目录")
                    return false
                }
            }
        } else {
            onStatusChanged("无法写回 iCloud：单词修改未同步到电脑端，请重试或重新选择同步目录")
        }
        return ok
    }

    /// 删除一个词库：移除本地词条与 iCloud 中的 Canvas / 进度边车。
    /// 返回是否成功删除文件；本地词条总是先移除，避免继续显示。
    @discardableResult
    func deleteBook(_ book: String) async -> Bool {
        if let all = try? store.context.fetch(FetchDescriptor<Entry>()) {
            for entry in all where entry.book == book {
                store.context.delete(entry)
            }
            try? store.context.save()
        }
        lastMtimes.removeValue(forKey: book)

        guard let canvasURL = physicalURL(for: book, suffix: "", replacingExtension: nil),
              let sidecarURL = physicalURL(for: book, suffix: ".nb-sync.json", replacingExtension: ".canvas") else {
            return false
        }
        let ok = await Task.detached(priority: .utility) {
            let fm = FileManager.default
            var removed = true
            for url in [canvasURL, sidecarURL] where fm.fileExists(atPath: url.path) {
                do {
                    try fm.removeItem(at: url)
                } catch {
                    NSLog("[SyncService] delete failed for %@: %@", url.path, String(describing: error))
                    removed = false
                }
            }
            return removed
        }.value
        return ok
    }

    /// 冲突仲裁：保留主版本或保留副本版本，之后重新扫描
    func resolve(_ conflict: SyncConflict, keepCopy: Bool) {
        guard root() != nil else { return }
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
            logicalPrefix = Self.logicalPrefix(for: resolved)
            return resolved
        }
        return nil
    }

    /// 用户选 NoteBar 时为 `Words/`；用户直接选 Words 目录时为空。
    private nonisolated static func logicalPrefix(for root: URL) -> String {
        let fm = FileManager.default
        let entries = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
        let hasCanvasDirectly = entries.contains { $0.lowercased().hasSuffix(".canvas") }
        return hasCanvasDirectly ? "" : "Words/"
    }

    /// 逻辑名 `Words/xxx.canvas` → 实际文件 URL。
    /// 选 NoteBar 时落在 `NoteBar/Words/`；选 Words 目录本身时落在该目录下。
    private func physicalURL(for logical: String, suffix: String, replacingExtension ext: String?) -> URL? {
        guard let root = root() else { return nil }
        var name = logical
        if name.hasPrefix("Words/") {
            name = String(name.dropFirst("Words/".count))
        }
        if let ext, name.hasSuffix(ext) {
            name = String(name.dropLast(ext.count))
        }
        let base = logicalPrefix == "Words/" ? root.appendingPathComponent("Words", isDirectory: true) : root
        return base.appendingPathComponent(name + suffix)
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
    private nonisolated static func collect(
        root: URL,
        logicalPrefix: String
    ) -> (snapshots: [CanvasSnapshot], conflicts: [SyncConflict])? {
        let fm = FileManager.default
        var isDirectory: ObjCBool = false
        guard fm.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return nil
        }

        // 词库固定放在 <root>/Words/ 下，且没有更深层级；
        // 只列这一层，避免把 Words/Words 之类的错误嵌套目录当成新词库。
        let booksDir = logicalPrefix == "Words/"
            ? root.appendingPathComponent("Words", isDirectory: true)
            : root
        var files: [URL]
        if fm.fileExists(atPath: booksDir.path, isDirectory: &isDirectory), isDirectory.boolValue {
            guard let listed = try? fm.contentsOfDirectory(
                at: booksDir,
                includingPropertiesForKeys: [.contentModificationDateKey]
            ) else { return nil }
            files = listed
        } else {
            files = []
        }

        var sidecars: [String: SidecarFile] = [:]
        var canvasMtimes: [String: Date] = [:]
        var sidecarMtimes: [String: Date] = [:]
        var canvases: [(relative: String, url: URL)] = []
        var conflicts: [SyncConflict] = []

        for url in files {
            let rel = "Words/\(url.lastPathComponent)"
            let ext = url.pathExtension.lowercased()
            let name = url.lastPathComponent
            let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)

            if ext == "canvas" {
                if let base = conflictBase(name: name, suffix: ".canvas") {
                    let mainURL = url.deletingLastPathComponent().appendingPathComponent(base)
                    let mainRel = "Words/\(mainURL.lastPathComponent)"
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
                    let mainRel = "Words/\(mainURL.lastPathComponent)"
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

    private nonisolated static func writeProgress(_ progress: StudyProgress, key: String, book: String, at url: URL) -> Bool {
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
            return writeAtomically(data, to: url)
        }
        return false
    }

    /// iCloud 文件提供器上必须用 `replaceItemAt` 完成替换，直接 `.atomic` 写协调
    /// 目标有时只在本地生效、不会触发上传。这里以 replaceItemAt 为主，
    /// 失败时降级为直接覆盖，并记录错误。
    @discardableResult
    private nonisolated static func writeAtomically(_ data: Data, to url: URL) -> Bool {
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.appendingPathExtension("nb-tmp")
        var coordinatorError: NSError?
        var writeError: Error?
        var success = false
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordinatorError) { target in
            do {
                try data.write(to: tmp, options: [.atomic])
                do {
                    _ = try fm.replaceItemAt(target, withItemAt: tmp)
                    success = true
                } catch {
                    // 提供器拒绝 replaceItemAt 时，直接在协调目标上覆盖
                    do {
                        try data.write(to: target, options: [])
                        try? fm.removeItem(at: tmp)
                        success = true
                    } catch {
                        writeError = error
                        try? fm.removeItem(at: tmp)
                    }
                }
            } catch {
                writeError = error
                try? fm.removeItem(at: tmp)
            }
        }
        if let coordinatorError {
            NSLog("[SyncService] write coordination failed for %@: %@", url.path, String(describing: coordinatorError))
            // 协调失败时仍尝试直接覆盖，避免编辑完全丢失
            do {
                try data.write(to: url, options: [])
                success = true
            } catch {
                NSLog("[SyncService] direct write failed for %@: %@", url.path, String(describing: error))
            }
        }
        if let writeError {
            NSLog("[SyncService] write failed for %@: %@", url.path, String(describing: writeError))
        }
        if success {
            NSLog("[SyncService] wrote %@ (%d bytes)", url.path, data.count)
        }
        return success
    }
}
