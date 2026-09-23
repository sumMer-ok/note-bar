import XCTest
@testable import NoteBarHelper

final class InboxWriterTests: XCTestCase {
    private func tempDir() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("nb-inbox-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func sampleEntry(word: String = "consideration") -> InboxEntry {
        InboxEntry(
            v: 1,
            id: UUID().uuidString,
            createdAt: "2026-09-23T12:00:00.000Z",
            source: "wps-macos",
            word: word,
            sentence: "For valuable consideration, the parties agree.",
            definition: "n. 对价；考虑",
            aliases: ["considerations"],
            color: "4",
            books: ["law.canvas"],
            origin: InboxEntry.Origin(app: "WPS Office", file: "Class-3-Portable-Heritage.docx")
        )
    }

    func testEncodeLineIsSingleLineJSONWithVersionOne() throws {
        let line = try InboxWriter.encodeLine(sampleEntry())
        XCTAssertFalse(line.contains("\n"), "JSONL 必须是单行")
        let obj = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
        XCTAssertEqual(obj["v"] as? Int, 1)
        XCTAssertEqual(obj["word"] as? String, "consideration")
        XCTAssertEqual(obj["books"] as? [String], ["law.canvas"])
        XCTAssertEqual((obj["origin"] as? [String: Any])?["app"] as? String, "WPS Office")
    }

    func testAppendCreatesFileAndAppendsSecondLine() throws {
        let dir = try tempDir()
        let url1 = try InboxWriter.append(sampleEntry(word: "first"), inboxDir: dir.path)
        let url2 = try InboxWriter.append(sampleEntry(word: "second"), inboxDir: dir.path)
        XCTAssertEqual(url1, url2)
        XCTAssertEqual(url1.lastPathComponent, "note-bar-inbox.jsonl")

        let text = try String(contentsOf: url1, encoding: .utf8)
        let lines = text.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.count, 2)
        XCTAssertTrue(lines[0].contains("first"))
        XCTAssertTrue(lines[1].contains("second"))
        XCTAssertTrue(text.hasSuffix("\n"), "每条记录必须以换行结尾，插件按行读取")
    }

    func testAppendCreatesMissingDirectory() throws {
        let dir = try tempDir().appendingPathComponent("nested/deeper")
        let url = try InboxWriter.append(sampleEntry(), inboxDir: dir.path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }

    /// 产出跨语言契约样本：插件侧测试 tests/sync/inbox-helper-contract.test.ts 会读这个文件
    func testWritesContractFixture() throws {
        let fixtureDir = URL(fileURLWithPath: #filePath)      // .../Tests/NoteBarHelperTests/InboxWriterTests.swift
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures")
        try FileManager.default.createDirectory(at: fixtureDir, withIntermediateDirectories: true)
        let fixture = fixtureDir.appendingPathComponent("inbox-sample.jsonl")
        let lines = [
            try InboxWriter.encodeLine(sampleEntry(word: "consideration")),
            try InboxWriter.encodeLine(sampleEntry(word: "stipulation")),
        ].joined(separator: "\n") + "\n"
        try lines.write(to: fixture, atomically: true, encoding: .utf8)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.path))
    }
}
