import AppKit
import CoreGraphics

public protocol PasteboardAccess {
    func changeCount() -> Int
    func string() -> String?
    func snapshot() -> [String]
    func restore(_ items: [String])
}

public protocol KeyEventPosting {
    func postCommandC()
}

/// 通用兜底取词：合成 ⌘C → 等剪贴板变化 → 读文本 → 恢复原剪贴板。
/// 注意：合成键盘事件需要「辅助功能」授权，未授权时事件会被系统丢弃（表现为超时返回 nil）。
public final class ClipboardSelectionAcquirer {
    private let pasteboard: PasteboardAccess
    private let keys: KeyEventPosting
    private let timeout: TimeInterval

    public init(pasteboard: PasteboardAccess, keys: KeyEventPosting, timeout: TimeInterval = 0.6) {
        self.pasteboard = pasteboard
        self.keys = keys
        self.timeout = timeout
    }

    public func acquire() -> String? {
        let before = pasteboard.changeCount()
        let snapshot = pasteboard.snapshot()

        keys.postCommandC()
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if pasteboard.changeCount() != before { break }
            usleep(15_000)
        }
        defer { pasteboard.restore(snapshot) }

        guard pasteboard.changeCount() != before, let raw = pasteboard.string() else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

public final class SystemPasteboard: PasteboardAccess {
    public init() {}

    public func changeCount() -> Int { NSPasteboard.general.changeCount }
    public func string() -> String? { NSPasteboard.general.string(forType: .string) }
    public func snapshot() -> [String] { NSPasteboard.general.string(forType: .string).map { [$0] } ?? [] }

    public func restore(_ items: [String]) {
        let pb = NSPasteboard.general
        pb.clearContents()
        if let first = items.first { pb.setString(first, forType: .string) }
    }
}

public final class SystemKeyEventPoster: KeyEventPosting {
    public init() {}

    /// keyCode 8 = kVK_ANSI_C；flags 带 Command
    public func postCommandC() {
        let source = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: 8, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 8, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }
}
