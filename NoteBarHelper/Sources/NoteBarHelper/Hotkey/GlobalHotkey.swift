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
        // 可用的按键表与设置窗口的「录制」共用 HotkeySpec.keyCodes，避免两处漂移
        guard let code = HotkeySpec.keyCodes[char] else { return nil }
        return (UInt32(code), modifiers)
    }
}
