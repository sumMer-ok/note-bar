import XCTest
import SwiftData
@testable import NoteBarApp

/// 用真实 Obsidian 数据验证 App 的同步链路：
/// 读 iCloud 同步目录（Canvas 镜像 + 边车）→ SwiftData → 评分写回边车。
/// 依赖宿主机上已由 scripts/seed-sync-dir.mjs 生成的同步目录；缺失时跳过。
@MainActor
final class SyncIntegrationTests: XCTestCase {
    func testScanRealVaultDataAndPersist() async throws {
        let dir = ProcessInfo.processInfo.environment["NOTE_BAR_SYNC_DIR"]
            ?? "/Users/shengxia/Library/Mobile Documents/com~apple~CloudDocs/NoteBar"
        guard FileManager.default.fileExists(atPath: dir) else {
            throw XCTSkip("同步目录不存在，请先运行 scripts/seed-sync-dir.mjs")
        }

        let schema = Schema([Entry.self])
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [config])
        let store = DataStore(context: container.mainContext)
        let sync = SyncService(store: store) { _ in }
        sync.configure(folder: URL(fileURLWithPath: dir))
        await sync.scan()

        let entries = try container.mainContext.fetch(FetchDescriptor<Entry>())
        XCTAssertGreaterThan(entries.count, 0, "应从真实词库读入单词")

        guard let entry = entries.first(where: { $0.s != nil }) ?? entries.first else {
            throw XCTSkip("没有可写回进度的词条")
        }
        XCTAssertFalse(entry.word.isEmpty)

        // 模拟一次评分写回
        var progress = entry.progress
        progress.s = 999
        progress.lastReview = ISO8601DateFormatter().string(from: Date())
        sync.persist(book: entry.book, key: entry.studyKey, progress: progress)

        let base = entry.book.replacingOccurrences(of: "\\.canvas$", with: "", options: .regularExpression)
        let sidecarURL = URL(fileURLWithPath: dir).appendingPathComponent("\(base).nb-sync.json")
        let data = try Data(contentsOf: sidecarURL)
        let sidecar = try JSONDecoder().decode(SidecarFile.self, from: data)
        XCTAssertEqual(sidecar.words[entry.studyKey]?.s, 999, "评分写回应落到边车文件")
    }
}
