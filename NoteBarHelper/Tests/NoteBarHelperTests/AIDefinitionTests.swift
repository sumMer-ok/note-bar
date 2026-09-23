import XCTest
@testable import NoteBarHelper

final class AIDefinitionTests: XCTestCase {
    // MARK: - 提示词渲染

    func testRenderPromptReplacesBothPlaceholdersRepeatedly() {
        let template = "词：{{word}}；句：{{sentence}}；再来一次 {{word}}"
        XCTAssertEqual(AIDefinition.renderPrompt(template, word: "sue", sentence: "He sued."),
                       "词：sue；句：He sued.；再来一次 sue")
    }

    func testRenderPromptWithoutSentencePlaceholderOrWithNilSentence() {
        XCTAssertEqual(AIDefinition.renderPrompt("只查 {{word}}", word: "sue", sentence: nil), "只查 sue")
        XCTAssertEqual(AIDefinition.renderPrompt("句：{{sentence}}", word: "sue", sentence: nil), "句：")
        XCTAssertEqual(AIDefinition.renderPrompt("句：{{sentence}}", word: "sue", sentence: ""), "句：")
    }

    // MARK: - 请求路径与请求体

    func testRequestPathAppendsChatCompletionsOnce() {
        XCTAssertEqual(AIDefinition.requestPath(apiUrl: "https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions")
        XCTAssertEqual(AIDefinition.requestPath(apiUrl: "https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions")
        XCTAssertEqual(AIDefinition.requestPath(apiUrl: "https://x.dev/v1/chat/completions"), "https://x.dev/v1/chat/completions")
        XCTAssertEqual(AIDefinition.requestPath(apiUrl: "  https://x.dev/v1  "), "https://x.dev/v1/chat/completions")
        XCTAssertNil(AIDefinition.requestPath(apiUrl: "   "))
    }

    func testRequestBodyShapeMatchesPlugin() throws {
        let body = AIDefinition.makeRequestBody(model: "gpt-4o-mini", prompt: "P", extraParams: nil)
        let dict = try XCTUnwrap(body.objectValue)
        XCTAssertEqual(dict["model"], .string("gpt-4o-mini"))
        XCTAssertEqual(dict["max_tokens"], .int(4096))
        let messages = try XCTUnwrap(dict["messages"]?.arrayValue)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].objectValue?["role"], .string("user"))
        XCTAssertEqual(messages[0].objectValue?["content"], .string("P"))
    }

    func testExtraParamsAreMergedAndGarbageIsIgnored() throws {
        let merged = AIDefinition.makeRequestBody(model: "m", prompt: "P",
                                                  extraParams: #"{"max_tokens":8192,"top_p":0.9}"#)
        let dict = try XCTUnwrap(merged.objectValue)
        XCTAssertEqual(dict["max_tokens"], .int(8192), "extraParams 应覆盖默认值")
        XCTAssertEqual(dict["top_p"], .double(0.9))
        XCTAssertEqual(dict["model"], .string("m"), "未覆盖的字段应保留")

        for garbage in ["", "  ", "{}", "not json", "[1,2,3]", "\"str\""] {
            let body = AIDefinition.makeRequestBody(model: "m", prompt: "P", extraParams: garbage)
            XCTAssertEqual(body.objectValue?["max_tokens"], .int(4096), "extraParams=\(garbage) 时应用默认请求体")
        }
    }

    func testDeepMergeKeepsExistingNestedKeys() throws {
        let merged = AIDefinition.makeRequestBody(model: "m", prompt: "P", extraParams: #"{"foo":{"bar":1}}"#)
        XCTAssertEqual(merged.objectValue?["foo"]?.objectValue?["bar"], .int(1))

        let body = JSONValue.object(["a": .object(["keep": .int(1), "over": .int(2)])])
        let mergedBody = body.merged(with: .object(["a": .object(["over": .int(3)])]))
        XCTAssertEqual(mergedBody.objectValue?["a"], .object(["keep": .int(1), "over": .int(3)]))
    }

    // MARK: - 响应解析

    func testExtractContentFromValidResponse() throws {
        let data = Data(#"{"choices":[{"message":{"role":"assistant","content":"hello"}}]}"#.utf8)
        XCTAssertEqual(try AIDefinition.extractContent(fromResponse: data), "hello")
    }

    func testExtractContentRejectsBadPayloads() {
        let cases: [String] = [
            "not json",
            "[]",
            #"{"choices":[]}"#,
            #"{"choices":[{"message":{}}]}"#,
            #"{"choices":[{"message":{"content":"   "}}]}"#,
        ]
        for raw in cases {
            XCTAssertThrowsError(try AIDefinition.extractContent(fromResponse: Data(raw.utf8)), raw) { error in
                guard case .invalidResponse = error as? AIDefinition.Failure else {
                    return XCTFail("\(raw) 应抛 invalidResponse，实际 \(error)")
                }
            }
        }
    }

    func testParsePlainJSONContent() {
        let parsed = AIDefinition.parseDefinitionResponse(#"{"aliases":["sue","sued"],"definition":"v. 起诉"}"#)
        XCTAssertEqual(parsed.aliases, ["sue", "sued"])
        XCTAssertEqual(parsed.definition, "v. 起诉")
    }

    func testParseContentWrappedInCodeFence() {
        let content = """
        好的，结果如下：
        ```json
        {"aliases": ["go", "goes"], "definition": "1）音标\\n2）v. 走"}
        ```
        """
        let parsed = AIDefinition.parseDefinitionResponse(content)
        XCTAssertEqual(parsed.aliases, ["go", "goes"])
        XCTAssertEqual(parsed.definition, "1）音标\n2）v. 走")
    }

    func testParseContentWrappedInBareFenceWithTrailingProse() {
        let content = """
        ```
        {"aliases": [], "definition": "只有释义"}
        ```
        希望有帮助！
        """
        let parsed = AIDefinition.parseDefinitionResponse(content)
        XCTAssertEqual(parsed.definition, "只有释义")
        XCTAssertEqual(parsed.aliases, [])
    }

    func testParseContentWithLeadingProseAndJSONBracesInsideStrings() {
        let content = #"这是结果：{"aliases":["a{b"],"definition":"含 } 花括号的定义"}  —— 完"#
        let parsed = AIDefinition.parseDefinitionResponse(content)
        XCTAssertEqual(parsed.aliases, ["a{b"])
        XCTAssertEqual(parsed.definition, "含 } 花括号的定义")
    }

    func testParseFallsBackToRawTextWhenJSONIsBroken() {
        let content = "v. 维持；支撑"
        XCTAssertEqual(AIDefinition.parseDefinitionResponse(content),
                       AIDefinition.Payload(aliases: [], definition: "v. 维持；支撑"))
        XCTAssertEqual(AIDefinition.parseDefinitionResponse("  "),
                       AIDefinition.Payload(aliases: [], definition: ""))
    }

    func testParseIgnoresJSONWithoutUsableFields() {
        let parsed = AIDefinition.parseDefinitionResponse(#"{"other":1}"#)
        XCTAssertEqual(parsed, AIDefinition.Payload(aliases: [], definition: #"{"other":1}"#),
                       "无法取到 aliases/definition 时回落为整段文本，而不是空结果")
    }

    func testParseAcceptsStringAliases() {
        let parsed = AIDefinition.parseDefinitionResponse(#"{"aliases":"sue","definition":"v. 起诉"}"#)
        XCTAssertEqual(parsed.aliases, ["sue"])
    }

    // MARK: - AI 服务配置读取与守卫

    func testFailureDescriptionsAreHumanReadable() {
        XCTAssertTrue(AIDefinition.Failure.notConfigured("未配置 API Key").description.contains("未配置 API Key"))
        XCTAssertTrue(AIDefinition.Failure.http(status: 401, message: "bad key").description.contains("401"))
        XCTAssertTrue(AIDefinition.Failure.http(status: 500, message: nil).description.contains("500"))
    }

    /// 未配置/被关闭的守卫必须在发请求之前就抛错：前 1 例用连不上的地址证明「根本没有真的发出去」
    private func assertFetchFails(service: AIServiceConfig?,
                                  definition: AIDefinitionConfig?,
                                  word: String = "sue",
                                  expecting expected: String) async {
        do {
            _ = try await AIDefinitionClient.fetch(service: service, definition: definition,
                                                   word: word, sentence: nil, log: { _ in })
            XCTFail("\(expected)：应抛配置错误而不是真的发起请求")
        } catch {
            let description = (error as? AIDefinition.Failure)?.description ?? "\(error)"
            XCTAssertTrue(description.contains(expected), "期望包含「\(expected)」，实际：\(description)")
        }
    }

    private func service(apiUrl: String? = "https://x.dev/v1",
                         apiKey: String? = "k",
                         model: String? = "m") -> AIServiceConfig {
        AIServiceConfig(provider: nil, apiUrl: apiUrl, apiKey: apiKey, model: model, extraParams: nil)
    }

    func testFetchRejectsMissingAIDefinitionConfig() async {
        await assertFetchFails(service: service(), definition: nil, expecting: "AI 释义提示词")
    }

    func testFetchRejectsDisabledAIDefinition() async {
        await assertFetchFails(service: service(),
                               definition: AIDefinitionConfig(enabled: false, prompt: "{{word}}"),
                               expecting: "已关闭 AI 释义")
    }

    func testFetchRejectsMissingAIServiceConfig() async {
        await assertFetchFails(service: nil,
                               definition: AIDefinitionConfig(enabled: true, prompt: "{{word}}"),
                               expecting: "没有 AI 服务配置")
    }

    func testFetchRejectsMissingApiKey() async {
        await assertFetchFails(service: service(apiKey: nil),
                               definition: AIDefinitionConfig(enabled: true, prompt: "{{word}}"),
                               expecting: "未配置 API Key")
    }

    func testFetchRejectsMissingApiUrlAndModel() async {
        let definition = AIDefinitionConfig(enabled: true, prompt: "{{word}}")
        await assertFetchFails(service: service(apiUrl: nil), definition: definition, expecting: "未配置 API 地址")
        await assertFetchFails(service: service(model: nil), definition: definition, expecting: "未配置模型 ID")
    }

    func testFetchRejectsEmptyWord() async {
        do {
            _ = try await AIDefinitionClient.fetch(service: nil, definition: nil, word: "  ", sentence: nil, log: { _ in })
            XCTFail("空单词应抛错")
        } catch {
            XCTAssertEqual(error as? AIDefinition.Failure, .notConfigured("没有可查询的单词"))
        }
    }

    /// 日志里绝不能出现 apiKey
    func testFetchNeverLogsApiKey() async {
        let secret = "sk-super-secret-value"
        let recorded = LogBox()
        let service = AIServiceConfig(provider: nil, apiUrl: "https://127.0.0.1:1/v1",
                                      apiKey: secret, model: "m", extraParams: nil)
        do {
            _ = try await AIDefinitionClient.fetch(service: service,
                                                   definition: AIDefinitionConfig(enabled: true, prompt: "{{word}}"),
                                                   word: "sue", sentence: nil,
                                                   log: { recorded.append($0) })
            XCTFail("连不上的地址应抛错")
        } catch {
            XCTAssertFalse(recorded.lines.joined().contains(secret),
                           "日志里出现了 apiKey：\(recorded.lines)")
            XCTAssertTrue(recorded.lines.contains { $0.contains("apiKey=已配置") },
                          "应记录 key 是否配置，但只有布尔信息：\(recorded.lines)")
        }
    }
}

/// 收集日志：`log` 闭包要求 Sendable，用一个带锁的小盒子跨线程记
private final class LogBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    func append(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        storage.append(line)
    }

    var lines: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
