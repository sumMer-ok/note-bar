import XCTest
@testable import NoteBarApp

final class DefinitionSectionsTests: XCTestCase {
    func testParseRealSectionHeaders() {
        let raw = """
        1. n. 反冲；强烈抵制
        2. vt. 强烈反对

        --- AI 释义 ---
        1）英/ ˈbæklæʃ /  美/ ˈbæklæʃ /
        2）n.强烈抵制

        --- Black's Law Dictionary --- n. (2024)
        1. a strong negative reaction by a large number of people
        """
        let modules = DefinitionSections.modules(raw)

        XCTAssertTrue(modules.contains { $0.module == .dictionary && $0.content.contains("反冲") })
        XCTAssertTrue(modules.contains { $0.module == .ai && $0.content.contains("英/") })
        XCTAssertTrue(modules.contains { $0.module == .legal && $0.content.contains("strong negative") })
        // 固定顺序：词典 → 法律 → AI → 笔记
        XCTAssertEqual(modules.map(\.module), [.dictionary, .legal, .ai])
    }

    func testUpdateAddsModuleWithCanonicalHeader() {
        let updated = DefinitionSections.update("base def", module: .ai, content: "新的 AI 释义")
        XCTAssertEqual(updated, "base def\n\n--- AI 释义 ---\n新的 AI 释义")
    }

    func testUpdateClearsExistingModule() {
        let raw = "base\n\n--- AI 释义 ---\n旧的\n\n--- 自定义笔记 ---\n笔记"
        let updated = DefinitionSections.update(raw, module: .ai, content: "")
        XCTAssertFalse(updated.contains("旧的"))
        XCTAssertTrue(updated.contains("笔记"))
    }

    func testCustomDisplayOrder() {
        let raw = "1. n. 反冲\n\n--- AI 释义 ---\nAI内容\n\n--- 自定义笔记 ---\n笔记内容"
        let modules = DefinitionSections.modules(raw, order: [.notes, .ai, .dictionary, .legal])
        XCTAssertEqual(modules.map(\.module), [.notes, .ai, .dictionary])
    }

    func testPhoneticExtraction() {
        XCTAssertEqual(
            PhoneticExtractor.phonetic(from: "1）英/ ˈbæklæʃ /  美/ ˈbæklæʃ /"),
            "ˈbæklæʃ"
        )
        XCTAssertEqual(
            PhoneticExtractor.phonetic(from: "美/ ˌserənˈdɪpəti /"),
            "ˌserənˈdɪpəti"
        )
        XCTAssertNil(PhoneticExtractor.phonetic(from: "没有音标的释义"))
    }
}
