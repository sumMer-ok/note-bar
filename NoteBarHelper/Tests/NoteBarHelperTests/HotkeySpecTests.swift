import XCTest
import AppKit
@testable import NoteBarHelper

final class HotkeySpecTests: XCTestCase {
    func testSpecFromEventIsCanonicalAndLowercase() {
        XCTAssertEqual(HotkeySpec.spec(character: "D", modifiers: [.option, .shift]), "alt+shift+d")
        XCTAssertEqual(HotkeySpec.spec(character: "d", modifiers: [.command, .shift]), "cmd+shift+d")
        XCTAssertEqual(HotkeySpec.spec(character: "1", modifiers: [.control]), "ctrl+1")
        XCTAssertEqual(HotkeySpec.spec(character: "\\", modifiers: [.command, .option]), "cmd+alt+\\")
    }

    func testSpecRejectsMissingModifierOrUnsupportedKey() {
        XCTAssertNil(HotkeySpec.spec(character: "d", modifiers: []), "没有修饰键的组合不能当全局热键")
        XCTAssertNil(HotkeySpec.spec(character: nil, modifiers: [.option]), "只按修饰键不算一次录制")
        XCTAssertNil(HotkeySpec.spec(character: "å", modifiers: [.option]), "option+字母会变成别的字符，不在支持表里")
        XCTAssertNil(HotkeySpec.spec(character: "ä", modifiers: [.shift]))
    }

    func testRecordedSpecIsAlwaysAcceptedByGlobalHotkeyParse() {
        // 录制出来的 spec 必须能被真正注册热键的解析器接受，否则设置窗口会「看起来保存成功但热键不生效」
        let combos: [(Character, NSEvent.ModifierFlags)] = [
            ("d", [.option, .shift]), ("1", [.command]), ("9", [.command, .shift]),
            ("/", [.control, .option]), ("-", [.command]), ("z", [.shift, .command]),
        ]
        for (character, modifiers) in combos {
            guard let spec = HotkeySpec.spec(character: character, modifiers: modifiers) else {
                return XCTFail("\(character) + \(modifiers) 应能录制")
            }
            XCTAssertNotNil(GlobalHotkey.parse(spec), "录制的 \(spec) 无法被 GlobalHotkey.parse 接受")
        }
    }

    func testDisplayUsesMacSymbols() {
        XCTAssertEqual(HotkeySpec.display("alt+shift+d"), "⌥⇧D")
        XCTAssertEqual(HotkeySpec.display("cmd+shift+d"), "⇧⌘D")
        XCTAssertEqual(HotkeySpec.display("ctrl+alt+1"), "⌃⌥1")
        XCTAssertEqual(HotkeySpec.display(HelperConfig.fallbackHotkey), "⌥⇧D")
    }

    func testParseAcceptsDigitsAndSymbolsAndRejectsGarbage() {
        if case let parsed? = GlobalHotkey.parse("cmd+shift+1") {
            XCTAssertEqual(parsed.keyCode, UInt32(0x12), "cmd+shift+1 应映射到数字 1 的虚拟键码")
            XCTAssertNotEqual(parsed.modifiers, 0)
        } else {
            XCTFail("cmd+shift+1 应可解析")
        }
        XCTAssertNotNil(GlobalHotkey.parse("alt+shift+-"))
        XCTAssertNotNil(GlobalHotkey.parse("ALT+SHIFT+D"), "大小写应被容忍")
        XCTAssertNil(GlobalHotkey.parse("d"), "无修饰键")
        XCTAssertNil(GlobalHotkey.parse("alt+shift+dd"))
        XCTAssertNil(GlobalHotkey.parse("alt+shift+§"))
        XCTAssertNil(GlobalHotkey.parse("hyper+d"))
        XCTAssertNil(GlobalHotkey.parse(""))
    }
}
