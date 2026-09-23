import AppKit
import ApplicationServices

/// 第一级：直接读辅助功能树里的 AXSelectedText。
/// 实测 WPS for Mac 的文档编辑区疑似 CEF 渲染、可能不暴露该属性，
/// 因此这一级必须有第二级兜底，且失败时必须安静返回 nil。
public final class AXSelectionAcquirer: TextAcquirer {
    public let source: SelectionSource = .accessibility
    private let maxDepth: Int
    private let maxNodes: Int

    public init(maxDepth: Int = 9, maxNodes: Int = 1200) {
        self.maxDepth = maxDepth
        self.maxNodes = maxNodes
    }

    public func acquire() -> String? {
        guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
        let appEl = AXUIElementCreateApplication(front.processIdentifier)

        if let el = focusedElement(appEl), let text = selectedText(el) { return text }
        if let el = systemWideFocused(), let text = selectedText(el) { return text }

        // 广度优先浅扫，兜住「焦点元素没暴露、但树里某个文本区暴露」的情况
        var queue: [(AXUIElement, Int)] = [(appEl, 0)]
        var visited = 0
        while !queue.isEmpty && visited < maxNodes {
            let (el, depth) = queue.removeFirst()
            visited += 1
            if depth > 0, let text = selectedText(el) { return text }
            if depth < maxDepth { for child in children(el) { queue.append((child, depth + 1)) } }
        }
        return nil
    }

    // MARK: - AX 小工具

    private func copyAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }
        return value
    }

    private func asElement(_ raw: CFTypeRef?) -> AXUIElement? {
        guard let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(raw, to: AXUIElement.self)
    }

    private func focusedElement(_ appEl: AXUIElement) -> AXUIElement? {
        asElement(copyAttr(appEl, kAXFocusedUIElementAttribute))
    }

    private func systemWideFocused() -> AXUIElement? {
        asElement(copyAttr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute))
    }

    private func children(_ el: AXUIElement) -> [AXUIElement] {
        (copyAttr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    private func selectedText(_ el: AXUIElement) -> String? {
        guard let raw = copyAttr(el, kAXSelectedTextAttribute) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
