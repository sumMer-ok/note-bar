import AppKit
import WebKit

/// 加词浮窗。
///
/// 关键点：外观上是无标题栏的浮层，但**保留系统窗口的拖动与缩放能力**——
/// 用 `.titled` 拿到标题栏拖动区与边缘缩放边框，再把标题文字与三个交通灯按钮隐藏，
/// 于是视觉上仍是干净浮层，行为上却可拖动、可缩放（borderless 窗口两者都没有）。
public final class AssistantPanel: NSPanel {
    public init(size: NSSize = NSSize(width: 400, height: 440)) {
        super.init(contentRect: NSRect(origin: .zero, size: size),
                   styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true

        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        isReleasedWhenClosed = false
        backgroundColor = .windowBackgroundColor
        hasShadow = true
        minSize = NSSize(width: 320, height: 300)
    }

    public override var canBecomeKey: Bool { true }

    /// 让内容视图填满标题栏以下的整块区域（随窗口缩放自适应）
    public func attach(content: NSView) {
        guard let container = contentView else { return }
        content.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            content.topAnchor.constraint(equalTo: container.topAnchor),
            content.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }

    /// 定位到鼠标附近（超出屏幕则回收到可见区域）
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

public final class AssistantWebView: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private let webView: WKWebView
    private let config: WKWebViewConfiguration
    private let onMessage: (AssistantMessage) -> Void
    private let fallbackWord: String
    private let fallbackSentence: String?
    private var pendingInit: String?
    private var pageReady = false

    public init(fallbackWord: String,
                fallbackSentence: String?,
                onMessage: @escaping (AssistantMessage) -> Void) {
        self.fallbackWord = fallbackWord
        self.fallbackSentence = fallbackSentence
        self.onMessage = onMessage
        let config = WKWebViewConfiguration()
        self.config = config
        self.webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, name: "nbh")
        webView.navigationDelegate = self
    }

    /// 关闭面板时必须调用：userContentController 强引用本对象、本对象又持有 webView，
    /// 不解开这个环的话每次按热键都会泄漏一个 WKWebView。
    public func tearDown() {
        config.userContentController.removeScriptMessageHandler(forName: "nbh")
        webView.navigationDelegate = nil
        webView.stopLoading()
    }

    public func load() -> WKWebView {
        guard let url = Bundle.module.url(forResource: "form", withExtension: "html") else {
            NSLog("NoteBarHelper: 找不到 form.html 资源")
            return webView
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return webView
    }

    /// 推入初始化数据。页面尚未就绪时先缓存，等 didFinish / ready 再推——
    /// 否则 `window.nbhInit` 还不存在，evaluateJavaScript 会静默失败，表现为「选中了词但面板是空的」。
    public func pushInit(_ json: String) {
        pendingInit = json
        flushInitIfPossible()
    }

    private func flushInitIfPossible() {
        guard pageReady, let json = pendingInit else { return }
        pendingInit = nil
        webView.evaluateJavaScript("window.nbhInit(\(json));") { _, error in
            if let error {
                NSLog("NoteBarHelper: nbhInit 执行失败：%@", String(describing: error))
            }
        }
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        flushInitIfPossible()
    }

    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nbh" else { return }

        // ready 只用于对齐加载时序，绝不转发给上层：上层收到任何消息都会关闭面板
        if AssistantMessage.isReadySignal(body: message.body) {
            pageReady = true
            flushInitIfPossible()
            return
        }

        guard let parsed = AssistantMessage(body: message.body,
                                            fallbackWord: fallbackWord,
                                            fallbackSentence: fallbackSentence) else { return }
        onMessage(parsed)
    }
}
