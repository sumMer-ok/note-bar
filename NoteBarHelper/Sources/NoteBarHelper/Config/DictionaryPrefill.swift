import Foundation

/// 纯逻辑：把词典条目映射成浮窗的两个表单字段。
///
/// 格式必须与插件侧 `AddWordModal.autoFillFromDictionary` 一致：释义 = 音标一行 + 释义逐行；
/// 别名用逗号连接（浮窗提交时再按逗号拆开）。
public enum DictionaryPrefill {
    public struct Payload: Equatable, Sendable {
        public let word: String
        /// 便于日志与排查：为空表示该词条没有音标
        public let phonetic: String?
        public let definition: String
        public let aliases: String

        public init(word: String, phonetic: String?, definition: String, aliases: String) {
            self.word = word
            self.phonetic = phonetic
            self.definition = definition
            self.aliases = aliases
        }
    }

    public static func aliasText(_ aliases: [String]) -> String {
        aliases.joined(separator: ", ")
    }

    /// 音标在前（一行），释义每行一条
    public static func definitionText(_ entry: DictionaryEntry) -> String {
        var lines: [String] = []
        if let phonetic = entry.phonetic, !phonetic.isEmpty { lines.append(phonetic) }
        lines.append(contentsOf: entry.definitions)
        return lines.joined(separator: "\n")
    }

    /// 词条没有任何可用内容（音标、释义、别名全空）时返回 nil：此时不该覆盖用户已填的字段
    public static func payload(word: String, entry: DictionaryEntry) -> Payload? {
        let definition = definitionText(entry)
        let aliases = aliasText(entry.aliases)
        guard !definition.isEmpty || !aliases.isEmpty else { return nil }
        return Payload(word: word, phonetic: entry.phonetic, definition: definition, aliases: aliases)
    }
}
