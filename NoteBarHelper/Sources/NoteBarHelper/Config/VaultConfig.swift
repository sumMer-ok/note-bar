import Foundation

public struct VocabularyBook: Decodable {
    public let path: String
    public let name: String
    public let enabled: Bool
}

/// data.json 里的 AI 服务配置（OpenAI 兼容格式）
public struct AIServiceConfig: Equatable, Sendable {
    public let provider: String?
    public let apiUrl: String?
    public let apiKey: String?
    public let model: String?
    /// 原样保存的 JSON 字符串；能否解析由 `AIDefinition.makeRequestBody` 决定
    public let extraParams: String?

    public init(provider: String?, apiUrl: String?, apiKey: String?, model: String?, extraParams: String?) {
        self.provider = provider
        self.apiUrl = apiUrl
        self.apiKey = apiKey
        self.model = model
        self.extraParams = extraParams
    }
}

/// data.json 里的 AI 释义开关与提示词
public struct AIDefinitionConfig: Equatable, Sendable {
    public let enabled: Bool
    public let prompt: String

    public init(enabled: Bool, prompt: String) {
        self.enabled = enabled
        self.prompt = prompt
    }
}

/// 从 vault 的 data.json 读出的只读快照；助手绝不写回该文件
public struct VaultConfig {
    public let books: [VocabularyBook]
    public let defaultBooks: [String]
    public let inboxDir: String?
    public let rawDictionaryPath: String?
    public let aiService: AIServiceConfig?
    public let aiDefinition: AIDefinitionConfig?

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
    struct AIService: Decodable {
        let provider: String?
        let apiUrl: String?
        let apiKey: String?
        let model: String?
        let extraParams: String?
    }
    struct AIDefinition: Decodable {
        let enabled: Bool?
        let prompt: String?
    }
    let vocabularyBooks: [VocabularyBook]?
    let defaultVocabularyBookPaths: [String]?
    let crossAppInbox: CrossAppInbox?
    let mobileSync: MobileSync?
    let chineseDictionary: NamedPath?
    let aiService: AIService?
    let aiDefinition: AIDefinition?
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
    let aiService = raw.aiService.map {
        AIServiceConfig(provider: nonEmpty($0.provider),
                        apiUrl: nonEmpty($0.apiUrl),
                        apiKey: nonEmpty($0.apiKey),
                        model: nonEmpty($0.model),
                        extraParams: nonEmpty($0.extraParams))
    }
    // 提示词缺失时按「未启用」处理：没有 prompt 就没有可渲染的 user message
    let aiDefinition = raw.aiDefinition.flatMap { def -> AIDefinitionConfig? in
        guard let prompt = nonEmpty(def.prompt) else { return nil }
        return AIDefinitionConfig(enabled: def.enabled ?? false, prompt: prompt)
    }
    return VaultConfig(
        books: raw.vocabularyBooks ?? [],
        defaultBooks: raw.defaultVocabularyBookPaths ?? [],
        inboxDir: inboxDir,
        rawDictionaryPath: dictRel.map { URL(fileURLWithPath: vaultPath).appendingPathComponent($0).path },
        aiService: aiService,
        aiDefinition: aiDefinition
    )
}
