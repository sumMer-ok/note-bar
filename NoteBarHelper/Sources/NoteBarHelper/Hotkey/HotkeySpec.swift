import AppKit
import Carbon.HIToolbox

/// 纯逻辑：`GlobalHotkey.parse` 认识的 spec 字符串 ↔ NSEvent 修饰键/字符。
///
/// 单独拆出来是为了能单测：`NSEvent` 和真实键盘事件在测试里造不出来。
public enum HotkeySpec {
    /// 与 macOS 键盘偏好里显示的顺序一致（⌃⌥⇧⌘）
    public static let modifierOrder = ["ctrl", "alt", "shift", "cmd"]

    /// 支持的按键 → Carbon 虚拟键码（`GlobalHotkey.parse` 用同一张表）。
    /// 与 `GlobalHotkey` 同源：`import Carbon.HIToolbox` 后才能拿到 `kVK_ANSI_*` 常量
    public static let keyCodes: [Character: Int] = [
        "a": kVK_ANSI_A, "s": kVK_ANSI_S, "d": kVK_ANSI_D, "f": kVK_ANSI_F,
        "h": kVK_ANSI_H, "g": kVK_ANSI_G, "z": kVK_ANSI_Z, "x": kVK_ANSI_X,
        "c": kVK_ANSI_C, "v": kVK_ANSI_V, "b": kVK_ANSI_B, "q": kVK_ANSI_Q,
        "w": kVK_ANSI_W, "e": kVK_ANSI_E, "r": kVK_ANSI_R, "y": kVK_ANSI_Y,
        "t": kVK_ANSI_T, "o": kVK_ANSI_O, "u": kVK_ANSI_U, "i": kVK_ANSI_I,
        "p": kVK_ANSI_P, "l": kVK_ANSI_L, "j": kVK_ANSI_J, "k": kVK_ANSI_K,
        "n": kVK_ANSI_N, "m": kVK_ANSI_M,
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
        "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
        "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal,
        "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket,
        ";": kVK_ANSI_Semicolon, "'": kVK_ANSI_Quote,
        ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period,
        "/": kVK_ANSI_Slash, "\\": kVK_ANSI_Backslash,
    ]

    /// spec 里使用的修饰键名；modifierFlags 只取设备无关位（真机按 Fn 等不应破坏识别）
    public static func modifierNames(_ flags: NSEvent.ModifierFlags) -> [String] {
        let flags = flags.intersection(.deviceIndependentFlagsMask)
        var names: [String] = []
        if flags.contains(.command) { names.append("cmd") }
        if flags.contains(.option) { names.append("alt") }
        if flags.contains(.control) { names.append("ctrl") }
        if flags.contains(.shift) { names.append("shift") }
        return names
    }

    /// 由录制到的按键拼出 spec；无修饰键、或按键不在支持表里时返回 nil（调用方据此提示用户）
    public static func spec(character: Character?, modifiers: NSEvent.ModifierFlags) -> String? {
        guard let character else { return nil }
        let key = Character(String(character).lowercased())
        guard keyCodes[key] != nil else { return nil }
        let names = modifierNames(modifiers)
        guard !names.isEmpty else { return nil }
        return names.joined(separator: "+") + "+" + String(key)
    }

    /// 展示用：`alt+shift+d` → `⌥⇧D`。
    /// 符号按 Apple 惯例的顺序（⌃⌥⇧⌘）排列，与 spec 自身里的书写顺序无关。
    public static func display(_ spec: String) -> String {
        let parts = spec.lowercased().split(separator: "+").map(String.init)
        guard let key = parts.last else { return spec }
        let flags = Set(parts.dropLast())
        var result = ""
        if flags.contains("ctrl") || flags.contains("control") { result += "⌃" }
        if flags.contains("alt") || flags.contains("option") { result += "⌥" }
        if flags.contains("shift") { result += "⇧" }
        if flags.contains("cmd") || flags.contains("command") { result += "⌘" }
        return result + key.uppercased()
    }
}

/// 在设置窗口里录制组合键：点击「录制」后捕获下一个 keyDown，Esc 取消。
///
/// 用本地事件监听（`addLocalMonitorForEvents`）而不是自定义 NSView：设置窗口是普通窗口，
/// 本地监听足以在任何焦点位置拿到 keyDown，且必须在停止录制/窗口关闭时移除，否则监听会泄漏。
public final class HotkeyRecorder {
    public private(set) var isRecording = false
    private var monitor: Any?

    public init() {}

    public func start(onCapture: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        stop()
        isRecording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard let self, self.isRecording else { return event }

            // Esc 取消录制（并吞掉该事件，避免顺带关掉窗口）
            if event.keyCode == 53 {
                self.stop()
                onCancel()
                return nil
            }
            // 只按下修饰键时继续等真正的按键
            let character = event.charactersIgnoringModifiers?.first
            guard let spec = HotkeySpec.spec(character: character, modifiers: event.modifierFlags) else {
                return nil
            }
            self.stop()
            onCapture(spec)
            return nil
        }
    }

    public func stop() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
        isRecording = false
    }

    deinit { stop() }
}
