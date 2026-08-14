import Foundation
import SwiftData

/// 一次扫描的产物：一个 Canvas 词库的解析结果 + 对应边车的进度
private struct CanvasSnapshot: Sendable {
    let relative: String
    let words: [ParsedWord]
    let progress: [String: StudyProgress]
}

@MainActor
final class SyncService {
    private(set) var syncDir: URL?
    private var timer: Timer?
    private var scanning = false
    private let store: DataStore
    private let onConflict: (String) -> Void

    init(store: DataStore, onConflict: @escaping (String) -> Void) {
        self.store = store
        self.onConflict = onConflict
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

    /// 全量扫描：文件 IO 全部在后台线程，主线程只负责合并入 SwiftData
    func scan() async {
        if scanning { return }
        scanning = true
        defer { scanning = false }
        guard let root = syncDir ?? BookmarkStore.resolve() else { return }

        let snapshots = await Task.detached(priority: .utility) {
            Self.collectSnapshots(root: root)
        }.value

        for snapshot in snapshots {
            for word in snapshot.words {
                let key = StudyKey.canvas(source: snapshot.relative, nodeId: word.nodeId)
                let remote = snapshot.progress[key]
                if let existing = try? store.entry(forKey: key) {
                    existing.word = word.word
                    existing.definition = word.definition
                    existing.aliases = word.aliases
                    existing.color = word.color
                    existing.addedDate = word.addedDate
                    existing.mastered = word.mastered
                    if let remote, let merged = Merge.progress(local: existing.progress, remote: remote) {
                        existing.progress = merged
                    }
                } else {
                    try? store.upsert(word: word, book: snapshot.relative, source: snapshot.relative, progress: remote)
                }
            }
        }
        try? store.context.save()
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

    // MARK: - 后台实现（不接触任何主线程状态）

    private nonisolated static func collectSnapshots(root: URL) -> [CanvasSnapshot] {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
        var sidecars: [String: SidecarFile] = [:]
        var canvases: [(relative: String, url: URL)] = []
        while let url = enumerator.nextObject() as? URL {
            let ext = url.pathExtension.lowercased()
            let rel = url.path.replacingOccurrences(of: root.path + "/", with: "")
            if ext == "canvas" {
                canvases.append((rel, url))
            } else if ext == "json" && url.lastPathComponent.hasSuffix(".nb-sync.json") {
                if let data = try? Data(contentsOf: url),
                   let sidecar = try? JSONDecoder().decode(SidecarFile.self, from: data) {
                    sidecars[sidecar.book] = sidecar
                }
            }
        }
        return canvases.map { relative, url in
            let data = (try? Data(contentsOf: url)) ?? Data()
            let words = (try? CanvasEditor.parseWords(data: data, source: relative)) ?? []
            return CanvasSnapshot(relative: relative, words: words, progress: sidecars[relative]?.words ?? [:])
        }
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
