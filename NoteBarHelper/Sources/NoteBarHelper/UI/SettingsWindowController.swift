import AppKit

/// 设置窗口（AppKit 纯代码，不引入 SwiftUI）。
///
/// 三件事：改热键（带「录制」）、改 vault 路径、改收件箱目录覆盖。
/// 保存后由 `onSave` 负责写回 config.json 并**立刻重注册热键**，不需要重启 App。
@MainActor
public final class SettingsWindowController: NSObject, NSWindowDelegate {
    private let window: NSWindow
    private let hotkeyField = NSTextField()
    private let recordButton = NSButton()
    private let hotkeyHint = NSTextField(labelWithString: "")
    private let vaultField = NSTextField()
    private let inboxField = NSTextField()
    private let statusLabel = NSTextField(labelWithString: "")
    private let recorder = HotkeyRecorder()

    private var config: HelperConfig
    /// 返回 nil 表示保存成功；返回文字表示失败原因（原样显示在窗口里）
    private let onSave: (HelperConfig) -> String?

    public init(config: HelperConfig, onSave: @escaping (HelperConfig) -> String?) {
        self.config = config
        self.onSave = onSave
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 260),
                          styleMask: [.titled, .closable],
                          backing: .buffered,
                          defer: false)
        super.init()
        window.title = "NoteBarHelper 设置"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = buildContentView()
        window.center()
    }

    public func show() {
        reloadFields()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    public func windowWillClose(_ notification: Notification) {
        recorder.stop()
    }

    private func reloadFields() {
        hotkeyField.stringValue = config.hotkey
        vaultField.stringValue = config.vaultPath
        inboxField.stringValue = config.inboxDirOverride ?? ""
        updateHotkeyHint()
    }

    // MARK: - 布局

    private func buildContentView() -> NSView {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 260))

        let title = NSTextField(labelWithString: "设置")
        title.font = .boldSystemFont(ofSize: 13)

        hotkeyField.placeholderString = HelperConfig.fallbackHotkey
        hotkeyField.isEditable = true
        hotkeyField.translatesAutoresizingMaskIntoConstraints = false
        hotkeyField.widthAnchor.constraint(equalToConstant: 160).isActive = true

        recordButton.title = "录制"
        recordButton.bezelStyle = .rounded
        recordButton.target = self
        recordButton.action = #selector(toggleRecording)

        hotkeyHint.font = .systemFont(ofSize: 11)
        hotkeyHint.textColor = .secondaryLabelColor
        hotkeyHint.lineBreakMode = .byWordWrapping
        hotkeyHint.maximumNumberOfLines = 2
        hotkeyHint.preferredMaxLayoutWidth = 420
        hotkeyHint.translatesAutoresizingMaskIntoConstraints = false
        hotkeyHint.widthAnchor.constraint(equalToConstant: 420).isActive = true

        vaultField.placeholderString = "/Users/你需要/Documents/vault"
        inboxField.placeholderString = "留空则用 vault 里 crossAppInbox.syncDir"

        let hotkeyRow = NSStackView(views: [hotkeyField, recordButton, NSView()])
        hotkeyRow.orientation = .horizontal
        hotkeyRow.spacing = 8

        let form = NSStackView(views: [
            title,
            labelled("取词快捷键（点击「录制」后按下组合键，Esc 取消）", hotkeyRow),
            labelled("vault 路径", vaultField),
            labelled("收件箱目录覆盖（可留空）", inboxField),
            hotkeyHint,
        ])
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = 10
        form.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 3
        statusLabel.preferredMaxLayoutWidth = 280

        let saveButton = NSButton(title: "保存", target: self, action: #selector(save))
        saveButton.bezelStyle = .rounded
        saveButton.keyEquivalent = "\r"
        let logButton = NSButton(title: "打开日志", target: self, action: #selector(openLog))
        logButton.bezelStyle = .rounded
        let closeButton = NSButton(title: "关闭", target: self, action: #selector(close))
        closeButton.bezelStyle = .rounded
        closeButton.keyEquivalent = "\u{1b}"

        let buttons = NSStackView(views: [logButton, NSView(), closeButton, saveButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        buttons.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(form)
        root.addSubview(buttons)
        root.addSubview(statusLabel)
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            form.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),
            form.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            form.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),

            statusLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            statusLabel.bottomAnchor.constraint(equalTo: buttons.topAnchor, constant: -8),

            buttons.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            buttons.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            buttons.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),
        ])
        return root
    }

    private func labelled(_ text: String, _ control: NSView) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 11)
        label.textColor = .secondaryLabelColor
        control.translatesAutoresizingMaskIntoConstraints = false
        // 堆栈行（快捷键行）自带按钮宽度，不能再强行设宽；输入框统一拉满
        if !(control is NSStackView) {
            control.widthAnchor.constraint(equalToConstant: 420).isActive = true
        }
        let stack = NSStackView(views: [label, control])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 3
        return stack
    }

    // MARK: - 交互

    @objc private func toggleRecording() {
        if recorder.isRecording {
            recorder.stop()
            recordButton.title = "录制"
            setStatus("已取消录制", isError: false)
            return
        }
        setStatus("请按下组合键（至少一个修饰键 + 字母/数字符号），Esc 取消", isError: false)
        recordButton.title = "停止"
        recorder.start(onCapture: { [weak self] spec in
            guard let self else { return }
            self.recordButton.title = "录制"
            self.hotkeyField.stringValue = spec
            self.updateHotkeyHint()
            self.setStatus("已录制：\(spec)（点「保存」后立即生效）", isError: false)
        }, onCancel: { [weak self] in
            guard let self else { return }
            self.recordButton.title = "录制"
            self.setStatus("已取消录制", isError: false)
        })
    }

    @objc private func save() {
        recorder.stop()
        recordButton.title = "录制"

        let hotkey = hotkeyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard GlobalHotkey.parse(hotkey) != nil else {
            setStatus("快捷键格式无效：\(hotkey.isEmpty ? "（空）" : hotkey)。需要至少一个修饰键（cmd/alt/ctrl/shift）+ 一个字母、数字或符号。", isError: true)
            return
        }
        let vaultPath = vaultField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !vaultPath.isEmpty else {
            setStatus("vault 路径不能为空", isError: true)
            return
        }
        let inbox = inboxField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)

        config.vaultPath = vaultPath
        config.hotkey = hotkey
        config.inboxDirOverride = inbox.isEmpty ? nil : inbox

        if let failure = onSave(config) {
            setStatus("保存失败：\(failure)", isError: true)
            return
        }
        setStatus("已保存到 \(HelperConfig.defaultURL.path)，热键 \(hotkey) 已立即生效。", isError: false)
    }

    @objc private func openLog() {
        NSWorkspace.shared.activateFileViewerSelecting([Diag.logURL])
    }

    @objc private func close() {
        window.close()
    }

    private func updateHotkeyHint() {
        let spec = hotkeyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if GlobalHotkey.parse(spec) == nil {
            hotkeyHint.stringValue = "当前填写的内容无法注册：需要一个修饰键 + 一个字母/数字/符号，例如 alt+shift+d。"
            return
        }
        hotkeyHint.stringValue = "当前生效：\(spec)（\(HotkeySpec.display(spec))）"
    }

    private func setStatus(_ text: String, isError: Bool) {
        statusLabel.stringValue = text
        statusLabel.textColor = isError ? .systemRed : .secondaryLabelColor
    }
}
