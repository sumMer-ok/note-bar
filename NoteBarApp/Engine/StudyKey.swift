import Foundation

enum StudyKey {
    /// 与 JS 端 normalizeStudyText 对齐：NFKC → trim → 空白折叠 → 去首尾标点/符号 → 小写。
    /// 小写统一用 Unicode 默认（JS `toLowerCase()` ↔ Swift `lowercased()`），不依赖运行环境 locale。
    static func normalizeText(_ value: String) -> String {
        var s = nfkc(value).trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        s = s.trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.symbols))
        return s.lowercased()
    }

    static func normalizeLanguage(_ language: String?) -> String {
        let s = nfkc(language ?? "und").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return s.isEmpty ? "und" : s
    }

    static func inferType(word: String, language: String?) -> String {
        let text = normalizeText(word)
        if normalizeLanguage(language).hasPrefix("zh") { return "concept" }
        if text.range(of: "[\\s-]", options: .regularExpression) != nil { return "phrase" }
        return "word"
    }

    static func build(word: String, language: String?, type: String?) -> String? {
        let text = normalizeText(word)
        guard !text.isEmpty else { return nil }
        let lang = normalizeLanguage(language)
        let kind = type ?? inferType(word: word, language: language)
        return "\(lang):\(kind):\(text)"
    }

    /// Canvas 普通节点的进度键（桌面回退规则 `source:nodeId`）
    static func canvas(source: String, nodeId: String) -> String {
        "\(source):\(nodeId)"
    }

    private static func nfkc(_ s: String) -> String {
        s.applyingTransform(StringTransform(rawValue: "NFKC"), reverse: false) ?? s
    }
}
