import Foundation

struct AIDefinitionResult: Sendable {
    var definition: String
    var aliases: [String]
}

enum AIDefinitionError: LocalizedError {
    case invalidWord
    case missingURL
    case missingKey
    case missingModel
    case invalidURL
    case http(Int)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidWord: return "单词不能为空"
        case .missingURL: return "API 地址不能为空"
        case .missingKey: return "API Key 未配置"
        case .missingModel: return "模型 ID 不能为空"
        case .invalidURL: return "API 地址格式无效"
        case .http(let code): return "HTTP \(code)"
        case .invalidResponse: return "API 返回了无效的响应格式"
        }
    }
}

/// 与 Obsidian 插件 DictionaryService（openai-compatible 适配器）行为一致
enum AIDefinitionService {
    struct Config {
        var apiUrl: String
        var apiKey: String
        var model: String
        var extraParams: String
        var prompt: String
    }

    /// 从资源加载与插件逐字一致的提示词；缺失时用最小兜底
    static func loadPrompt() -> String {
        if let url = Bundle.main.url(forResource: "ai-definition-prompt", withExtension: "txt"),
           let text = try? String(contentsOf: url, encoding: .utf8),
           !text.isEmpty {
            return text
        }
        return "请为单词 \"{{word}}\" 生成英汉词典释义。只输出 JSON：{\"aliases\": [], \"definition\": \"\"}"
    }

    /// 法律词典 OCR 校对提示词（{{sentence}} 位置传入待纠正的原文）
    static let legalCorrectionPrompt = """
    你是法律词典校对助手。下面是经过 OCR 识别的英文法律词典释义（来自 Black's Law Dictionary），可能存在错字、乱码、断行错误、标点错误和多余空格。请在不改变原意的前提下：
    1）纠正所有 OCR 识别错误；
    2）按编号条目（1. 2. 3.）重新组织段落，删除多余换行；
    3）保持英文原文，不翻译、不增删词义。
    只输出纠正后的纯文本，不要任何解释、不要 markdown 标题、不要 JSON。

    待纠正的原文：
    {{sentence}}
    """

    static func fetchDefinition(
        word: String,
        sentence: String = "",
        config: Config
    ) async throws -> AIDefinitionResult {
        let cleanWord = word.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanWord.isEmpty else { throw AIDefinitionError.invalidWord }
        guard !config.apiUrl.trimmingCharacters(in: .whitespaces).isEmpty else { throw AIDefinitionError.missingURL }
        guard !config.apiKey.trimmingCharacters(in: .whitespaces).isEmpty else { throw AIDefinitionError.missingKey }
        guard !config.model.trimmingCharacters(in: .whitespaces).isEmpty else { throw AIDefinitionError.missingModel }

        let prompt = config.prompt
            .replacingOccurrences(of: "{{word}}", with: cleanWord)
            .replacingOccurrences(of: "{{sentence}}", with: sentence)
        guard let url = URL(string: chatCompletionsURL(config.apiUrl)) else {
            throw AIDefinitionError.invalidURL
        }

        var body: [String: Any] = [
            "model": config.model,
            "messages": [["role": "user", "content": prompt]],
            "temperature": 0.3,
            "max_tokens": 500,
        ]
        if let data = config.extraParams.data(using: .utf8),
           let extra = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            body = deepMerge(base: body, extra: extra)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw AIDefinitionError.http(http.statusCode)
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any],
              let content = message["content"] as? String else {
            throw AIDefinitionError.invalidResponse
        }
        return parse(content)
    }

    /// 与插件 parseDefinitionResponse 相同的容错解析链
    static func parse(_ content: String) -> AIDefinitionResult {
        var text = content.trimmingCharacters(in: .whitespacesAndNewlines)

        // 1) 提取 ```json ... ``` 代码块
        let codeBlockPattern = "```(?:json)?\\s*([\\s\\S]*?)\\s*```"
        if let regex = try? NSRegularExpression(pattern: codeBlockPattern),
           let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
           match.numberOfRanges > 1,
           let r = Range(match.range(at: 1), in: text) {
            text = String(text[r]).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // 2) 提取第一个 JSON 对象并严格解析
        let jsonPattern = "\\{[\\s\\S]*\\}"
        if let regex = try? NSRegularExpression(pattern: jsonPattern),
           let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
           let r = Range(match.range(at: 0), in: text) {
            let raw = String(text[r])
            if let strict = parseJSONObject(raw) { return strict }
            if let repaired = parseJSONObject(repair(raw)) { return repaired }
            if let extracted = extractFields(from: raw) { return extracted }
        }

        // 3) 完全无法解析时，整个内容作为释义
        return AIDefinitionResult(definition: text, aliases: [])
    }

    // MARK: - 私有

    private static func chatCompletionsURL(_ base: String) -> String {
        let normalized = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return normalized.hasSuffix("/chat/completions") ? normalized : "\(normalized)/chat/completions"
    }

    private static func parseJSONObject(_ raw: String) -> AIDefinitionResult? {
        guard let data = raw.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let definition = (object["definition"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let aliases = (object["aliases"] as? [Any] ?? [])
            .compactMap { $0 as? String }
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty }
        if !definition.isEmpty || !aliases.isEmpty {
            return AIDefinitionResult(definition: definition, aliases: aliases)
        }
        return nil
    }

    /// 修复常见错误：尾随逗号、字符串内的未转义换行
    private static func repair(_ raw: String) -> String {
        var repaired = raw.replacingOccurrences(
            of: ",\\s*([}\\]])",
            with: "$1",
            options: .regularExpression
        )
        repaired = escapeNewlinesInStrings(repaired)
        return repaired
    }

    private static func escapeNewlinesInStrings(_ json: String) -> String {
        var result = ""
        var inString = false
        let chars = Array(json)
        var i = 0
        while i < chars.count {
            let ch = chars[i]
            if inString {
                if ch == "\\", i + 1 < chars.count {
                    result.append(ch)
                    result.append(chars[i + 1])
                    i += 2
                    continue
                }
                if ch == "\"" {
                    inString = false
                    result.append(ch)
                } else if ch == "\n" {
                    result.append("\\n")
                } else {
                    result.append(ch)
                }
            } else {
                if ch == "\"" { inString = true }
                result.append(ch)
            }
            i += 1
        }
        return result
    }

    /// JSON 整体解析失败时按字段提取
    private static func extractFields(from raw: String) -> AIDefinitionResult? {
        let definitionPattern = "\"definition\"\\s*:\\s*\"([\\s\\S]*?)(?<!\\\\)\""
        var definition = ""
        if let regex = try? NSRegularExpression(pattern: definitionPattern),
           let match = regex.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
           match.numberOfRanges > 1,
           let r = Range(match.range(at: 1), in: raw) {
            definition = unescape(String(raw[r])).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        var aliases: [String] = []
        let aliasesPattern = "\"aliases\"\\s*:\\s*\\[([\\s\\S]*?)\\]"
        if let regex = try? NSRegularExpression(pattern: aliasesPattern),
           let match = regex.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
           match.numberOfRanges > 1,
           let r = Range(match.range(at: 1), in: raw) {
            let inner = String(raw[r])
            let itemPattern = "\"([^\"]*)\""
            if let itemRegex = try? NSRegularExpression(pattern: itemPattern) {
                let matches = itemRegex.matches(in: inner, range: NSRange(inner.startIndex..., in: inner))
                aliases = matches.compactMap { match in
                    guard match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: inner) else { return nil }
                    return String(inner[range]).trimmingCharacters(in: .whitespaces).lowercased()
                }.filter { !$0.isEmpty }
            }
        }

        if !definition.isEmpty || !aliases.isEmpty {
            return AIDefinitionResult(definition: definition, aliases: aliases)
        }
        return nil
    }

    private static func unescape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\n", with: "\n")
            .replacingOccurrences(of: "\\\"", with: "\"")
            .replacingOccurrences(of: "\\\\", with: "\\")
    }

    private static func deepMerge(base: [String: Any], extra: [String: Any]) -> [String: Any] {
        var output = base
        for (key, value) in extra {
            if let extraDict = value as? [String: Any],
               let baseDict = output[key] as? [String: Any] {
                output[key] = deepMerge(base: baseDict, extra: extraDict)
            } else {
                output[key] = value
            }
        }
        return output
    }
}
