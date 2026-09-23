import AppKit
import ApplicationServices

/// AppKit 委托与 WebKit/NSPanel 均为主线程隔离；Swift 6 语言模式下需显式标注。
@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var hotkey: GlobalHotkey?
    private let selection = SelectionService()
    private var config = HelperConfig.load(from: HelperConfig.defaultURL)
    private var vault: VaultConfig?
    private var panel: AssistantPanel?
    private var web: AssistantWebView?

    private static let accessibilityPaneURL =
        URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!

    public func applicationDidFinishLaunching(_ notification: Notification) {
        Diag.log("启动 v\(helperVersion())，日志=\(Diag.logURL.path)")
        Diag.log("辅助功能授权：\(AXIsProcessTrusted() ? "已授权" : "未授权（取词会失败）")")
        reloadVault()

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "NB"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "取词（\(config.hotkey)）", action: #selector(captureNow), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "重载 vault 配置", action: #selector(reloadVaultAction), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "打开辅助功能设置", action: #selector(openAccessibilitySettings), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "打开日志文件", action: #selector(revealLog), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "版本 \(helperVersion())", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
        statusItem = item

        hotkey = GlobalHotkey(spec: config.hotkey) { [weak self] in self?.captureNow() }
        if hotkey == nil {
            Diag.log("热键注册失败，改用菜单项取词（spec=\(config.hotkey)）")
        }
    }

    @objc private func reloadVaultAction() { reloadVault() }

    @objc private func openAccessibilitySettings() {
        NSWorkspace.shared.open(Self.accessibilityPaneURL)
    }

    @objc private func revealLog() {
        NSWorkspace.shared.activateFileViewerSelecting([Diag.logURL])
    }

    private func reloadVault() {
        guard !config.vaultPath.isEmpty else {
            Diag.log("未配置 vaultPath，请编辑 \(HelperConfig.defaultURL.path) 后点「重载 vault 配置」")
            return
        }
        do {
            let loaded = try loadVaultConfig(vaultPath: config.vaultPath)
            vault = loaded
            Diag.log("已载入 \(loaded.enabledCanvasBooks.count) 个启用词库，收件箱=\(config.resolveInboxDir(vault: loaded) ?? "未配置")")
        } catch {
            Diag.log("读取 vault 配置失败：\(error)")
        }
    }

    @objc func captureNow() {
        guard let result = selection.acquire() else {
            reportCaptureFailure()
            return
        }
        Diag.log("取词成功 [\(result.source.rawValue)] \(result.text)")
        presentAssistant(result: result)
    }

    /// 取词失败必须让用户看见「为什么」——原来只 beep 一声，表现为「按了没反应」，无从下手。
    private func reportCaptureFailure() {
        NSSound.beep()
        if AXIsProcessTrusted() {
            Diag.log("取词失败：已授权辅助功能，但 AX 与 ⌘C 兜底都没取到文本——通常是目标应用当时没有选中文本，或选区不在前台窗口。")
        } else {
            Diag.log("取词失败：本进程没有辅助功能授权 → 合成 ⌘C 会被系统丢弃、AX 也读不到。请到 系统设置 → 隐私与安全性 → 辅助功能 勾选 NoteBarHelper；重新打包后旧授权会失效，需要先取消勾选再重新勾选。")
            openAccessibilitySettings()
            let alert = NSAlert()
            alert.messageText = "需要辅助功能授权"
            alert.informativeText = """
            NoteBarHelper 需要「辅助功能」权限才能取词（读取选中文本与合成 ⌘C 都依赖它）。

            已为你打开设置页：在列表里找到 NoteBarHelper，取消勾选后再重新勾选；\
            如果列表里没有它，把 dist/NoteBarHelper.app 拖进列表即可。

            提示：ad-hoc 签名每次重新打包都会让旧授权失效——用自签证书打包（NOTEBAR_SIGN_ID）可避免反复授权。
            """
            alert.addButton(withTitle: "知道了")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    private func presentAssistant(result: SelectionResult) {
        guard let vault else {
            Diag.log("尚未载入 vault 配置，无法打开浮窗")
            NSSound.beep()
            return
        }
        guard let inboxDir = config.resolveInboxDir(vault: vault) else {
            Diag.log("收件箱目录未配置（data.json 的 crossAppInbox.syncDir 与 mobileSync.syncDir 都为空）")
            NSSound.beep()
            return
        }

        closeAssistantPanel()
        let p = AssistantPanel()
        let bridge = AssistantWebView(fallbackWord: result.text,
                                      fallbackSentence: nil) { [weak self] message in
            self?.handle(message: message, vault: vault, inboxDir: inboxDir,
                         source: result.source, word: result.text)
        }
        let view = bridge.load()
        p.attach(content: view)
        p.positionNearMouse()
        p.makeKeyAndOrderFront(nil)

        panel = p
        web = bridge
        bridge.pushInit(vaultInitJSON(vault: vault, result: result))
    }

    /// 关闭浮窗，并解开 WKWebView 与 JS 桥之间的引用环（否则每次取词都会泄漏一个 WKWebView）
    private func closeAssistantPanel() {
        web?.tearDown()
        web = nil
        panel?.close()
        panel = nil
    }

    private func handle(message: AssistantMessage, vault: VaultConfig, inboxDir: String,
                        source: SelectionSource, word: String) {
        defer { closeAssistantPanel() }
        guard case let .submit(payload) = message else { return }

        let frontApp = NSWorkspace.shared.frontmostApplication?.localizedName
        let entry = InboxEntry(
            id: InboxEntry.newId(),
            createdAt: InboxEntry.timestamp(),
            source: "wps-macos",
            word: payload.word,
            sentence: payload.sentence,
            definition: payload.definition,
            aliases: payload.aliases.isEmpty ? nil : payload.aliases,
            color: payload.color,
            books: payload.books.isEmpty ? nil : payload.books,
            origin: InboxEntry.Origin(app: frontApp ?? "unknown", file: nil)
        )
        do {
            let url = try InboxWriter.append(entry, inboxDir: inboxDir)
            Diag.log("已写入 \(url.path)（词=\(payload.word)，取词方式=\(source.rawValue)，词库=\(payload.books.joined(separator: ","))）")
        } catch {
            Diag.log("写入收件箱失败：\(error)")
            NSSound.beep()
        }
    }

    private func vaultInitJSON(vault: VaultConfig, result: SelectionResult) -> String {
        let defaults = Set(vault.effectiveDefaultBooks)
        let books = vault.enabledCanvasBooks.map { book -> [String: Any] in
            ["path": book.path, "name": book.name, "defaultChecked": defaults.contains(book.path)]
        }
        let payload: [String: Any] = [
            "word": result.text,
            "sentence": "",
            "definition": "",
            "aliases": [],
            "books": books,
            "source": result.source.rawValue,
            "originApp": NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return "{}" }
        return json
    }
}
