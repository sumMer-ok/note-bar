import Foundation

/// 助手自身配置；与 vault 数据完全分开
public struct HelperConfig: Codable {
    public var vaultPath: String
    public var inboxDirOverride: String?
    public var hotkey: String

    public static let fallbackHotkey = "alt+shift+d"

    public static var defaultURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("NoteBarHelper", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("config.json")
    }

    public static func load(from url: URL) -> HelperConfig {
        guard let data = try? Data(contentsOf: url),
              let cfg = try? JSONDecoder().decode(HelperConfig.self, from: data),
              !cfg.vaultPath.isEmpty else {
            return HelperConfig(vaultPath: "", inboxDirOverride: nil, hotkey: fallbackHotkey)
        }
        return cfg
    }

    public func save(to url: URL) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(self) {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    /// 收件箱目录决议：助手覆盖值优先，其次 vault 配置
    public func resolveInboxDir(vault: VaultConfig) -> String? {
        if let override = inboxDirOverride?.trimmingCharacters(in: .whitespacesAndNewlines), !override.isEmpty {
            return override
        }
        return vault.inboxDir
    }
}
