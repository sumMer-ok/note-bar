import Foundation

enum DefinitionModule: String, CaseIterable, Hashable, Identifiable {
    case dictionary = "词典释义"
    case legal = "法律词典释义"
    case ai = "AI 释义"
    case notes = "自定义笔记"

    var id: String { rawValue }
}

struct ParsedDefinitionModule {
    let module: DefinitionModule
    let headerLine: String?
    var content: String
}

/// 解析 Canvas 释义里的 `--- 标题 ---` 分节（与桌面端约定一致），
/// 并映射到四个模块：词典释义 / 法律词典释义 / AI 释义 / 自定义笔记。
enum DefinitionSections {
    static func parse(_ raw: String) -> [ParsedDefinitionModule] {
        var modules: [ParsedDefinitionModule] = []
        var currentHeader: String?
        var buffer: [String] = []

        func flush() {
            let content = buffer
                .joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !content.isEmpty || currentHeader != nil {
                modules.append(ParsedDefinitionModule(
                    module: moduleKey(for: currentHeader),
                    headerLine: currentHeader,
                    content: content
                ))
            }
            buffer = []
        }

        for line in raw.components(separatedBy: "\n") {
            if let header = headerAndTrailing(from: line) {
                flush()
                currentHeader = header.header
                if !header.trailing.isEmpty {
                    buffer.append(header.trailing)
                }
            } else {
                buffer.append(line)
            }
        }
        flush()
        return modules
    }

    /// 合并同类 section，按固定顺序返回：词典释义、法律词典释义、AI 释义、自定义笔记
    static func modules(_ raw: String) -> [(module: DefinitionModule, content: String, headerLine: String?)] {
        let parsed = parse(raw)
        var result: [(DefinitionModule, String, String?)] = []
        for key in DefinitionModule.allCases {
            let matches = parsed.filter { $0.module == key }
            guard !matches.isEmpty else { continue }
            let content = matches
                .map(\.content)
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")
            guard !content.isEmpty else { continue }
            let header = matches.compactMap(\.headerLine).first
            result.append((key, content, header))
        }
        return result
    }

    static func content(_ raw: String, module: DefinitionModule) -> String {
        modules(raw).first { $0.module == module }?.content ?? ""
    }

    /// 更新某个模块并重新序列化（保留原分节顺序与标题写法，桌面端可直接解析）
    static func update(_ raw: String, module: DefinitionModule, content: String) -> String {
        var parsed = parse(raw)
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)

        var updated = false
        for index in parsed.indices where parsed[index].module == module {
            if !updated {
                parsed[index].content = trimmed
                if parsed[index].headerLine == nil && module != .dictionary {
                    parsed[index] = ParsedDefinitionModule(
                        module: module,
                        headerLine: canonicalHeader(module),
                        content: trimmed
                    )
                }
                updated = true
            } else {
                parsed[index].content = ""
            }
        }
        if !updated && !trimmed.isEmpty {
            parsed.append(ParsedDefinitionModule(
                module: module,
                headerLine: module == .dictionary ? nil : canonicalHeader(module),
                content: trimmed
            ))
        }

        return serialize(parsed)
    }

    // MARK: - 私有

    private static func headerAndTrailing(from line: String) -> (header: String, trailing: String)? {
        let pattern = "^\\s*---\\s*(.+?)\\s*---(.*)$"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(line.startIndex..., in: line)
        guard let match = regex.firstMatch(in: line, range: range),
              match.numberOfRanges > 2,
              let headerRange = Range(match.range(at: 1), in: line),
              let trailingRange = Range(match.range(at: 2), in: line) else { return nil }
        return (
            String(line[headerRange]).trimmingCharacters(in: .whitespaces),
            String(line[trailingRange]).trimmingCharacters(in: .whitespaces)
        )
    }

    private static func moduleKey(for header: String?) -> DefinitionModule {
        guard let header else { return .dictionary }
        let lower = header.lowercased()
        if lower.contains("black") || lower.contains("法律") { return .legal }
        if lower.contains("ai") { return .ai }
        if lower.contains("笔记") { return .notes }
        if lower.contains("词典") || lower.contains("已有释义") { return .dictionary }
        return .notes
    }

    private static func canonicalHeader(_ module: DefinitionModule) -> String {
        switch module {
        case .legal: return "Black's Law Dictionary"
        case .ai: return "AI 释义"
        case .notes: return "自定义笔记"
        case .dictionary: return "词典释义"
        }
    }

    private static func serialize(_ parsed: [ParsedDefinitionModule]) -> String {
        var parts: [String] = []
        for item in parsed {
            let content = item.content.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !content.isEmpty else { continue }
            if let header = item.headerLine {
                parts.append("--- \(header) ---\n\(content)")
            } else {
                parts.append(content)
            }
        }
        return parts.joined(separator: "\n\n")
    }
}
