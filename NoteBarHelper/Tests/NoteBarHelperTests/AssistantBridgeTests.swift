import XCTest
@testable import NoteBarHelper

final class AssistantBridgeTests: XCTestCase {
    func testReadySignalIsRecognizedAndNothingElseIs() {
        XCTAssertTrue(AssistantMessage.isReadySignal(body: ["action": "ready"]))
        XCTAssertFalse(AssistantMessage.isReadySignal(body: ["action": "submit"]))
        XCTAssertFalse(AssistantMessage.isReadySignal(body: ["action": "cancel"]))
        XCTAssertFalse(AssistantMessage.isReadySignal(body: ["action": "READY"]))
        XCTAssertFalse(AssistantMessage.isReadySignal(body: "garbage"))
        XCTAssertFalse(AssistantMessage.isReadySignal(body: [:]))
    }

    func testSubmitMessageSplitsAndTrimsAliases() {
        let message = AssistantMessage(
            body: ["action": "submit", "aliases": " Considerations , consider ,, ", "books": ["law.canvas"]],
            fallbackWord: "consideration",
            fallbackSentence: "For valuable consideration."
        )
        guard case let .submit(payload)? = message else { return XCTFail("应解析为 submit") }
        XCTAssertEqual(payload.word, "consideration")
        XCTAssertEqual(payload.aliases, ["Considerations", "consider"])
        XCTAssertEqual(payload.sentence, "For valuable consideration.")
        XCTAssertEqual(payload.books, ["law.canvas"])
        XCTAssertNil(payload.color)
    }

    func testEmptyDefinitionAndColorBecomeNilAndSentenceFallsBack() {
        let message = AssistantMessage(
            body: ["action": "submit", "definition": "   ", "color": "", "sentence": ""],
            fallbackWord: "sue",
            fallbackSentence: "The plaintiff sued."
        )
        guard case let .submit(payload)? = message else { return XCTFail("应解析为 submit") }
        XCTAssertNil(payload.definition)
        XCTAssertNil(payload.color)
        XCTAssertEqual(payload.sentence, "The plaintiff sued.", "空例句应回落到选区上下文")
        XCTAssertEqual(payload.books, [], "未选词库时留空，由插件回落到默认词库")
    }

    func testCancelMessageAndGarbageBody() {
        guard case .cancel? = AssistantMessage(body: ["action": "cancel"], fallbackWord: "x", fallbackSentence: nil) else {
            return XCTFail("应解析为 cancel")
        }
        XCTAssertNil(AssistantMessage(body: ["nope": 1], fallbackWord: "x", fallbackSentence: nil))
        XCTAssertNil(AssistantMessage(body: "garbage", fallbackWord: "x", fallbackSentence: nil))
    }
}
