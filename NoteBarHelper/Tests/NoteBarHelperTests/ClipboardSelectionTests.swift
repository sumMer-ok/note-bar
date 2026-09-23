import XCTest
@testable import NoteBarHelper

private final class FakePasteboard: PasteboardAccess {
    var changeCountValue = 1
    var current: String? = "原剪贴板内容"
    var restored: [String]?
    var onChangeCount: (() -> Void)?

    func changeCount() -> Int { changeCountValue }
    func string() -> String? { current }
    func snapshot() -> [String] { current.map { [$0] } ?? [] }
    func restore(_ items: [String]) { restored = items; current = items.first }
}

private final class FakeKeys: KeyEventPosting {
    var postCount = 0
    var onPost: (() -> Void)?
    func postCommandC() { postCount += 1; onPost?() }
}

final class ClipboardSelectionTests: XCTestCase {
    func testReturnsNewlyCopiedTextAndRestoresOriginal() {
        let pb = FakePasteboard()
        let keys = FakeKeys()
        keys.onPost = {
            // 模拟 WPS 响应 ⌘C
            pb.changeCountValue += 1
            pb.current = "consideration"
        }
        let acq = ClipboardSelectionAcquirer(pasteboard: pb, keys: keys, timeout: 0.5)

        XCTAssertEqual(acq.acquire(), "consideration")
        XCTAssertEqual(keys.postCount, 1)
        XCTAssertEqual(pb.restored, ["原剪贴板内容"], "必须恢复用户原剪贴板")
    }

    func testReturnsNilWhenNothingWasSelected() {
        let pb = FakePasteboard()
        let keys = FakeKeys()   // 不发事件：changeCount 不变
        let acq = ClipboardSelectionAcquirer(pasteboard: pb, keys: keys, timeout: 0.2)

        XCTAssertNil(acq.acquire())
        XCTAssertEqual(pb.restored, ["原剪贴板内容"], "即使失败也要恢复剪贴板")
    }

    func testBlankCopyIsTreatedAsFailure() {
        let pb = FakePasteboard()
        let keys = FakeKeys()
        keys.onPost = {
            pb.changeCountValue += 1
            pb.current = "   \n  "
        }
        let acq = ClipboardSelectionAcquirer(pasteboard: pb, keys: keys, timeout: 0.5)
        XCTAssertNil(acq.acquire())
    }

    func testTrimsSurroundingWhitespaceButKeepsInner() {
        let pb = FakePasteboard()
        let keys = FakeKeys()
        keys.onPost = {
            pb.changeCountValue += 1
            pb.current = "  due process of law  "
        }
        let acq = ClipboardSelectionAcquirer(pasteboard: pb, keys: keys, timeout: 0.5)
        XCTAssertEqual(acq.acquire(), "due process of law")
    }
}
