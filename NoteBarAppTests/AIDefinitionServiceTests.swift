import XCTest
@testable import NoteBarApp

final class AIDefinitionServiceTests: XCTestCase {
    func testPromptResourceMatchesPlugin() {
        let prompt = AIDefinitionService.loadPrompt()
        XCTAssertTrue(prompt.contains("{{word}}"))
        XCTAssertTrue(prompt.contains("{{sentence}}"))
        XCTAssertTrue(prompt.contains("英汉词典编纂助手"))
        XCTAssertTrue(prompt.contains("aliases"))
    }

    func testLegalCorrectionPromptHasSentencePlaceholder() {
        let prompt = AIDefinitionService.legalCorrectionPrompt
        XCTAssertTrue(prompt.contains("{{sentence}}"))
        XCTAssertTrue(prompt.contains("OCR"))
        XCTAssertTrue(prompt.contains("Black's Law Dictionary"))
    }

    func testParseStrictJSON() {
        let result = AIDefinitionService.parse(#"{"aliases":["sue","sued"],"definition":"1）英/ suː / 美/ suː /\n2）v. 起诉"}"#)
        XCTAssertEqual(result.aliases, ["sue", "sued"])
        XCTAssertTrue(result.definition.contains("起诉"))
    }

    func testParseCodeFence() {
        let result = AIDefinitionService.parse("```json\n{\"aliases\":[],\"definition\":\"释义\"}\n```")
        XCTAssertEqual(result.definition, "释义")
    }

    func testParseRepairsTrailingComma() {
        let result = AIDefinitionService.parse(#"{"aliases": ["go",], "definition": "去，"}"#)
        XCTAssertEqual(result.aliases, ["go"])
    }

    func testParseFallsBackToPlainText() {
        let result = AIDefinitionService.parse("这是一段纯文本释义")
        XCTAssertEqual(result.definition, "这是一段纯文本释义")
        XCTAssertTrue(result.aliases.isEmpty)
    }

    func testEmptyContentIsRejected() {
        XCTAssertThrowsError(try AIDefinitionService.parseContent("", finishReason: "length")) { error in
            XCTAssertEqual(error as? AIDefinitionError, .truncated)
        }
        XCTAssertThrowsError(try AIDefinitionService.parseContent("   \n ", finishReason: "stop")) { error in
            XCTAssertEqual(error as? AIDefinitionError, .invalidResponse)
        }
        XCTAssertEqual(try AIDefinitionService.parseContent("释义", finishReason: "stop").definition, "释义")
    }
}
