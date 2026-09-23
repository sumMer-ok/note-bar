import AppKit
import Carbon.HIToolbox

/// 基于 Carbon RegisterEventHotKey 的全局热键：不需要辅助功能授权即可注册；
/// spec 形如 "alt+shift+d"（modifier 支持 cmd/alt/ctrl/shift，末段为单字符）
public final class GlobalHotkey {
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private let handler: () -> Void
    // 注册与回调都发生在主 run loop（Carbon 事件目标 = 主线程），无跨线程访问；
    // Swift 6 语言模式下需要显式声明 nonisolated(unsafe) 才能保留静态注册表。
    nonisolated(unsafe) private static var registry: [UInt32: GlobalHotkey] = [:]
    nonisolated(unsafe) private static var nextId: UInt32 = 1
    private let id: UInt32

    public init?(spec: String, handler: @escaping () -> Void) {
        guard let parsed = GlobalHotkey.parse(spec) else { return nil }
        self.handler = handler
        self.id = GlobalHotkey.nextId
        GlobalHotkey.nextId += 1

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData -> OSStatus in
            guard let userData, let event else { return OSStatus(eventNotHandledErr) }
            var hotKeyId = EventHotKeyID()
            let err = GetEventParameter(event, EventParamName(kEventParamDirectObject),
                                        EventParamType(typeEventHotKeyID), nil,
                                        MemoryLayout<EventHotKeyID>.size, nil, &hotKeyId)
            guard err == noErr else { return OSStatus(eventNotHandledErr) }
            let instance = Unmanaged<GlobalHotkey>.fromOpaque(userData).takeUnretainedValue()
            if hotKeyId.id == instance.id {
                instance.handler()
                return noErr
            }
            return OSStatus(eventNotHandledErr)
        }, 1, &eventType, selfPtr, &eventHandler)

        let hotKeyId = EventHotKeyID(signature: OSType(0x4E42482B) /* 'NBH+' */, id: id)
        let status = RegisterEventHotKey(parsed.keyCode, parsed.modifiers, hotKeyId,
                                         GetApplicationEventTarget(), 0, &hotKeyRef)
        guard status == noErr else { return nil }
        GlobalHotkey.registry[id] = self
    }

    public func unregister() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        hotKeyRef = nil
        if let eventHandler { RemoveEventHandler(eventHandler) }
        eventHandler = nil
        GlobalHotkey.registry[id] = nil
    }

    public static func parse(_ spec: String) -> (keyCode: UInt32, modifiers: UInt32)? {
        let parts = spec.lowercased().split(separator: "+").map(String.init)
        guard let keyPart = parts.last, keyPart.count == 1, let char = keyPart.first else { return nil }
        var modifiers: UInt32 = 0
        for part in parts.dropLast() {
            switch part {
            case "cmd", "command": modifiers |= UInt32(cmdKey)
            case "alt", "option": modifiers |= UInt32(optionKey)
            case "ctrl", "control": modifiers |= UInt32(controlKey)
            case "shift": modifiers |= UInt32(shiftKey)
            default: return nil
            }
        }
        guard modifiers != 0 else { return nil }
        let map: [Character: Int] = ["a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D,
                                     "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H,
                                     "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
                                     "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P,
                                     "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
                                     "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
                                     "y": kVK_ANSI_Y, "z": kVK_ANSI_Z]
        guard let code = map[char] else { return nil }
        return (UInt32(code), modifiers)
    }
}
