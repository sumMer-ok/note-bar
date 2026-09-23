import XCTest
@testable import NoteBarHelper

final class ConfigTests: XCTestCase {
    private func makeVault(dataJSON: String) throws -> String {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("nb-vault-\(UUID().uuidString)")
        let pluginDir = root.appendingPathComponent(".obsidian/plugins/note-bar")
        try FileManager.default.createDirectory(at: pluginDir, withIntermediateDirectories: true)
        try dataJSON.write(to: pluginDir.appendingPathComponent("data.json"), atomically: true, encoding: .utf8)
        return root.path
    }

    func testLoadVaultConfigReadsEnabledCanvasBooks() throws {
        let vault = try makeVault(dataJSON: """
        {"vocabularyBooks":[{"path":"law.canvas","name":"law","enabled":true},
                            {"path":"Words/AI.canvas","name":"AI","enabled":false},
                            {"path":"old.hiwords","name":"old","enabled":true}],
         "defaultVocabularyBookPaths":["law.canvas"],
         "crossAppInbox":{"enabled":true,"syncDir":"/tmp/nb-inbox","duplicatePolicy":"skip"},
         "chineseDictionary":{"enabled":true,"path":".obsidian/plugins/note-bar/data/dictionary.json"}}
        """)
        let cfg = try loadVaultConfig(vaultPath: vault)
        XCTAssertEqual(cfg.books.map(\.path), ["law.canvas", "Words/AI.canvas", "old.hiwords"])
        XCTAssertEqual(cfg.defaultBooks, ["law.canvas"])
        XCTAssertEqual(cfg.inboxDir, "/tmp/nb-inbox")
        XCTAssertEqual(cfg.rawDictionaryPath?.hasSuffix("dictionary.json"), true)
    }

    func testInboxDirFallsBackToMobileSyncAndIsTrimmed() throws {
        let vault = try makeVault(dataJSON: """
        {"vocabularyBooks":[],"crossAppInbox":{"enabled":true,"syncDir":"   "},
         "mobileSync":{"enabled":true,"syncDir":"/tmp/icloud-sync","pollIntervalSec":15}}
        """)
        XCTAssertEqual(try loadVaultConfig(vaultPath: vault).inboxDir, "/tmp/icloud-sync")
    }

    func testHelperConfigRoundTripAndDefaults() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("helper-\(UUID().uuidString).json")
        let cfg = HelperConfig(vaultPath: "/tmp/vault", inboxDirOverride: nil, hotkey: "alt+shift+d")
        cfg.save(to: url)
        XCTAssertEqual(HelperConfig.load(from: url).vaultPath, "/tmp/vault")
        XCTAssertEqual(HelperConfig.load(from: url).hotkey, "alt+shift+d")

        let missing = FileManager.default.temporaryDirectory.appendingPathComponent("nope-\(UUID().uuidString).json")
        XCTAssertEqual(HelperConfig.load(from: missing).hotkey, HelperConfig.fallbackHotkey)
    }
}
