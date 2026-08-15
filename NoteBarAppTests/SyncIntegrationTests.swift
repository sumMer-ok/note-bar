import XCTest
import SwiftData
@testable import NoteBarApp

/// 用真实 Obsidian 数据验证 App 的同步链路：
/// 读 iCloud 同步目录（Canvas 镜像 + 边车）→ SwiftData → 评分写回边车。
/// 依赖宿主机上已由 scripts/seed-sync-dir.mjs 生成的同步目录；缺失时跳过。
@MainActor
final class SyncIntegrationTests: XCTestCase {
    func testConflictCopyDetectionAndResolution() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("nb-conflict-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // 同步契约：词库固定在 <root>/Words/ 下
        let wordsDir = dir.appendingPathComponent("Words", isDirectory: true)
        try FileManager.default.createDirectory(at: wordsDir, withIntermediateDirectories: true)

        let main = #"{"nodes":[{"id":"a","type":"text","text":"hello\n\n你好"}],"edges":[]}"#
        let copy = #"{"nodes":[{"id":"b","type":"text","text":"world\n\n世界"}],"edges":[]}"#
        try main.write(to: wordsDir.appendingPathComponent("words.canvas"), atomically: true, encoding: .utf8)
        try copy.write(to: wordsDir.appendingPathComponent("words 2.canvas"), atomically: true, encoding: .utf8)

        let schema = Schema([Entry.self])
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [config])
        let store = DataStore(context: container.mainContext)
        let sync = SyncService(store: store) { _ in }
        sync.configure(folder: dir)
        await sync.scan()

        XCTAssertEqual(sync.conflicts.count, 1)
        XCTAssertEqual(Set(sync.conflicts.first?.changedWords ?? []), Set(["hello", "world"]))

        guard let conflict = sync.conflicts.first else { return XCTFail("未检测到冲突") }
        sync.resolve(conflict, keepCopy: true)

        var resolved = false
        for _ in 0..<20 {
            if let data = try? Data(contentsOf: wordsDir.appendingPathComponent("words.canvas")),
               String(data: data, encoding: .utf8)?.contains("world") == true {
                resolved = true
                break
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertTrue(resolved, "保留副本后主文件应包含副本内容")
    }

    func testScanRealVaultDataAndPersist() async throws {
        let sourceDir = ProcessInfo.processInfo.environment["NOTE_BAR_SYNC_DIR"]
            ?? "/Users/shengxia/Library/Mobile Documents/com~apple~CloudDocs/NoteBar"
        guard FileManager.default.fileExists(atPath: sourceDir) else {
            throw XCTSkip("同步目录不存在，请先运行 scripts/seed-sync-dir.mjs")
        }

        // 把真实同步目录复制到临时副本再操作，避免测试评分污染用户的真实数据
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("notebar-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        for item in try FileManager.default.contentsOfDirectory(atPath: sourceDir) {
            let src = URL(fileURLWithPath: sourceDir).appendingPathComponent(item)
            let dst = dir.appendingPathComponent(item)
            try FileManager.default.copyItem(at: src, to: dst)
        }

        let schema = Schema([Entry.self])
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [config])
        let store = DataStore(context: container.mainContext)
        let sync = SyncService(store: store) { _ in }
        sync.configure(folder: dir)
        await sync.scan()

        let entries = try container.mainContext.fetch(FetchDescriptor<Entry>())
        XCTAssertGreaterThan(entries.count, 0, "应从真实词库读入单词")
        XCTAssertGreaterThan(entries.filter { $0.mastered == true }.count, 0, "应从 Mastered 分组/颜色4 解析出已掌握")
        XCTAssertGreaterThan(entries.filter { $0.status == "mastered" }.count, 0, "status=mastered 应同步")

        guard let entry = entries.first(where: { $0.s != nil }) ?? entries.first else {
            throw XCTSkip("没有可写回进度的词条")
        }
        XCTAssertFalse(entry.word.isEmpty)

        // 模拟一次评分写回
        var progress = entry.progress
        progress.s = 999
        progress.status = "mastered"
        progress.masteredAt = progress.lastReview
        progress.lastReview = ISO8601DateFormatter().string(from: Date())
        sync.persist(book: entry.book, key: entry.studyKey, progress: progress)

        let base = entry.book.replacingOccurrences(of: "\\.canvas$", with: "", options: .regularExpression)
        let sidecarURL = dir.appendingPathComponent("\(base).nb-sync.json")

        // persist 是后台写入，轮询等待落盘
        var writtenValue: Double?
        var writtenStatus: String?
        for _ in 0..<20 {
            if let data = try? Data(contentsOf: sidecarURL),
               let sidecar = try? JSONDecoder().decode(SidecarFile.self, from: data) {
                writtenValue = sidecar.words[entry.studyKey]?.s
                writtenStatus = sidecar.words[entry.studyKey]?.status
                if writtenValue == 999 { break }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(writtenValue, 999, "评分写回应落到边车文件")
        XCTAssertEqual(writtenStatus, "mastered", "已掌握状态应随评分写回边车")
    }

    /// 用户如果直接把 iCloud 里的 Words 目录当同步目录，也要能正确读写，
    /// 不能把文件写到 Words/Words 里。
    func testPickingWordsDirectoryDirectly() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("nb-words-root-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // 模拟用户选中了 Words 目录：canvas 与边车直接在这一层
        let canvas = #"{"nodes":[{"id":"n1","type":"text","text":"hello\n\n你好"}],"edges":[]}"#
        try canvas.write(to: dir.appendingPathComponent("words.canvas"), atomically: true, encoding: .utf8)
        let sidecar = SidecarFile(version: 1, book: "Words/words.canvas", words: [:], updatedAt: "2026-08-01T00:00:00Z")
        try JSONEncoder().encode(sidecar).write(to: dir.appendingPathComponent("words.nb-sync.json"))

        let schema = Schema([Entry.self])
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [config])
        let store = DataStore(context: container.mainContext)
        let sync = SyncService(store: store) { _ in }
        sync.configure(folder: dir)
        await sync.scan()

        let entries = try container.mainContext.fetch(FetchDescriptor<Entry>())
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries.first?.book, "Words/words.canvas")

        var progress = StudyProgress()
        progress.s = 42
        progress.status = "mastered"
        progress.lastReview = ISO8601DateFormatter().string(from: Date())
        sync.persist(book: "Words/words.canvas", key: "Words/words.canvas:n1", progress: progress)

        // 必须写回用户所选目录本身，而不是嵌套的 Words/Words
        var written: Double?
        for _ in 0..<20 {
            if let data = try? Data(contentsOf: dir.appendingPathComponent("words.nb-sync.json")),
               let decoded = try? JSONDecoder().decode(SidecarFile.self, from: data) {
                written = decoded.words["Words/words.canvas:n1"]?.s
                if written == 42 { break }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(written, 42)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("Words").path))
    }

    /// 同步目录里的词库被移除后，App 应清掉本地残留的重复词库，避免一直显示旧词库
    func testStaleBooksAreRemovedOnScan() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("nb-stale-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let wordsDir = dir.appendingPathComponent("Words", isDirectory: true)
        try FileManager.default.createDirectory(at: wordsDir, withIntermediateDirectories: true)
        let a = #"{"nodes":[{"id":"a","type":"text","text":"apple\n\n苹果"}],"edges":[]}"#
        let b = #"{"nodes":[{"id":"b","type":"text","text":"book\n\n书"}],"edges":[]}"#
        try a.write(to: wordsDir.appendingPathComponent("a.canvas"), atomically: true, encoding: .utf8)
        try b.write(to: wordsDir.appendingPathComponent("b.canvas"), atomically: true, encoding: .utf8)

        let schema = Schema([Entry.self])
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [config])
        let store = DataStore(context: container.mainContext)
        let sync = SyncService(store: store) { _ in }
        sync.configure(folder: dir)
        await sync.scan()

        var entries = try container.mainContext.fetch(FetchDescriptor<Entry>())
        XCTAssertEqual(Set(entries.map(\.book)), Set(["Words/a.canvas", "Words/b.canvas"]))

        try FileManager.default.removeItem(at: wordsDir.appendingPathComponent("b.canvas"))
        await sync.scan()

        entries = try container.mainContext.fetch(FetchDescriptor<Entry>())
        XCTAssertEqual(Set(entries.map(\.book)), Set(["Words/a.canvas"]))
    }
}
