import XCTest
@testable import NoteBarHelper

final class DictionaryPrefillTests: XCTestCase {
    private func temporaryDictionary(_ json: String) throws -> String {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("nb-dict-\(UUID().uuidString).json")
        try json.write(to: url, atomically: true, encoding: .utf8)
        return url.path
    }

    private let sample = """
    {"consider":{"p":"kənˈsɪdə","d":["v. 考虑；认为","v. 细想"],"a":["considering","considered"]},
     "sustain":{"p":"səˈsteɪn","d":["v. 维持；支撑"],"a":[]},
     "noPhonetic":{"d":["只有释义"],"a":["np"]}}
    """

    // MARK: - 纯逻辑：词条 → 表单字段

    func testDefinitionTextPutsPhoneticFirst() {
        let entry = DictionaryEntry(phonetic: "kənˈsɪdə", definitions: ["v. 考虑", "v. 细想"], aliases: ["considering"])
        XCTAssertEqual(DictionaryPrefill.definitionText(entry), "kənˈsɪdə\nv. 考虑\nv. 细想")
    }

    func testDefinitionTextSkipsMissingPhonetic() {
        let entry = DictionaryEntry(phonetic: nil, definitions: ["只有释义"], aliases: [])
        XCTAssertEqual(DictionaryPrefill.definitionText(entry), "只有释义")
    }

    func testAliasTextJoinsWithCommaAndSpace() {
        XCTAssertEqual(DictionaryPrefill.aliasText(["considering", "considered"]), "considering, considered")
        XCTAssertEqual(DictionaryPrefill.aliasText([]), "")
    }

    func testPayloadIsNilWhenEntryHasNothingUsable() {
        XCTAssertNil(DictionaryPrefill.payload(word: "x", entry: DictionaryEntry(phonetic: nil, definitions: [], aliases: [])))
        let payload = DictionaryPrefill.payload(word: "sustain",
                                                entry: DictionaryEntry(phonetic: nil, definitions: ["v. 维持"], aliases: []))
        XCTAssertEqual(payload?.definition, "v. 维持")
        XCTAssertEqual(payload?.aliases, "")
    }

    // MARK: - 词典文件解析

    func testDictionaryEntryToleratesScalarStringsForAliases() throws {
        let entry = try XCTUnwrap(JSONValue(jsonString: #"{"p":"səˈsteɪn","d":"v. 维持","a":"sustained"}"#))
        let parsed = try XCTUnwrap(DictionaryEntry(json: entry))
        XCTAssertEqual(parsed.definitions, ["v. 维持"])
        XCTAssertEqual(parsed.aliases, ["sustained"])
        XCTAssertEqual(parsed.phonetic, "səˈsteɪn")
    }

    func testLookupFindsWordAndIsCaseInsensitive() throws {
        let path = try temporaryDictionary(sample)
        for word in ["consider", "Consider", " CONSIDER "] {
            guard case let .found(entry) = try lookupDictionaryEntry(inFileAt: path, word: word) else {
                return XCTFail("\(word) 应命中")
            }
            XCTAssertEqual(entry.phonetic, "kənˈsɪdə")
            XCTAssertEqual(entry.definitions, ["v. 考虑；认为", "v. 细想"])
            XCTAssertEqual(entry.aliases, ["considering", "considered"])
        }
    }

    func testLookupReportsMissingWordAndMissingFile() throws {
        let path = try temporaryDictionary(sample)
        XCTAssertEqual(try lookupDictionaryEntry(inFileAt: path, word: "absent"), .wordMissing)
        XCTAssertEqual(try lookupDictionaryEntry(inFileAt: path, word: "   "), .wordMissing)

        guard case .fileUnavailable = try lookupDictionaryEntry(inFileAt: "/tmp/definitely-missing-nb.json", word: "consider") else {
            return XCTFail("文件不存在时应返回 fileUnavailable")
        }
    }

    func testLookupSurvivesEntriesWithEmptyValues() throws {
        let path = try temporaryDictionary(#"{"empty":{"d":[],"a":[]},"consider":{"p":"k","d":["v. 考虑"],"a":["considering"]}}"#)
        guard case .fileUnavailable = try lookupDictionaryEntry(inFileAt: path, word: "empty") else {
            return XCTFail("空词条应被当作不可用而非命中")
        }
        guard case let .found(entry) = try lookupDictionaryEntry(inFileAt: path, word: "consider") else {
            return XCTFail("仍应能命中后面的词条")
        }
        XCTAssertEqual(entry.definitions, ["v. 考虑"])
    }

    func testLookupHandlesBracesAndQuotesInsideDefinitions() throws {
        let path = try temporaryDictionary(#"{"tricky":{"p":"t","d":["含 { 括号 与 \" 引号 } 的释义","第二行"],"a":["trickies"]},"after":{"d":["尾部"]}}"#)
        guard case let .found(entry) = try lookupDictionaryEntry(inFileAt: path, word: "tricky") else {
            return XCTFail("带括号/引号的释义应能正确配平")
        }
        XCTAssertEqual(entry.definitions, ["含 { 括号 与 \" 引号 } 的释义", "第二行"])
        XCTAssertEqual(entry.aliases, ["trickies"])
    }

    func testLookupHandlesEscapedQuotesInKeysAndNestedObjects() throws {
        let path = try temporaryDictionary(#"{"a\"b":{"d":["带转义引号的键"]},"nested":{"d":["n"],"extra":{"deep":[1,2,{"x":"}"}]}}}"#)
        guard case let .found(entry) = try lookupDictionaryEntry(inFileAt: path, word: "a\"b") else {
            return XCTFail("键里的转义引号不应破坏扫描")
        }
        XCTAssertEqual(entry.definitions, ["带转义引号的键"])
        guard case let .found(nested) = try lookupDictionaryEntry(inFileAt: path, word: "nested") else {
            return XCTFail("嵌套对象应能被配平")
        }
        XCTAssertEqual(nested.definitions, ["n"])
    }

    /// 真实词典 363MB：词条可能跨块边界，用 1 字节的块把这条路径逼出来
    func testWordReaderHandlesChunkBoundaries() throws {        let path = try temporaryDictionary(sample)
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        for chunkSize in [1, 2, 3, 7, 64] {
            var reader = DictionaryWordReader(key: "noPhonetic", chunkSize: chunkSize)
            var result: DictionaryWordReader.Step = .moreData
            var offset = 0
            while offset < data.count, case .moreData = result {
                let end = min(offset + chunkSize, data.count)
                result = reader.consume(Array(data[offset..<end]))
                offset = end
            }
            if case .moreData = result { result = reader.finish() }
            guard case let .found(entry) = result else {
                return XCTFail("块大小 \(chunkSize) 时未命中：\(result)")
            }
            XCTAssertEqual(entry.definitions, ["只有释义"])
            XCTAssertEqual(entry.aliases, ["np"])
        }
    }

    /// 真实 vault 的词典实测 363MB，这条用例只在显式给出路径时运行：
    ///   NOTEBAR_TEST_DICTIONARY=/path/to/dictionary.json swift test --filter testRealDictionary
    func testRealDictionaryLookupWhenRequested() throws {
        guard let path = ProcessInfo.processInfo.environment["NOTEBAR_TEST_DICTIONARY"], !path.isEmpty else {
            throw XCTSkip("未设置 NOTEBAR_TEST_DICTIONARY，跳过真实词典用例")
        }
        let word = ProcessInfo.processInfo.environment["NOTEBAR_TEST_WORD"] ?? "consideration"
        let started = Date()
        let outcome = try lookupDictionaryEntry(inFileAt: path, word: word)
        let elapsed = Date().timeIntervalSince(started)
        guard case let .found(entry) = outcome else {
            return XCTFail("真实词典里应能查到 \(word)：\(outcome)")
        }
        print("真实词典命中 \(word)：\(entry.phonetic ?? "无音标")，\(entry.definitions.count) 条释义，"
              + "\(entry.aliases.count) 个别名，耗时 \(String(format: "%.2f", elapsed))s")
        XCTAssertFalse(entry.definitions.isEmpty)
    }
}
