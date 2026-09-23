import XCTest
@testable import NoteBarHelper

/// 现场 bug 的回归：用户在助手启动后新增词库，浮窗必须立刻看到新词库；
/// 而读盘失败时必须保留旧快照（不能因为一次读盘失败就打不开浮窗）。
final class VaultRefreshTests: XCTestCase {
    private func config(books: [String], inbox: String? = nil) -> VaultConfig {
        VaultConfig(books: books.map { VocabularyBook(path: $0, name: $0, enabled: true) },
                    defaultBooks: [],
                    inboxDir: inbox,
                    rawDictionaryPath: nil,
                    aiService: nil,
                    aiDefinition: nil)
    }

    /// 用户新增词库（law → law/理想国/托尔斯泰）后，浮窗取到的是新快照
    func testAdoptsFreshSnapshotWithNewBooks() {
        let cached = config(books: ["law.canvas"], inbox: "/tmp/old-inbox")
        let fresh = config(books: ["law.canvas", "理想国.canvas", "托尔斯泰.canvas"], inbox: "/tmp/new-inbox")

        guard case let .adopt(loaded, logLines) = decideVaultRefresh(cached: cached, attempt: .success(fresh)) else {
            return XCTFail("读取成功时应替换快照")
        }
        XCTAssertEqual(loaded.enabledCanvasBooks.map(\.path),
                       ["law.canvas", "理想国.canvas", "托尔斯泰.canvas"])
        XCTAssertEqual(loaded.inboxDir, "/tmp/new-inbox")
        XCTAssertEqual(logLines.count, 1)
        XCTAssertTrue(logLines[0].contains("3 个启用词库"), "日志应写明新数量：\(logLines)")
    }

    func testKeepsCachedSnapshotWhenRefreshFails() {
        let cached = config(books: ["law.canvas", "理想国.canvas"], inbox: "/tmp/inbox")
        let failure = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "data.json 读不到"])

        guard case let .keep(kept, logLines) = decideVaultRefresh(cached: cached, attempt: .failure(failure)) else {
            return XCTFail("读取失败时应保留旧快照")
        }
        XCTAssertEqual(kept?.enabledCanvasBooks.map(\.path), ["law.canvas", "理想国.canvas"],
                       "失败不能清空快照，否则浮窗会打不开")
        XCTAssertTrue(logLines[0].contains("沿用上一次的快照"), "日志要写明原因：\(logLines)")
        XCTAssertTrue(logLines[0].contains("data.json 读不到"), "日志要带上底层错误：\(logLines)")
    }

    func testKeepsNilWhenFirstLoadFails() {
        let failure = NSError(domain: "test", code: 2)
        guard case let .keep(kept, logLines) = decideVaultRefresh(cached: nil, attempt: .failure(failure)) else {
            return XCTFail("首次读取失败时应 keep(nil)")
        }
        XCTAssertNil(kept)
        XCTAssertTrue(logLines[0].contains("没有可用的旧快照"), "首次失败要说明没有旧快照：\(logLines)")
    }

    /// 每次打开浮窗都刷新：同一个旧快照连续喂两次新数据，第二次也要采纳（防止将来加「内容相同就跳过」的优化
    /// 把「词库新增」这一场景排除掉）
    func testRepeatedRefreshesAreAlwaysAdopted() {
        var cached = config(books: ["law.canvas"])
        for expected in [2, 3, 4] {
            let fresh = config(books: Array(repeating: "law.canvas", count: expected))
            guard case let .adopt(loaded, _) = decideVaultRefresh(cached: cached, attempt: .success(fresh)) else {
                return XCTFail("第 \(expected) 次刷新应替换快照")
            }
            cached = loaded
            XCTAssertEqual(cached.enabledCanvasBooks.count, expected)
        }
    }

    /// 走真实读盘路径：目录里没有 data.json 时不应抛到调用方（`Result` 已经捕获成失败）
    func testRealReadFailureIsCapturedNotThrown() {
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("nb-no-vault-\(UUID().uuidString)").path
        let attempt = Result { try loadVaultConfig(vaultPath: missing) }
        if case .success = attempt { return XCTFail("目录不存在时不应读取成功") }

        switch decideVaultRefresh(cached: config(books: ["law.canvas"]), attempt: attempt) {
        case .keep(let kept, _):
            XCTAssertEqual(kept?.enabledCanvasBooks.count, 1, "旧快照必须原样保留")
        case .adopt:
            XCTFail("失败时不应采纳")
        }
    }

    /// 复现现场：启动时 vault 里只有 law，用户随后新增「理想国/托尔斯泰」；
    /// 不重启助手，下一次刷新就必须看到 3 个词库（这就是 presentAssistant 打开浮窗前做的那一次刷新）。
    func testAddingBooksToVaultIsVisibleOnNextRefresh() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("nb-vault-refresh-\(UUID().uuidString)")
        let pluginDir = root.appendingPathComponent(".obsidian/plugins/note-bar")
        try FileManager.default.createDirectory(at: pluginDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let dataURL = pluginDir.appendingPathComponent("data.json")

        func writeBooks(_ books: [String]) throws {
            let entries = books.map { #"{"path":"\#($0)","name":"\#($0)","enabled":true}"# }.joined(separator: ",")
            let json = #"{"vocabularyBooks":[\#(entries)],"crossAppInbox":{"enabled":true,"syncDir":"/tmp/nb-inbox"}}"#
            try json.write(to: dataURL, atomically: true, encoding: .utf8)
        }

        // 助手启动那一刻：只有 law
        try writeBooks(["law.canvas"])
        guard case let .adopt(startup, _) = decideVaultRefresh(cached: nil,
                                                              attempt: Result { try loadVaultConfig(vaultPath: root.path) }) else {
            return XCTFail("启动时应采纳快照")
        }
        XCTAssertEqual(startup.enabledCanvasBooks.map(\.path), ["law.canvas"], "启动快照只有 1 个词库")

        // 用户在助手运行期间新增两个词库（不重启助手）
        try writeBooks(["law.canvas", "理想国.canvas", "托尔斯泰.canvas"])
        guard case let .adopt(refreshed, logLines) = decideVaultRefresh(cached: startup,
                                                                       attempt: Result { try loadVaultConfig(vaultPath: root.path) }) else {
            return XCTFail("再次刷新应采纳新快照")
        }
        XCTAssertEqual(refreshed.enabledCanvasBooks.map(\.path), ["law.canvas", "理想国.canvas", "托尔斯泰.canvas"],
                       "浮窗应立刻列出全部 3 个词库")
        XCTAssertTrue(logLines[0].contains("3 个启用词库"), "日志应记录新的数量：\(logLines)")

        // 且词库文件被删掉时不 panic，只是读失败 → 保留旧快照
        try FileManager.default.removeItem(at: dataURL)
        guard case let .keep(kept, _) = decideVaultRefresh(cached: refreshed,
                                                          attempt: Result { try loadVaultConfig(vaultPath: root.path) }) else {
            return XCTFail("data.json 被删掉时应保留旧快照")
        }
        XCTAssertEqual(kept?.enabledCanvasBooks.count, 3)
    }

    /// `presentAssistant` 不可实例化（要 NSApplication + 真实取词），因此这里守「接线」本身：
    /// 一旦有人删掉浮窗打开前的那次刷新，这个测试会失败，把 bug 挡在提交前。
    func testPresentAssistantRefreshesVaultBeforeReadingSnapshot() throws {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var source: String?
        for _ in 0..<6 {
            let candidate = directory.appendingPathComponent("Sources/NoteBarHelper/AppDelegate.swift")
            if FileManager.default.fileExists(atPath: candidate.path) {
                source = try String(contentsOf: candidate, encoding: .utf8)
                break
            }
            directory = directory.deletingLastPathComponent()
        }
        let text = try XCTUnwrap(source, "找不到 AppDelegate.swift 源码（测试需在 SwiftPM 包内运行）")
        guard let functionStart = text.range(of: "private func presentAssistant("),
              let functionEnd = text.range(of: "\n    private func ", range: functionStart.upperBound..<text.endIndex) else {
            return XCTFail("presentAssistant 的源码结构变了，请同步本测试")
        }
        let body = String(text[functionStart.lowerBound..<functionEnd.lowerBound])
        let refresh = try XCTUnwrap(body.range(of: "reloadVault()"), "presentAssistant 必须刷新 vault 配置")
        let snapshotRead = try XCTUnwrap(body.range(of: "guard let vault else"), "presentAssistant 应读取 vault 快照")
        XCTAssertLessThan(refresh.lowerBound, snapshotRead.lowerBound,
                          "刷新必须发生在读取快照之前，否则浮窗仍然用启动时的旧词库列表")
    }
}
