import XCTest
@testable import NoteBarHelper

final class SmokeTests: XCTestCase {
    func testHelperVersionIsNotEmpty() {
        XCTAssertFalse(helperVersion().isEmpty)
    }
}
