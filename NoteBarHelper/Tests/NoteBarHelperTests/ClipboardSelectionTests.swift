import AppKit
import XCTest
@testable import NoteBarHelper

private final class FakePasteboard: PasteboardAccess {
    var changeCountValue = 1
    var current: String? = "原剪贴板内容"
    /// 模拟剪贴板里同时存在的非文本类型（如图片）
    var extraType: (type: String, data: Data)?
    var restored: PasteboardPayload?

    func changeCount() -> Int { changeCountValue }
    func string() -> String? { current }

    func snapshot() -> PasteboardPayload {
        var dict: [String: Data] = [:]
        if let current { dict[NSPasteboard.PasteboardType.string.rawValue] = Data(current.utf8) }
        if let extraType { dict[extraType.type] = extraType.data }
        return PasteboardPayload(items: dict.isEmpty ? [] : [dict])
    }

    func restore(_ payload: PasteboardPayload) {
        restored = payload
        current = payload.firstString
    }
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
        XCTAssertEqual(pb.restored?.firstString, "原剪贴板内容", "必须恢复用户原剪贴板")
    }

    func testRestoresNonTextPayloadToo() {
        let pb = FakePasteboard()
        pb.extraType = (type: "public.png", data: Data([0x89, 0x50, 0x4E, 0x47]))
        let keys = FakeKeys()
        keys.onPost = {
            pb.changeCountValue += 1
            pb.current = "consideration"
        }
        let acq = ClipboardSelectionAcquirer(pasteboard: pb, keys: keys, timeout: 0.5)

        XCTAssertEqual(acq.acquire(), "consideration")
        XCTAssertEqual(pb.restored?.items.first?["public.png"], Data([0x89, 0x50, 0x4E, 0x47]),
                       "图片等非文本类型必须一并恢复，不能只写回字符串")
    }

    func testReturnsNilWhenNothingWasSelected() {
        let pb = FakePasteboard()
        let keys = FakeKeys()   // 不发事件：changeCount 不变
        let acq = ClipboardSelectionAcquirer(pasteboard: pb, keys: keys, timeout: 0.2)

        XCTAssertNil(acq.acquire())
        XCTAssertEqual(pb.restored?.firstString, "原剪贴板内容", "即使失败也要恢复剪贴板")
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
