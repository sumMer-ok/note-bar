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

        let main = #"{"nodes":[{"id":"a","type":"text","text":"hello\n\n你好"}],"edges":[]}"#
        let copy = #"{"nodes":[{"id":"b","type":"text","text":"world\n\n世界"}],"edges":[]}"#
        try main.write(to: dir.appendingPathComponent("words.canvas"), atomically: true, encoding: .utf8)
        try copy.write(to: dir.appendingPathComponent("words 2.canvas"), atomically: true, encoding: .utf8)

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
            if let data = try? Data(contentsOf: dir.appendingPathComponent("words.canvas")),
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
}
