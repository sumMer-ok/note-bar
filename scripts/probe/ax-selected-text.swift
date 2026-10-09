// WPS for Mac 选区可读性探针（P0 / Task 10）
//
// 作用：判断 WPS for Mac 的辅助功能（AX）树里是否存在能给出“选中文本”的元素，
// 从而决定 macOS 划词助手走 AX 直读、JSA 宏上报，还是 ⌘C 兜底。
//
// 用法：
//   axprobe scan [pid]    # 一次性：列窗口标题 + 深度扫描 + 判定（无选区也能跑）
//   axprobe watch [pid]   # 等待选区（默认）：持续轮询并打印心跳，抓到选区立即打印详情
//
// 需要给运行它的进程授予“隐私与安全性 → 辅助功能”权限，否则 AX 调用返回 -25211。

import AppKit
import ApplicationServices

let POLL_DEADLINE_SECONDS = 600.0
let POLL_INTERVAL_SECONDS = 0.6
let SCAN_MAX_DEPTH = 9
let SCAN_MAX_NODES = 1500

func copyAttr(_ el: AXUIElement, _ name: String) -> (CFTypeRef?, AXError) {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, name as CFString, &value)
    return (value, err)
}

func desc(_ v: CFTypeRef?) -> String {
    guard let v = v else { return "nil" }
    if let s = v as? String {
        let flat = s.replacingOccurrences(of: "\n", with: "⏎")
        return flat.count > 80 ? "\"\(flat.prefix(80))…\"(len \(flat.count))" : "\"\(flat)\""
    }
    if let n = v as? NSNumber { return "\(n)" }
    if CFGetTypeID(v) == AXValueGetTypeID() {
        let axv = unsafeBitCast(v, to: AXValue.self)
        if AXValueGetType(axv) == .cfRange {
            var r = CFRange()
            if AXValueGetValue(axv, .cfRange, &r) { return "range(loc=\(r.location), len=\(r.length))" }
        }
        return "AXValue(非 CFRange)"
    }
    return "<\(type(of: v))>"
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    let (v, err) = copyAttr(el, kAXChildrenAttribute)
    guard err == .success, let arr = v as? [AXUIElement] else { return [] }
    return arr
}

func attributeNames(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyAttributeNames(el, &names) == .success,
          let list = names as? [String] else { return [] }
    return list
}

func asElement(_ raw: CFTypeRef?) -> AXUIElement? {
    guard let raw = raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(raw, to: AXUIElement.self)
}

func focusedElement(_ appEl: AXUIElement) -> AXUIElement? {
    asElement(copyAttr(appEl, kAXFocusedUIElementAttribute).0)
}

/// 系统级焦点元素：某些应用只在系统级暴露当前焦点
func systemWideFocused() -> AXUIElement? {
    asElement(copyAttr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute).0)
}

func selectionRangeLength(_ el: AXUIElement) -> Int? {
    let (v, err) = copyAttr(el, kAXSelectedTextRangeAttribute)
    guard err == .success, let raw = v, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let axv = unsafeBitCast(raw, to: AXValue.self)
    guard AXValueGetType(axv) == .cfRange else { return nil }
    var r = CFRange()
    guard AXValueGetValue(axv, .cfRange, &r) else { return nil }
    return r.length
}

func selectedText(_ el: AXUIElement) -> String? {
    let (v, err) = copyAttr(el, kAXSelectedTextAttribute)
    guard err == .success, let s = v as? String else { return nil }
    return s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : s
}

func findWPS() -> (pid_t, String)? {
    for arg in CommandLine.arguments.dropFirst() where Int32(arg) != nil {
        return (pid_t(arg)!, "pid \(arg)（命令行指定）")
    }
    for app in NSWorkspace.shared.runningApplications {
        let bundle = app.bundleIdentifier ?? ""
        let name = app.localizedName ?? ""
        if bundle.hasPrefix("com.kingsoft") || name.contains("WPS") {
            return (app.processIdentifier, "\(name) [\(bundle)]")
        }
    }
    return nil
}

struct Hit {
    let element: AXUIElement
    let text: String?
    let rangeLength: Int?
    let via: String
    let depth: Int
}

func describe(_ hit: Hit) {
    let el = hit.element
    print("  来源        : \(hit.via)（depth=\(hit.depth)）")
    print("  Role/Subrole: \(desc(copyAttr(el, kAXRoleAttribute).0)) / \(desc(copyAttr(el, kAXSubroleAttribute).0))")
    print("  选中文本    : \(hit.text.map { desc($0 as CFString) } ?? "（空）")")
    print("  选区长度    : \(hit.rangeLength.map(String.init) ?? "无该属性")")
    print("  AXValue     : \(desc(copyAttr(el, kAXValueAttribute).0))")
    print("  属性数      : \(attributeNames(el).count)")
}

/// 找选区：优先返回带非空 AXSelectedText 的元素；否则报出“选区长度>0 但无文本”的元素
func findSelection(_ appEl: AXUIElement, deep: Bool) -> (best: Hit?, rangeOnly: Hit?) {
    var direct: [(AXUIElement, Int, String)] = []
    let focused = focusedElement(appEl)
    if let f = focused { direct.append((f, 0, "焦点元素")) }
    if let s = systemWideFocused(), let f = focused, !CFEqual(s, f) {
        direct.append((s, 0, "系统级焦点元素"))
    }
    for (el, depth, via) in direct {
        if let text = selectedText(el) {
            return (Hit(element: el, text: text, rangeLength: selectionRangeLength(el), via: via, depth: depth), nil)
        }
    }

    let maxDepth = deep ? SCAN_MAX_DEPTH : 5
    let maxNodes = deep ? SCAN_MAX_NODES : 400
    var queue: [(AXUIElement, Int)] = [(appEl, 0)]
    var visited = 0
    var rangeOnly: Hit? = nil

    while !queue.isEmpty && visited < maxNodes {
        let (el, depth) = queue.removeFirst()
        visited += 1
        if depth > 0 {
            if let text = selectedText(el) {
                return (Hit(element: el, text: text, rangeLength: selectionRangeLength(el), via: "树扫描", depth: depth), nil)
            }
            if rangeOnly == nil, let len = selectionRangeLength(el), len > 0 {
                rangeOnly = Hit(element: el, text: nil, rangeLength: len, via: "树扫描", depth: depth)
            }
        }
        if depth < maxDepth { for child in children(el) { queue.append((child, depth + 1)) } }
    }
    return (nil, rangeOnly)
}

func dumpWindows(_ appEl: AXUIElement) {
    print("\n—— WPS 窗口 ——")
    let (v, err) = copyAttr(appEl, kAXWindowsAttribute)
    guard err == .success, let wins = v as? [AXUIElement] else {
        print("  取窗口失败 AXError \(err.rawValue)")
        return
    }
    if wins.isEmpty { print("  没有任何窗口（WPS 可能没打开文档）") }
    for (i, w) in wins.prefix(8).enumerated() {
        print("  [\(i)] title=\(desc(copyAttr(w, kAXTitleAttribute).0)) role=\(desc(copyAttr(w, kAXRoleAttribute).0)) subrole=\(desc(copyAttr(w, kAXSubroleAttribute).0))")
    }
}

func scanMode(_ appEl: AXUIElement) {
    dumpWindows(appEl)

    print("\n—— 全树深度扫描（深度 \(SCAN_MAX_DEPTH)，节点上限 \(SCAN_MAX_NODES)）——")
    if let f = focusedElement(appEl) {
        print("焦点元素: role=\(desc(copyAttr(f, kAXRoleAttribute).0)) 选区长度=\(selectionRangeLength(f).map(String.init) ?? "无该属性") AXSelectedText=\(desc(copyAttr(f, kAXSelectedTextAttribute).0))")
    }

    var queue: [(AXUIElement, Int)] = [(appEl, 0)]
    var visited = 0
    var withAttr: [String] = []
    var selRanges: [String] = []

    while !queue.isEmpty && visited < SCAN_MAX_NODES {
        let (el, depth) = queue.removeFirst()
        visited += 1
        if attributeNames(el).contains(kAXSelectedTextAttribute as String), withAttr.count < 10 {
            withAttr.append("depth=\(depth) role=\(desc(copyAttr(el, kAXRoleAttribute).0)) AXSelectedText=\(desc(copyAttr(el, kAXSelectedTextAttribute).0))")
        }
        if let len = selectionRangeLength(el), len > 0, selRanges.count < 10 {
            selRanges.append("depth=\(depth) role=\(desc(copyAttr(el, kAXRoleAttribute).0)) 选区长度=\(len) AXSelectedText=\(desc(copyAttr(el, kAXSelectedTextAttribute).0))")
        }
        if depth < SCAN_MAX_DEPTH { for child in children(el) { queue.append((child, depth + 1)) } }
    }

    print("扫描节点数: \(visited)")
    print("\n[关键] 选区落点（AXSelectedTextRange.length > 0）: \(selRanges.isEmpty ? "无" : "")")
    selRanges.forEach { print("  \($0)") }
    print("\n暴露 AXSelectedText 属性的元素: \(withAttr.isEmpty ? "无" : "")")
    withAttr.forEach { print("  \($0)") }

    if !selRanges.isEmpty {
        print("\n结论: 存在选区落点 → AX 直读可行（还要看取值是否有内容）")
    } else if withAttr.isEmpty {
        print("\n结论: 无元素暴露 AXSelectedText → AX 直读不可行")
    } else {
        print("\n结论: 属性存在但无人报告非空选区 → 当前无选区，或编辑区不暴露选区")
    }
}

func watchMode(_ appEl: AXUIElement) {
    dumpWindows(appEl)
    print("\n请在 \(Int(POLL_DEADLINE_SECONDS)) 秒内：切到 WPS → 打开含英文的文档 → 选中一个英文单词并保持选中")
    print("程序每 5 秒打印一次心跳（含当前焦点元素与选区长度），抓到选区立即打印详情。\n")
    fflush(stdout)

    let deadline = Date().addingTimeInterval(POLL_DEADLINE_SECONDS)
    var ticks = 0
    var best: Hit? = nil
    var rangeOnly: Hit? = nil

    while Date() < deadline {
        let (b, r) = findSelection(appEl, deep: true)
        if let b = b { best = b; break }
        if let r = r { rangeOnly = r }
        ticks += 1
        if ticks % 8 == 0 {
            let f = focusedElement(appEl)
            let len = f.flatMap { selectionRangeLength($0) }.map(String.init) ?? "-"
            let role = f.map { desc(copyAttr($0, kAXRoleAttribute).0) } ?? "无"
            print("  心跳 #\(ticks)：焦点 role=\(role) 选区长度=\(len)\(rangeOnly != nil ? "（已见选区长度>0 但 AXSelectedText 为空）" : "")")
            fflush(stdout)
        }
        Thread.sleep(forTimeInterval: POLL_INTERVAL_SECONDS)
    }

    guard let hit = best else {
        print("\n结果: \(Int(POLL_DEADLINE_SECONDS)) 秒内未读到任何非空选中文本。")
        if let r = rangeOnly {
            print("注意: 期间确实观察到“选区长度>0”的元素，但不提供 AXSelectedText → 选区可见、文本不可读")
            describe(r)
        } else {
            print("期间连“选区长度>0”都没观察到：WPS 的 AX 树没有把文档选区报告出来。")
        }
        print("\n判定: AX 直读不可行 → Plan B 走 JSA 宏上报或 ⌘C 兜底。")
        exit(0)
    }

    print("\n✔ 抓到非空选中文本（AX 直读可行）：")
    describe(hit)

    print("\n请在 6 秒内改变选区（选另一个词或一段）…")
    fflush(stdout)
    Thread.sleep(forTimeInterval: 6)
    let (second, _) = findSelection(appEl, deep: true)
    if let s = second, let t = s.text {
        print("第二次采样: \(desc(t as CFString))")
        print(s.text != hit.text ? "判定: 选区变化会更新 → 可做『选中即弹』" : "判定: 两次相同（可能未改变选区）")
    } else {
        print("第二次采样: 读不到 → AX 直读依赖前台激活，触发方式应用全局热键")
    }
}

// —— 主流程 ——
let modeArgs = CommandLine.arguments.dropFirst().filter { Int32($0) == nil }
let mode = modeArgs.first ?? "watch"

print("辅助功能授权（本进程）: \(AXIsProcessTrusted() ? "已授权" : "未授权 → 需在 系统设置 → 隐私与安全性 → 辅助功能 中授权运行此程序的 App")")

guard let (pid, label) = findWPS() else {
    print("未找到 WPS 进程。请先启动 WPS Office for Mac 再运行本探针。")
    exit(3)
}
print("目标进程: \(label) pid=\(pid)")

let appEl = AXUIElementCreateApplication(pid)
let (_, roleErr) = copyAttr(appEl, kAXRoleAttribute)
print("连接 AX 结果: AXError \(roleErr.rawValue)\(roleErr == .success ? "（正常）" : "（-25211=未授权，-25204=进程不可达）")")

switch mode {
case "scan": scanMode(appEl)
default: watchMode(appEl)
}
