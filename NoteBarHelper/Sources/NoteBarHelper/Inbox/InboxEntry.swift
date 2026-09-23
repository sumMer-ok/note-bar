import Foundation

/// 与插件 src/sync/inbox-types.ts 的 InboxEntry 逐字段对应（v 恒为 1）
public struct InboxEntry: Encodable {
    public struct Origin: Encodable {
        public let app: String
        public let file: String?
        public init(app: String, file: String?) { self.app = app; self.file = file }
    }

    public let v: Int
    public let id: String
    public let createdAt: String
    public let source: String
    public let word: String
    public let sentence: String?
    public let definition: String?
    public let aliases: [String]?
    public let color: String?
    public let books: [String]?
    public let origin: Origin?

    public init(
        v: Int = 1,
        id: String,
        createdAt: String,
        source: String = "wps-macos",
        word: String,
        sentence: String? = nil,
        definition: String? = nil,
        aliases: [String]? = nil,
        color: String? = nil,
        books: [String]? = nil,
        origin: Origin? = nil
    ) {
        self.v = v
        self.id = id
        self.createdAt = createdAt
        self.source = source
        self.word = word
        self.sentence = sentence
        self.definition = definition
        self.aliases = aliases
        self.color = color
        self.books = books
        self.origin = origin
    }

    public static func newId() -> String { UUID().uuidString.lowercased() }

    public static func timestamp(_ date: Date = Date()) -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fmt.string(from: date)
    }
}
