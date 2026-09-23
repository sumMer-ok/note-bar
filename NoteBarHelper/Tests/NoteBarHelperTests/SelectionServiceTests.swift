import XCTest
@testable import NoteBarHelper

private struct StubAcquirer: TextAcquirer {
    let source: SelectionSource
    let value: String?
    let throwsError: Bool

    init(source: SelectionSource, value: String?, throwsError: Bool = false) {
        self.source = source
        self.value = value
        self.throwsError = throwsError
    }

    func acquire() -> String? {
        if throwsError { return nil }
        return value
    }
}

final class SelectionServiceTests: XCTestCase {
    func testPrefersFirstAcquirerWithText() {
        let svc = SelectionService([
            StubAcquirer(source: .accessibility, value: "from-ax"),
            StubAcquirer(source: .clipboard, value: "from-clipboard"),
        ])
        XCTAssertEqual(svc.acquire()?.text, "from-ax")
        XCTAssertEqual(svc.acquire()?.source, .accessibility)
    }

    func testFallsBackWhenFirstReturnsNil() {
        let svc = SelectionService([
            StubAcquirer(source: .accessibility, value: nil),
            StubAcquirer(source: .clipboard, value: "from-clipboard"),
        ])
        XCTAssertEqual(svc.acquire()?.source, .clipboard)
    }

    func testTreatsBlankAsNoResultAndFallsThrough() {
        let svc = SelectionService([
            StubAcquirer(source: .accessibility, value: "   "),
            StubAcquirer(source: .clipboard, value: "fallback"),
        ])
        XCTAssertEqual(svc.acquire()?.text, "fallback")
    }

    func testReturnsNilWhenAllFail() {
        let svc = SelectionService([
            StubAcquirer(source: .accessibility, value: nil, throwsError: true),
            StubAcquirer(source: .clipboard, value: nil),
        ])
        XCTAssertNil(svc.acquire())
    }

    func testNormalizesWhitespaceInResult() {
        let svc = SelectionService([StubAcquirer(source: .clipboard, value: "  sue  ")])
        XCTAssertEqual(svc.acquire()?.text, "sue")
    }
}
