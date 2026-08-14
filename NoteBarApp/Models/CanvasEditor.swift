import Foundation
import Security

struct ParsedWord {
    var nodeId: String
    var word: String
    var aliases: [String]
    var definition: String
    var color: String?
    var addedDate: String?
    var mastered: Bool
}

enum CanvasEditor {
    static func randomHexId() -> String {
        var bytes = [UInt8](repeating: 0, count: 8)
        _ = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 8, $0.baseAddress!) }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func todayLabel(date: Date = Date()) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    static func parseWords(data: Data, source: String) throws -> [ParsedWord] {
        let root = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let nodes = (root["nodes"] as? [[String: Any]]) ?? []
        let groups = nodes.filter { ($0["type"] as? String) == "group" }
        let masteredGroup = groups.first { node in
            let label = node["label"] as? String
            return label == "Mastered" || label == "已掌握"
        }
        let dateGroups = groups.filter { node in
            guard let label = node["label"] as? String else { return false }
            return label.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil
        }

        var words: [ParsedWord] = []
        for node in nodes {
            guard let type = node["type"] as? String, let id = node["id"] as? String else { continue }
            let text: String
            switch type {
            case "text": text = node["text"] as? String ?? ""
            case "file": text = node["file"] as? String ?? ""
            default: continue
            }
            guard let parsed = parseText(text) else { continue }
            var addedDate: String?
            for group in dateGroups where nodeInGroup(node, group) {
                addedDate = group["label"] as? String
            }
            var mastered = false
            if let masteredGroup, nodeInGroup(node, masteredGroup) { mastered = true }
            if node["color"] as? String == "4" { mastered = true }
            words.append(ParsedWord(
                nodeId: id, word: parsed.word, aliases: parsed.aliases,
                definition: parsed.definition, color: node["color"] as? String,
                addedDate: addedDate, mastered: mastered
            ))
        }
        return words
    }

    static func addWord(
        data: inout [String: Any], word: String, definition: String,
        aliases: [String], color: String?, cardWidth: Double, cardHeight: Double
    ) throws -> String {
        var nodes = (data["nodes"] as? [[String: Any]]) ?? []
        let nodeId = randomHexId()

        var group = nodes.first { ($0["type"] as? String) == "group" && ($0["label"] as? String) == todayLabel() }
        if group == nil {
            let maxX = nodes.filter { ($0["type"] as? String) == "group" }
                .map { ($0["x"] as? Double ?? 0) + ($0["width"] as? Double ?? 0) }
                .max() ?? 0
            let newGroup: [String: Any] = [
                "id": randomHexId(), "type": "group",
                "x": nodes.isEmpty ? 0 : maxX + 40, "y": 0,
                "width": 48 + cardWidth, "height": 48 + cardHeight,
                "label": todayLabel(),
            ]
            nodes.append(newGroup)
            group = newGroup
        }

        let members = nodes.filter { ($0["type"] as? String) != "group" && nodeInGroup($0, group!) }
        let index = members.count
        let col = index % 2, row = index / 2
        let gx = group?["x"] as? Double ?? 0
        let gy = group?["y"] as? Double ?? 0

        var text = word
        if !aliases.isEmpty { text += "\n*\(aliases.joined(separator: ", "))*" }
        if !definition.isEmpty { text += "\n\n\(definition)" }

        var node: [String: Any] = [
            "id": nodeId, "type": "text",
            "x": gx + 24 + Double(col) * (cardWidth + 12),
            "y": gy + 24 + Double(row) * (cardHeight + 12),
            "width": cardWidth, "height": cardHeight, "text": text,
        ]
        if let color { node["color"] = color }
        nodes.append(node)
        data["nodes"] = nodes
        return nodeId
    }

    static func updateWord(data: inout [String: Any], nodeId: String, word: String, definition: String, aliases: [String]) -> Bool {
        guard var nodes = data["nodes"] as? [[String: Any]],
              let i = nodes.firstIndex(where: { $0["id"] as? String == nodeId }) else { return false }
        var text = word
        if !aliases.isEmpty { text += "\n*\(aliases.joined(separator: ", "))*" }
        if !definition.isEmpty { text += "\n\n\(definition)" }
        nodes[i]["text"] = text
        data["nodes"] = nodes
        return true
    }

    static func deleteWord(data: inout [String: Any], nodeId: String) -> Bool {
        guard var nodes = data["nodes"] as? [[String: Any]],
              let i = nodes.firstIndex(where: { $0["id"] as? String == nodeId }) else { return false }
        nodes.remove(at: i)
        data["nodes"] = nodes
        return true
    }

    // MARK: - 私有

    private static func parseText(_ text: String) -> (word: String, aliases: [String], definition: String)? {
        var lines = text.components(separatedBy: "\n")
        while let first = lines.first, first.trimmingCharacters(in: .whitespaces).isEmpty { lines.removeFirst() }
        guard var word = lines.first?.trimmingCharacters(in: .whitespaces), !word.isEmpty else { return nil }
        word = word.replacingOccurrences(of: "^#+\\s*", with: "", options: .regularExpression)
        word = stripMarkdown(word)
        guard !word.isEmpty else { return nil }
        lines.removeFirst()

        var aliases: [String] = []
        var definitionLines: [String] = []
        var seenDefinition = false
        for line in lines {
            let t = line.trimmingCharacters(in: .whitespaces)
            if !seenDefinition, t.hasPrefix("*"), t.hasSuffix("*"), !t.hasPrefix("**"), !t.hasSuffix("**"), t.count > 2 {
                aliases = String(t.dropFirst().dropLast()).split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            } else if !t.isEmpty {
                seenDefinition = true
                definitionLines.append(t)
            } else if seenDefinition {
                definitionLines.append(t)
            }
        }
        return (word.lowercased(), aliases, definitionLines.joined(separator: "\n").trimmingCharacters(in: .newlines))
    }

    private static func stripMarkdown(_ s: String) -> String {
        s.replacingOccurrences(of: "\\*\\*(.*?)\\*\\*", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "\\*(.*?)\\*", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "__(.*?)__", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "`(.*?)`", with: "$1", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    private static func nodeInGroup(_ node: [String: Any], _ group: [String: Any]) -> Bool {
        let nx = node["x"] as? Double ?? 0, ny = node["y"] as? Double ?? 0
        let nw = node["width"] as? Double ?? 200, nh = node["height"] as? Double ?? 60
        let gx = group["x"] as? Double ?? 0, gy = group["y"] as? Double ?? 0
        let gw = group["width"] as? Double ?? 0, gh = group["height"] as? Double ?? 0
        let cx = nx + nw / 2, cy = ny + nh / 2
        return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh
    }
}
