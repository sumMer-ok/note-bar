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

    init(store: DataStore, onConflictsChanged: @escaping ([SyncConflict]) -> Void) {
        self.store = store
        self.onConflictsChanged = onConflictsChanged
    }

    func configure(folder url: URL) {
        syncDir = url
        if let bookmark = try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil) {
            BookmarkStore.save(bookmark)
        }
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
        guard let root = syncDir ?? BookmarkStore.resolve() else { return }

        let payload = await Task.detached(priority: .utility) {
            Self.collect(root: root)
        }.value

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
                let remote = snapshot.progress[key]
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
    }

    /// 评分后写回边车：读磁盘 → 合并 → 原子写，全部在后台线程
    func persist(book: String, key: String, progress: StudyProgress) {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return }
        let base = book.replacingOccurrences(of: "\\.canvas$", with: "", options: .regularExpression)
        let sidecarURL = root.appendingPathComponent("\(base).nb-sync.json")
        Task.detached(priority: .utility) {
            Self.writeProgress(progress, key: key, book: book, at: sidecarURL)
        }
    }

    /// 读取 Canvas JSON（后台 IO，主线程解析）
    func readCanvas(_ relative: String) async -> [String: Any]? {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return nil }
        let url = root.appendingPathComponent(relative)
        let result = await Task.detached(priority: .utility) {
            try? Data(contentsOf: url)
        }.value
        guard let data = result else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// 写回 Canvas JSON（后台原子写）
    func writeCanvas(_ relative: String, data: [String: Any]) {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return }
        let url = root.appendingPathComponent(relative)
        guard let encoded = try? JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys]) else { return }
        Task.detached(priority: .utility) {
            Self.writeAtomically(encoded, to: url)
        }
    }

    /// 冲突仲裁：保留主版本或保留副本版本，之后重新扫描
    func resolve(_ conflict: SyncConflict, keepCopy: Bool) {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return }
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

    private nonisolated static func collect(root: URL) -> (snapshots: [CanvasSnapshot], conflicts: [SyncConflict]) {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else {
            return ([], [])
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
                    if let data = try? Data(contentsOf: url),
                       let sidecar = try? JSONDecoder().decode(SidecarFile.self, from: data) {
                        sidecars[sidecar.book] = sidecar
                        sidecarMtimes[sidecar.book] = mtime
                    }
                }
            }
        }

        let snapshots = canvases.map { relative, url in
            let data = (try? Data(contentsOf: url)) ?? Data()
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
        guard let data = try? Data(contentsOf: url),
              let words = try? CanvasEditor.parseWords(data: data, source: "") else { return [] }
        return words.map(\.word).sorted()
    }

    private nonisolated static func sidecarWords(_ url: URL) -> [String] {
        guard let data = try? Data(contentsOf: url),
              let sidecar = try? JSONDecoder().decode(SidecarFile.self, from: data) else { return [] }
        return sidecar.words.keys.sorted()
    }

    private nonisolated static func writeProgress(_ progress: StudyProgress, key: String, book: String, at url: URL) {
        var sidecar: SidecarFile
        if let data = try? Data(contentsOf: url),
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
