import Foundation

public struct VocabularyBook: Decodable {
    public let path: String
    public let name: String
    public let enabled: Bool
}

/// 从 vault 的 data.json 读出的只读快照；助手绝不写回该文件
public struct VaultConfig {
    public let books: [VocabularyBook]
    public let defaultBooks: [String]
    public let inboxDir: String?
    public let rawDictionaryPath: String?

    /// 只落 3.3 节约定：只使用已启用且以 .canvas 结尾的词库
    public var enabledCanvasBooks: [VocabularyBook] {
        books.filter { $0.enabled && $0.path.hasSuffix(".canvas") }
    }

    public var effectiveDefaultBooks: [String] {
        let enabled = Set(enabledCanvasBooks.map(\.path))
        return defaultBooks.filter { enabled.contains($0) }
    }
}

private struct RawSettings: Decodable {
    struct CrossAppInbox: Decodable {
        let enabled: Bool?
        let syncDir: String?
        let duplicatePolicy: String?
    }
    struct MobileSync: Decodable {
        let enabled: Bool?
        let syncDir: String?
    }
    struct NamedPath: Decodable {
        let enabled: Bool?
        let path: String?
    }
    let vocabularyBooks: [VocabularyBook]?
    let defaultVocabularyBookPaths: [String]?
    let crossAppInbox: CrossAppInbox?
    let mobileSync: MobileSync?
    let chineseDictionary: NamedPath?
}

private func nonEmpty(_ s: String?) -> String? {
    guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
    return t
}

public func dataJSONURL(vaultPath: String) -> URL {
    URL(fileURLWithPath: vaultPath)
        .appendingPathComponent(".obsidian/plugins/note-bar/data.json")
}

public func loadVaultConfig(vaultPath: String) throws -> VaultConfig {
    let data = try Data(contentsOf: dataJSONURL(vaultPath: vaultPath))
    let raw = try JSONDecoder().decode(RawSettings.self, from: data)
    let inboxDir = nonEmpty(raw.crossAppInbox?.syncDir) ?? nonEmpty(raw.mobileSync?.syncDir)
    let dictRel = raw.chineseDictionary?.enabled == true ? nonEmpty(raw.chineseDictionary?.path) : nil
    return VaultConfig(
        books: raw.vocabularyBooks ?? [],
        defaultBooks: raw.defaultVocabularyBookPaths ?? [],
        inboxDir: inboxDir,
        rawDictionaryPath: dictRel.map { URL(fileURLWithPath: vaultPath).appendingPathComponent($0).path }
    )
}
