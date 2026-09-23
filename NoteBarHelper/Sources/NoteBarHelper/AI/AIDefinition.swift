import Foundation

/// AI 释义的纯逻辑：提示词渲染、请求体拼装、模型回复解析。
/// 全部无副作用的纯函数，方便单测（网络与日志在 `AIDefinitionClient`）。
public enum AIDefinition {
    /// 解析结果（不叫 `Result`：会和 Swift 标准库的 `Result` 撞名）
    public struct Payload: Equatable, Sendable {
        public let aliases: [String]
        public let definition: String

        public init(aliases: [String], definition: String) {
            self.aliases = aliases
            self.definition = definition
        }
    }

    public enum Failure: Error, Equatable, CustomStringConvertible {
        case notConfigured(String)
        case badURL(String)
        case http(status: Int, message: String?)
        case invalidResponse(String)
        case unparsable(String)

        public var description: String {
            switch self {
            case .notConfigured(let reason): return reason
            case .badURL(let url): return "API 地址无效：\(url)"
            case .http(let status, let message):
                if let message, !message.isEmpty { return "AI 服务返回 HTTP \(status)：\(message)" }
                return "AI 服务返回 HTTP \(status)"
            case .invalidResponse(let reason): return "AI 返回的响应格式无效（\(reason)）"
            case .unparsable(let reason): return "无法解析 AI 返回的内容（\(reason)）"
            }
        }
    }

    /// 与插件 `DictionaryService.replacePlaceholders` 完全一致
    public static func renderPrompt(_ template: String, word: String, sentence: String?) -> String {
        template
            .replacingOccurrences(of: "{{word}}", with: word)
            .replacingOccurrences(of: "{{sentence}}", with: sentence ?? "")
    }

    /// `${apiUrl}/chat/completions`；apiUrl 已经指向该端点时原样使用
    public static func requestPath(apiUrl: String) -> String? {
        var base = apiUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix("/") { base.removeLast() }
        guard !base.isEmpty else { return nil }
        if base.hasSuffix("/chat/completions") { return base }
        return base + "/chat/completions"
    }

    /// OpenAI 兼容请求体：model + 单条 user message；extraParams 能解析成对象就深合并进去
    public static func makeRequestBody(model: String, prompt: String, extraParams: String?) -> JSONValue {
        let base: JSONValue = .object([
            "model": .string(model),
            "messages": .array([.object(["role": .string("user"), "content": .string(prompt)])]),
            "temperature": .double(0.3),
            // 4096：推理模型会把预算先花在 reasoning tokens 上，500 会导致正文为空
            "max_tokens": .int(4096),
        ])
        guard let raw = extraParams?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty, raw != "{}",
              let extra = JSONValue(jsonString: raw), extra.objectValue != nil else {
            return base
        }
        return base.merged(with: extra)
    }

    public static func encodeBody(_ body: JSONValue) -> Data? {
        try? JSONSerialization.data(withJSONObject: body.anyValue)
    }

    /// 取 `choices[0].message.content`；失败时抛出可直接展示给用户的 `Failure`
    public static func extractContent(fromResponse data: Data) throws -> String {
        guard let value = JSONValue(jsonData: data), let dict = value.objectValue else {
            throw Failure.invalidResponse("不是 JSON 对象")
        }
        guard let choices = dict["choices"]?.arrayValue, let first = choices.first,
              let content = first.objectValue?["message"]?.objectValue?["content"]?.stringValue else {
            throw Failure.invalidResponse("缺少 choices[0].message.content")
        }
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw Failure.invalidResponse("模型返回了空内容")
        }
        return content
    }

    /// 解析模型给出的 content：可能是裸 JSON、被 ```json 代码块包住、或干脆是纯文本
    public static func parseDefinitionResponse(_ content: String) -> Payload {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        for candidate in jsonCandidates(in: trimmed) {
            if let parsed = decodeEntry(candidate) { return parsed }
        }
        return Payload(aliases: [], definition: trimmed)
    }

    /// 候选 JSON 文本：先取代码块内容，再回落到整串里的第一个平衡对象
    static func jsonCandidates(in text: String) -> [String] {
        var candidates: [String] = []
        if let block = firstCodeBlock(in: text) { candidates.append(block) }
        if let object = firstJSONObject(in: text), !candidates.contains(object) { candidates.append(object) }
        return candidates
    }

    /// 取出 ``` 围栏内的内容（``` 后可选语言标记）。围栏没闭合时，把首行之后的全部内容当作正文。
    static func firstCodeBlock(in text: String) -> String? {
        guard let opening = text.range(of: "```") else { return nil }
        let rest = text[opening.upperBound...]
        guard let newline = rest.firstIndex(of: "\n") else { return nil }
        let afterLang = rest[rest.index(after: newline)...]
        let body = afterLang.range(of: "```").map { afterLang[..<$0.lowerBound] } ?? afterLang
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// 括号配平地取出第一个完整对象，避免贪婪正则把后续文字一起吞进来
    static func firstJSONObject(in text: String) -> String? {
        let bytes = Array(text.utf8)
        guard let start = bytes.firstIndex(of: 0x7B) else { return nil }
        var depth = 0
        var index = start
        var inString = false
        var escaped = false
        while index < bytes.count {
            let byte = bytes[index]
            if inString {
                if escaped {
                    escaped = false
                } else if byte == 0x5C {
                    escaped = true
                } else if byte == 0x22 {
                    inString = false
                }
            } else {
                switch byte {
                case 0x22: inString = true
                case 0x7B, 0x5B: depth += 1
                case 0x7D, 0x5D:
                    depth -= 1
                    if depth == 0 { return String(decoding: bytes[start...index], as: UTF8.self) }
                    if depth < 0 { return nil }
                default: break
                }
            }
            index += 1
        }
        return nil
    }

    private static func decodeEntry(_ candidate: String) -> Payload? {
        guard let value = JSONValue(jsonString: candidate), let dict = value.objectValue else { return nil }
        let definition = dict["definition"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let aliases = DictionaryEntry.stringList(dict["aliases"])
        guard !definition.isEmpty || !aliases.isEmpty else { return nil }
        return Payload(aliases: aliases, definition: definition)
    }
}
