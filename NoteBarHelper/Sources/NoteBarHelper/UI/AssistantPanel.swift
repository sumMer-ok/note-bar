import AppKit
import WebKit

public final class AssistantPanel: NSPanel {
    public init(size: NSSize = NSSize(width: 380, height: 430)) {
        super.init(contentRect: NSRect(origin: .zero, size: size),
                   styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        isReleasedWhenClosed = false
        backgroundColor = .clear
        hasShadow = true
    }

    public override var canBecomeKey: Bool { true }

    /// 定位到鼠标附近的选区旁（左上角锚点 + 少量偏移，超出屏幕则回收到可见区域）
    public func positionNearMouse(offset: NSPoint = NSPoint(x: 12, y: -12)) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        var origin = NSPoint(x: mouse.x + offset.x, y: mouse.y + offset.y - frame.height)
        origin.x = min(max(visible.minX + 8, origin.x), visible.maxX - frame.width - 8)
        origin.y = min(max(visible.minY + 8, origin.y), visible.maxY - frame.height - 8)
        setFrameOrigin(origin)
    }
}

public final class AssistantWebView: NSObject, WKScriptMessageHandler {
    private let webView: WKWebView
    private let onMessage: (AssistantMessage) -> Void
    private let fallbackWord: String
    private let fallbackSentence: String?

    public init(fallbackWord: String,
                fallbackSentence: String?,
                onMessage: @escaping (AssistantMessage) -> Void) {
        self.fallbackWord = fallbackWord
        self.fallbackSentence = fallbackSentence
        self.onMessage = onMessage
        let config = WKWebViewConfiguration()
        self.webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, name: "nbh")
    }

    public func load() -> WKWebView {
        guard let url = Bundle.module.url(forResource: "form", withExtension: "html") else {
            NSLog("NoteBarHelper: 找不到 form.html 资源")
            return webView
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return webView
    }

    public func pushInit(_ json: String) {
        webView.evaluateJavaScript("window.nbhInit(\(json));", completionHandler: nil)
    }

    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nbh", let parsed = AssistantMessage(body: message.body,
                                                                   fallbackWord: fallbackWord,
                                                                   fallbackSentence: fallbackSentence) else { return }
        onMessage(parsed)
    }
}
