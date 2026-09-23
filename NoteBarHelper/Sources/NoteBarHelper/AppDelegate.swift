import AppKit

/// AppKit 委托与 WebKit/NSPanel 均为主线程隔离；Swift 6 语言模式下需显式标注。
@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var hotkey: GlobalHotkey?
    private let selection = SelectionService()
    private var config = HelperConfig.load(from: HelperConfig.defaultURL)
    private var vault: VaultConfig?

    public func applicationDidFinishLaunching(_ notification: Notification) {
        reloadVault()
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "NB"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "取词（\(config.hotkey)）", action: #selector(captureNow), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "重载 vault 配置", action: #selector(reloadVaultAction), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "版本 \(helperVersion())", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
        statusItem = item

        hotkey = GlobalHotkey(spec: config.hotkey) { [weak self] in self?.captureNow() }
        if hotkey == nil {
            NSLog("NoteBarHelper: 热键注册失败，改用菜单项取词（spec=%@)", config.hotkey)
        }
    }

    @objc private func reloadVaultAction() { reloadVault() }

    private func reloadVault() {
        guard !config.vaultPath.isEmpty else {
            NSLog("NoteBarHelper: 未配置 vaultPath，先编辑 %@", HelperConfig.defaultURL.path)
            return
        }
        do {
            vault = try loadVaultConfig(vaultPath: config.vaultPath)
            NSLog("NoteBarHelper: 已载入 %d 个词库，收件箱=%@",
                  vault?.enabledCanvasBooks.count ?? 0,
                  config.resolveInboxDir(vault: vault!) ?? "未配置")
        } catch {
            NSLog("NoteBarHelper: 读取 vault 配置失败 %@", String(describing: error))
        }
    }

    @objc func captureNow() {
        guard let result = selection.acquire() else {
            NSLog("NoteBarHelper: 未取到选中文本（AX 与 ⌘C 兜底都失败；若未授权辅助功能请到系统设置开启）")
            NSSound.beep()
            return
        }
        presentAssistant(result: result)
    }

    private var panel: AssistantPanel?
    private var web: AssistantWebView?

    private func presentAssistant(result: SelectionResult) {
        guard let vault else {
            NSLog("NoteBarHelper: 尚未载入 vault 配置，无法打开浮窗")
            NSSound.beep()
            return
        }
        guard let inboxDir = config.resolveInboxDir(vault: vault) else {
            NSLog("NoteBarHelper: 收件箱目录未配置（data.json 的 crossAppInbox.syncDir 或 mobileSync.syncDir 均为空）")
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
            NSLog("NoteBarHelper: 已写入 %@（取词方式 %@）", url.path, source.rawValue)
        } catch {
            NSLog("NoteBarHelper: 写入收件箱失败 %@", String(describing: error))
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
