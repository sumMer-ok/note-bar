import Foundation

/// AI 释义的网络层：POST `${apiUrl}/chat/completions`（OpenAI 兼容，Bearer apiKey）。
///
/// 日志纪律：任何分支都**不得**写 apiKey。这里只记录「是否已配置 key」与错误原因。
///
/// 并发：`URLSession.data(for:)` 是 async 的，但在 Swift 6 语言模式下闭包 `log` 需要 Sendable，
/// 因此这里显式标注 `sending` 语义由调用方保证（`Diag.log` 是线程安全的纯追加写）。
public enum AIDefinitionClient {
    public static func fetch(service: AIServiceConfig?,
                             definition: AIDefinitionConfig?,
                             word: String,
                             sentence: String?,
                             log: @escaping @Sendable (String) -> Void = { Diag.log($0) }) async throws -> AIDefinition.Payload {
        let trimmedWord = word.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedWord.isEmpty else {
            throw AIDefinition.Failure.notConfigured("没有可查询的单词")
        }
        guard let definition else {
            throw AIDefinition.Failure.notConfigured("vault 的 data.json 里没有配置 AI 释义提示词（aiDefinition.prompt）")
        }
        guard definition.enabled else {
            throw AIDefinition.Failure.notConfigured("vault 里已关闭 AI 释义（设置 → HiWords → AI 释义）")
        }
        guard let service else {
            throw AIDefinition.Failure.notConfigured("vault 的 data.json 里没有 AI 服务配置（aiService）")
        }
        guard let apiKey = service.apiKey, !apiKey.isEmpty else {
            throw AIDefinition.Failure.notConfigured("未配置 API Key：请在 Obsidian 插件设置里填写 AI 服务的 API Key")
        }
        guard let apiUrl = service.apiUrl else {
            throw AIDefinition.Failure.notConfigured("未配置 API 地址（aiService.apiUrl）")
        }
        guard let model = service.model else {
            throw AIDefinition.Failure.notConfigured("未配置模型 ID（aiService.model）")
        }
        guard let path = AIDefinition.requestPath(apiUrl: apiUrl) else {
            throw AIDefinition.Failure.badURL(apiUrl)
        }
        guard let url = URL(string: path), url.scheme != nil else {
            throw AIDefinition.Failure.badURL(path)
        }
        let prompt = AIDefinition.renderPrompt(definition.prompt, word: trimmedWord, sentence: sentence)
        let body = AIDefinition.makeRequestBody(model: model, prompt: prompt, extraParams: service.extraParams)
        guard let payload = AIDefinition.encodeBody(body) else {
            throw AIDefinition.Failure.invalidResponse("请求体无法编码")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = payload
        request.timeoutInterval = 30

        log("AI 释义请求：词=\(trimmedWord)，模型=\(model)，apiKey=已配置")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            log("AI 释义网络失败：\(error.localizedDescription)")
            throw AIDefinition.Failure.invalidResponse("网络请求失败：\(error.localizedDescription)")
        }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let message = String(data: data, encoding: .utf8)?.prefix(200)
            log("AI 释义失败：HTTP \(http.statusCode)（响应已截断）\(message.map { String($0) } ?? "")")
            throw AIDefinition.Failure.http(status: http.statusCode, message: message.map { String($0) })
        }

        let content: String
        do {
            content = try AIDefinition.extractContent(fromResponse: data)
        } catch {
            log("AI 释义响应无法使用：\((error as? AIDefinition.Failure)?.description ?? "\(error)")")
            throw error
        }
        let parsed = AIDefinition.parseDefinitionResponse(content)
        log("AI 释义成功：词=\(trimmedWord)，别名=\(parsed.aliases.count) 个，释义=\(parsed.definition.count) 字")
        return parsed
    }
}
