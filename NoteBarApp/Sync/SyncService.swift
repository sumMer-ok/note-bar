import Foundation
import SwiftData

@MainActor
final class SyncService {
    private(set) var syncDir: URL?
    private var timer: Timer?
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

    /// 全量扫描：canvas 解析 + 边车进度合并入 SwiftData
    func scan() async {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return }
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: nil) else { return }
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

        for (relative, url) in canvases {
            let data = (try? Data(contentsOf: url)) ?? Data()
            let words = (try? CanvasEditor.parseWords(data: data, source: relative)) ?? []
            for word in words {
                let key = StudyKey.canvas(source: relative, nodeId: word.nodeId)
                let remote = sidecars[relative]?.words[key]
                if let existing = try? store.entry(forKey: key) {
                    existing.word = word.word
                    existing.definition = word.definition
                    existing.aliases = word.aliases
                    existing.color = word.color
                    existing.addedDate = word.addedDate
                    if let remote, let merged = Merge.progress(local: existing.progress, remote: remote) {
                        existing.progress = merged
                    }
                } else {
                    try? store.upsert(word: word, book: relative, source: relative, progress: remote)
                }
            }
        }
        try? store.context.save()
    }

    /// 评分后写回边车：读磁盘 → 合并 → 原子写
    func persist(book: String, key: String, progress: StudyProgress) {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return }
        let base = book.replacingOccurrences(of: "\\.canvas$", with: "", options: .regularExpression)
        let sidecarURL = root.appendingPathComponent("\(base).nb-sync.json")
        var sidecar: SidecarFile
        if let data = try? Data(contentsOf: sidecarURL),
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
            writeAtomically(data, to: sidecarURL)
        }
    }

    func readCanvas(_ relative: String) -> [String: Any]? {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return nil }
        let url = root.appendingPathComponent(relative)
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json
    }

    func writeCanvas(_ relative: String, data: [String: Any]) {
        guard let root = syncDir ?? BookmarkStore.resolve() else { return }
        let url = root.appendingPathComponent(relative)
        let encoded = try? JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys])
        guard let encoded else { return }
        writeAtomically(encoded, to: url)
    }

    private func writeAtomically(_ data: Data, to url: URL) {
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
