import AppKit

/// 供测试与「关于」菜单使用
public func helperVersion() -> String { "0.1.0" }

let delegate = AppDelegate()
let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // 菜单栏常驻，无 Dock 图标
app.delegate = delegate
app.run()
