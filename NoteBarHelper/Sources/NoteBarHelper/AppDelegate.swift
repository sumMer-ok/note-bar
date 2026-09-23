import AppKit

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
        NSLog("NoteBarHelper: 取词成功 [%@] %@", result.source.rawValue, result.text)
    }
}
