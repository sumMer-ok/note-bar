import XCTest
@testable import NoteBarHelper

/// vault 的 data.json 里 AI 相关配置（aiService / aiDefinition）的读取
final class AIConfigTests: XCTestCase {
    private func makeVault(dataJSON: String) throws -> String {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("nb-vault-ai-\(UUID().uuidString)")
        let pluginDir = root.appendingPathComponent(".obsidian/plugins/note-bar")
        try FileManager.default.createDirectory(at: pluginDir, withIntermediateDirectories: true)
        try dataJSON.write(to: pluginDir.appendingPathComponent("data.json"), atomically: true, encoding: .utf8)
        return root.path
    }

    func testLoadVaultConfigReadsAIServiceAndAIDefinition() throws {
        let vault = try makeVault(dataJSON: """
        {"vocabularyBooks":[],
         "chineseDictionary":{"enabled":true,"path":".obsidian/plugins/note-bar/data/dictionary.json"},
         "aiService":{"provider":"openai-compatible","apiUrl":"https://api.deepseek.com/v1/",
                      "apiKey":" sk-test ","model":"deepseek-chat","extraParams":"{\\"max_tokens\\":8192}"},
         "aiDefinition":{"enabled":true,"prompt":"查 {{word}} 在 {{sentence}} 里的意思"}}
        """)
        let cfg = try loadVaultConfig(vaultPath: vault)
        XCTAssertEqual(cfg.aiService?.apiUrl, "https://api.deepseek.com/v1/")
        XCTAssertEqual(cfg.aiService?.apiKey, "sk-test", "apiKey 应被 trim，避免把空白带进 Authorization 头")
        XCTAssertEqual(cfg.aiService?.model, "deepseek-chat")
        XCTAssertEqual(cfg.aiService?.extraParams, #"{"max_tokens":8192}"#)
        XCTAssertEqual(cfg.aiDefinition, AIDefinitionConfig(enabled: true, prompt: "查 {{word}} 在 {{sentence}} 里的意思"))
        XCTAssertEqual(cfg.rawDictionaryPath?.hasSuffix("data/dictionary.json"), true)
    }

    func testAIKeysAbsentWhenNotConfiguredAndDisabledDictionaryLeavesNoPath() throws {
        let vault = try makeVault(dataJSON: #"{"vocabularyBooks":[],"chineseDictionary":{"enabled":false,"path":"x.json"}}"#)
        let cfg = try loadVaultConfig(vaultPath: vault)
        XCTAssertNil(cfg.aiService)
        XCTAssertNil(cfg.aiDefinition)
        XCTAssertNil(cfg.rawDictionaryPath, "词典未启用时不应给出路径")
    }

    func testAIDefinitionWithoutPromptCountsAsNotConfigured() throws {
        let vault = try makeVault(dataJSON: #"{"vocabularyBooks":[],"aiDefinition":{"enabled":true,"prompt":"   "}}"#)
        XCTAssertNil(try loadVaultConfig(vaultPath: vault).aiDefinition)
    }
}
