import AppKit
import CoreGraphics

/// 剪贴板快照：按 item 保存「类型 → 原始数据」。
/// 只保存字符串是不够的——恢复前会 clearContents，那样会把用户剪贴板里的图片/文件/富文本一并清掉。
public struct PasteboardPayload: Equatable {
    public let items: [[String: Data]]

    public init(items: [[String: Data]]) { self.items = items }

    public static let empty = PasteboardPayload(items: [])
    public var isEmpty: Bool { items.isEmpty }

    /// 第一项的纯文本（测试与调试用）
    public var firstString: String? {
        guard let first = items.first else { return nil }
        for type in [NSPasteboard.PasteboardType.string.rawValue, "public.utf8-plain-text"] {
            if let data = first[type] { return String(data: data, encoding: .utf8) }
        }
        return nil
    }
}

public protocol PasteboardAccess {
    func changeCount() -> Int
    func string() -> String?
    func snapshot() -> PasteboardPayload
    func restore(_ payload: PasteboardPayload)
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
    /// 完整快照：所有 item 的所有类型都按原始数据保存
    public func snapshot() -> PasteboardPayload {
        let items = (NSPasteboard.general.pasteboardItems ?? []).map { item -> [String: Data] in
            var dict: [String: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { dict[type.rawValue] = data }
            }
            return dict
        }
        return PasteboardPayload(items: items)
    }

    /// 原样写回（含图片/文件/富文本），而不是只写回一个字符串
    public func restore(_ payload: PasteboardPayload) {
        let pb = NSPasteboard.general
        pb.clearContents()
        guard !payload.isEmpty else { return }
        let restored = payload.items.map { dict -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (rawType, data) in dict {
                item.setData(data, forType: NSPasteboard.PasteboardType(rawType))
            }
            return item
        }
        _ = pb.writeObjects(restored)
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
