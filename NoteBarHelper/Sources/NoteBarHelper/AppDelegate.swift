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
    private var settingsWindow: SettingsWindowController?
    /// 「取词（alt+shift+d）」菜单项，改热键后要同步标题
    private var captureMenuItem: NSMenuItem?

    private static let accessibilityPaneURL =
        URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!

    public func applicationDidFinishLaunching(_ notification: Notification) {
        Diag.log("启动 v\(helperVersion())，日志=\(Diag.logURL.path)")
        Diag.log("辅助功能授权：\(AXIsProcessTrusted() ? "已授权" : "未授权（取词会失败）")")
        reloadVault()

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "NB"
        let menu = NSMenu()
        let capture = NSMenuItem(title: captureTitle(), action: #selector(captureNow), keyEquivalent: "")
        captureMenuItem = capture
        menu.addItem(capture)
        menu.addItem(NSMenuItem(title: "设置…", action: #selector(openSettings), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "重载 vault 配置", action: #selector(reloadVaultAction), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "打开辅助功能设置", action: #selector(openAccessibilitySettings), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "打开日志文件", action: #selector(revealLog), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "版本 \(helperVersion())", action: nil, keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
        statusItem = item

        registerHotkey()
    }

    @objc private func reloadVaultAction() { reloadVault() }

    @objc private func openAccessibilitySettings() {
        NSWorkspace.shared.open(Self.accessibilityPaneURL)
    }

    @objc private func revealLog() {
        NSWorkspace.shared.activateFileViewerSelecting([Diag.logURL])
    }

    // MARK: - 设置窗口

    /// 主线程上的 @objc 动作必然在主 actor 上执行，但 Swift 6 不认这一点，需要显式 hop
    @objc private func openSettings() {
        MainActor.assumeIsolated { self.presentSettings() }
    }

    private func presentSettings() {
        let controller = SettingsWindowController(config: config) { [weak self] updated in
            self?.apply(updated)
        }
        settingsWindow = controller
        controller.show()
    }

    /// 保存回调：写回 config.json → 立刻重注册热键 → 重载 vault 配置
    private func apply(_ updated: HelperConfig) -> String? {
        updated.save(to: HelperConfig.defaultURL)
        config = updated
        Diag.log("设置已保存：热键=\(updated.hotkey)，vault=\(updated.vaultPath)，收件箱覆盖=\(updated.inboxDirOverride ?? "（空）")")
        let failure = registerHotkey()
        reloadVault()
        return failure
    }

    /// 注册（或重注册）全局热键。失败时返回给设置窗口的提示文案，同时保留菜单项取词。
    @discardableResult
    private func registerHotkey() -> String? {
        hotkey?.unregister()
        hotkey = nil
        captureMenuItem?.title = captureTitle()
        hotkey = GlobalHotkey(spec: config.hotkey) { [weak self] in self?.captureNow() }
        guard hotkey == nil else {
            Diag.log("全局热键已注册：\(config.hotkey)")
            return nil
        }
        Diag.log("热键注册失败，改用菜单项取词（spec=\(config.hotkey)）")
        return "热键 \(config.hotkey) 无法注册（可能已被其他应用占用），可先用菜单栏「取词」；换一个组合键再试。"
    }

    private func captureTitle() -> String {
        "取词（\(config.hotkey)）"
    }

    /// 刷新 vault 快照。菜单栏「重载 vault 配置」、设置保存、**每次打开浮窗**都走这一段，
    /// 只有读盘失败才保留旧快照（现场 bug：用户在助手启动后新增词库，浮窗一直用启动那一刻的快照，
    /// 3 个词库只列出 1 个）。裁决是纯函数 `decideVaultRefresh`，这里只负责读盘与打日志。
    private func reloadVault() {
        guard !config.vaultPath.isEmpty else {
            Diag.log("未配置 vaultPath，请编辑 \(HelperConfig.defaultURL.path) 后点「重载 vault 配置」")
            return
        }
        let attempt = Result { try loadVaultConfig(vaultPath: config.vaultPath) }
        switch decideVaultRefresh(cached: vault, attempt: attempt) {
        case .adopt(let loaded, let logLines):
            vault = loaded
            logLines.forEach { Diag.log($0) }
        case .keep(let cached, let logLines):
            vault = cached
            logLines.forEach { Diag.log($0) }
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
        // 每次打开浮窗前重读一次 vault 配置：用户可能在助手运行期间新增/重命名了词库，
        // 不刷新就会一直列出启动那一刻的快照（读盘失败时 reloadVault 保留旧快照，不会因此打不开浮窗）。
        reloadVault()
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
            guard let self else { return }
            // 「AI 释义」不关闭面板，其余消息（提交/取消）走原来的收尾流程。
            // 这里引用 self.web 而不是闭包外声明的 bridge：后者会触发「闭包捕获尚未声明的变量」。
            if case let .aiExplain(request) = message {
                guard let current = self.web else { return }
                self.handleAIExplain(request, vault: vault, web: current)
            } else {
                self.handle(message: message, vault: vault, inboxDir: inboxDir,
                            source: result.source, word: result.text)
            }
        }
        let view = bridge.load()
        p.attach(content: view)
        p.positionNearMouse()
        p.makeKeyAndOrderFront(nil)

        panel = p
        web = bridge
        bridge.pushInit(vaultInitJSON(vault: vault, result: result))
        prefillFromDictionary(vault: vault, word: result.text, bridge: bridge)
    }

    /// 关闭浮窗，并解开 WKWebView 与 JS 桥之间的引用环（否则每次取词都会泄漏一个 WKWebView）
    private func closeAssistantPanel() {
        web?.tearDown()
        web = nil
        panel?.close()
        panel = nil
    }

    // MARK: - 本地词典预填

    /// 词典有 363MB 这类量级，必须放到后台线程流式查，绝不阻塞浮窗出现
    private func prefillFromDictionary(vault: VaultConfig, word: String, bridge: AssistantWebView) {
        guard let path = vault.rawDictionaryPath else {
            Diag.log("本地词典预填跳过：vault 的 data.json 里 chineseDictionary 未启用或 path 为空")
            return
        }
        let key = word
        DispatchQueue.global(qos: .utility).async { [weak self] in
            enum Outcome { case payload(DictionaryPrefill.Payload); case notFound; case unavailable(String) }
            let outcome: Outcome
            do {
                switch try lookupDictionaryEntry(inFileAt: path, word: key) {
                case .found(let entry):
                    outcome = DictionaryPrefill.payload(word: key, entry: entry).map(Outcome.payload) ?? .notFound
                case .wordMissing:
                    outcome = .notFound
                case .fileUnavailable(let reason):
                    outcome = .unavailable(reason)
                }
            } catch {
                outcome = .unavailable("\(error)")
            }
            DispatchQueue.main.async {
                guard let self else { return }
                // 面板可能已经被关掉或换成了另一个词：只有仍持有同一个 bridge 时才推
                guard self.web === bridge else { return }
                switch outcome {
                case .payload(let payload):
                    Diag.log("本地词典预填：词=\(key)，音标=\(payload.phonetic ?? "无")，释义=\(payload.definition.count) 字，别名=\(payload.aliases.isEmpty ? "无" : payload.aliases)")
                    bridge.push(script: self.prefillScript(payload))
                case .notFound:
                    Diag.log("本地词典预填跳过：词典里没有「\(key)」或该词条为空")
                case .unavailable(let reason):
                    Diag.log("本地词典预填跳过：\(reason)")
                }
            }
        }
    }

    private func prefillScript(_ payload: DictionaryPrefill.Payload) -> String {
        let body = Self.jsonObject([
            "word": .string(payload.word),
            "definition": .string(payload.definition),
            "aliases": .string(payload.aliases),
        ])
        return "window.nbhFill(\(body));"
    }

    // MARK: - AI 释义

    private func handleAIExplain(_ request: AIExplainRequest, vault: VaultConfig, web webView: AssistantWebView) {
        Diag.log("AI 释义请求：词=\(request.word)，例句=\(request.sentence?.isEmpty == false ? "有" : "无")")
        Task { @MainActor in
            var script: String
            do {
                let result = try await AIDefinitionClient.fetch(service: vault.aiService,
                                                                 definition: vault.aiDefinition,
                                                                 word: request.word,
                                                                 sentence: request.sentence)
                script = Self.aiPayloadScript(aliases: DictionaryPrefill.aliasText(result.aliases),
                                              definition: result.definition)
            } catch {
                let message = (error as? AIDefinition.Failure)?.description ?? "\(error)"
                Diag.log("AI 释义失败：\(message)")
                script = Self.aiPayloadScript(error: message)
            }
            guard self.web === webView else { return }
            webView.push(script: script)
        }
    }

    static func aiPayloadScript(aliases: String = "", definition: String = "", error: String = "") -> String {
        let body = jsonObject([
            "aliases": .string(aliases),
            "definition": .string(definition),
            "error": .string(error),
        ])
        return "window.nbhFillAI(\(body));"
    }

    private static func jsonObject(_ object: [String: JSONValue]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: JSONValue.object(object).anyValue),
              let json = String(data: data, encoding: .utf8) else { return "{}" }
        return json
    }

    // MARK: - 提交

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
        let books = vault.enabledCanvasBooks.map { book -> JSONValue in
            return .object(["path": .string(book.path),
                            "name": .string(book.name),
                            "defaultChecked": .bool(defaults.contains(book.path))])
        }
        // 例句预填为选区原文（插件侧 AddWordModal 也是把选中文本当作 sentence）
        return Self.jsonObject([
            "word": .string(result.text),
            "sentence": .string(result.text),
            "definition": .string(""),
            "aliases": .string(""),
            "books": .array(books),
            "source": .string(result.source.rawValue),
            "originApp": .string(NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown"),
        ])
    }
}
