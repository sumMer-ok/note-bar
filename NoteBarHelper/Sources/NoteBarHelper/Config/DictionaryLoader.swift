import Foundation

/// 中文词典里的一条词条（字段与插件 `LocalDictionaryService` 读到的完全一致）
public struct DictionaryEntry: Equatable, Sendable {
    public let phonetic: String?
    public let definitions: [String]
    public let aliases: [String]

    public init(phonetic: String?, definitions: [String], aliases: [String]) {
        self.phonetic = phonetic
        self.definitions = definitions
        self.aliases = aliases
    }

    public init?(json: JSONValue) {
        guard let dict = json.objectValue else { return nil }
        let phonetic = DictionaryEntry.normalized(dict["p"]?.stringValue)
        let definitions = DictionaryEntry.stringList(dict["d"])
        let aliases = DictionaryEntry.stringList(dict["a"])
        if phonetic == nil, definitions.isEmpty, aliases.isEmpty { return nil }
        self.init(phonetic: phonetic, definitions: definitions, aliases: aliases)
    }

    private static func normalized(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    /// 容忍 `d` / `a` 被写成单个字符串的脏数据
    static func stringList(_ value: JSONValue?) -> [String] {
        switch value {
        case .array(let items):
            return items.compactMap { normalized($0.stringValue) }
        case .string(let single):
            return normalized(single).map { [$0] } ?? []
        default:
            return []
        }
    }
}

/// 查词结果：命中 / 明确未命中 / 文件不可用（原因写给日志）
public enum DictionaryLookup: Equatable, Sendable {
    case found(DictionaryEntry)
    case wordMissing
    case fileUnavailable(String)
}

/// 流式读取词典 JSON 并定位单个词条。
///
/// 为什么必须流式：真实 vault 的 `dictionary.json` 实测 363MB，整文件 `JSONSerialization`
/// 会先把它整个读进内存再建对象图，常驻菜单栏的助手不该为此吃掉几个 GB。
/// 这里按块读文件，在缓冲区里做「顶层字符串键匹配 + 括号配平」，命中后只解析那一个对象的文本。
///
/// 设计取舍：缓冲区只追加、不裁剪。因为只找一个键、且不需要记录「扫描到哪」的状态机，
/// 移动数据带来的正确性风险（键或字符串被切在保留边界上）远大于收益；峰值内存 = 词条前的字节数。
public struct DictionaryWordReader {
    public enum Step: Equatable {
        case moreData
        case notFound
        case found(DictionaryEntry)
        case malformed
    }

    private let key: String
    public let chunkSize: Int
    private var buffer: [UInt8] = []
    /// 已扫描到的下标（块边界处从字面量中间返回时会回退一个字符，见 `keyOffset` 的注释）
    private var consumed = 0

    public init(key: String, chunkSize: Int = 1 << 20) {
        self.key = key
        self.chunkSize = max(chunkSize, 1)
    }

    /// 喂入下一块数据；返回 `.moreData` 表示还需要继续读文件
    public mutating func consume(_ chunk: [UInt8]) -> Step {
        buffer.append(contentsOf: chunk)
        return scan(final: false)
    }

    /// 文件读完后调用（处理最后一块里可能存在的命中）
    public mutating func finish() -> Step {
        scan(final: true)
    }

    private mutating func scan(final: Bool) -> Step {
        guard let offset = keyOffset() else { return final ? .notFound : .moreData }
        guard let colon = skipWhitespace(from: offset) else { return .moreData }
        guard buffer[colon] == 0x3A else { return .malformed }            // ':'
        guard let brace = skipWhitespace(from: colon + 1) else { return .moreData }
        guard buffer[brace] == 0x7B else { return .malformed }            // '{'
        guard let end = objectEnd(from: brace) else { return .moreData }
        let text = String(decoding: buffer[brace..<end], as: UTF8.self)
        buffer.removeAll(keepingCapacity: false)
        guard let value = JSONValue(jsonString: text), let entry = DictionaryEntry(json: value) else {
            return .malformed
        }
        return .found(entry)
    }

    /// 找到与目标键等价的 JSON 字符串字面量（顶层键都带引号，其前一个非空白字符须为 `,` 或 `{`）。
    /// 从 `consumed` 继续，避免每读一块就把整个缓冲区重扫一遍（词典实测 363MB）。
    private mutating func keyOffset() -> Int? {
        var index = consumed
        var previousSignificant: UInt8 = 0x7B          // 首次调用视作文件以 '{' 开头
        while index < buffer.count {
            let byte = buffer[index]
            guard byte == 0x22 else {                        // '"'
                if !isWhitespace(byte) { previousSignificant = byte }
                index += 1
                continue
            }
            guard let (decoded, next) = decodeStringLiteral(at: index) else {
                // 字面量被切在块边界上：退回到这个 `"`，下块再从它开始
                consumed = index
                return nil
            }
            if decoded == key, previousSignificant == 0x2C || previousSignificant == 0x7B {
                return next
            }
            previousSignificant = 0x22
            index = next
        }
        consumed = index
        return nil
    }

    /// 解码 `"` 起的 JSON 字符串字面量；被截断（缓冲区里还没有收尾引号）时返回 nil
    private func decodeStringLiteral(at start: Int) -> (String, Int)? {
        var bytes: [UInt8] = []
        var index = start + 1
        while index < buffer.count {
            let byte = buffer[index]
            if byte == 0x22 { return (String(decoding: bytes, as: UTF8.self), index + 1) }
            if byte == 0x5C {                              // '\'
                guard index + 1 < buffer.count else { return nil }
                let escaped = buffer[index + 1]
                switch escaped {
                case 0x22, 0x5C, 0x2F: bytes.append(escaped)
                case 0x62: bytes.append(0x08)
                case 0x66: bytes.append(0x0C)
                case 0x6E: bytes.append(0x0A)
                case 0x72: bytes.append(0x0D)
                case 0x74: bytes.append(0x09)
                default: bytes.append(escaped)             // \uXXXX 等：按字面保留，够用于比较
                }
                index += 2
                continue
            }
            bytes.append(byte)
            index += 1
        }
        return nil
    }

    private func skipWhitespace(from index: Int) -> Int? {
        var cursor = index
        while cursor < buffer.count, isWhitespace(buffer[cursor]) { cursor += 1 }
        return cursor < buffer.count ? cursor : nil
    }

    /// 从 `{` 起按括号配平找对象结束位置（忽略字符串内的括号）；未读完返回 nil
    private func objectEnd(from start: Int) -> Int? {
        var depth = 0
        var index = start
        var inString = false
        var escaped = false
        while index < buffer.count {
            let byte = buffer[index]
            if inString {
                if escaped {
                    escaped = false
                } else if byte == 0x5C {
                    escaped = true
                } else if byte == 0x22 {
                    inString = false
                }
            } else {
                switch byte {
                case 0x22: inString = true
                case 0x7B, 0x5B: depth += 1                 // '{' '['
                case 0x7D, 0x5D:                            // '}' ']'
                    depth -= 1
                    if depth == 0 { return index + 1 }
                    if depth < 0 { return nil }
                default: break
                }
            }
            index += 1
        }
        return nil
    }

    private func isWhitespace(_ byte: UInt8) -> Bool {
        byte == 0x20 || byte == 0x0A || byte == 0x0D || byte == 0x09
    }
}

public enum DictionaryLookupError: Error, CustomStringConvertible {
    case cannotOpen(String)
    case readFailed(String)

    public var description: String {
        switch self {
        case .cannotOpen(let path): return "无法打开词典文件：\(path)"
        case .readFailed(let reason): return "读取词典文件失败：\(reason)"
        }
    }
}

/// 查词：小写键优先；未命中再按原样（trim 后）键找一次。两种键都未命中返回 `.wordMissing`。
public func lookupDictionaryEntry(inFileAt path: String, word: String) throws -> DictionaryLookup {
    let trimmed = word.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return .wordMissing }
    var keys: [String] = [trimmed.lowercased()]
    if trimmed != trimmed.lowercased() { keys.append(trimmed) }

    var lastMissing: DictionaryLookup = .wordMissing
    for key in keys {
        switch try scanFile(at: path, key: key) {
        case .found(let entry): return .found(entry)
        case .wordMissing: continue
        case .fileUnavailable(let reason): lastMissing = .fileUnavailable(reason)
        }
    }
    return lastMissing
}

private func scanFile(at path: String, key: String) throws -> DictionaryLookup {
    guard let stream = InputStream(fileAtPath: path) else {
        return .fileUnavailable(DictionaryLookupError.cannotOpen(path).description)
    }
    stream.open()
    defer { stream.close() }
    guard stream.streamStatus != .error else {
        return .fileUnavailable("词典文件不存在或无法读取：\(path)")
    }

    var reader = DictionaryWordReader(key: key)
    var chunk = [UInt8](repeating: 0, count: reader.chunkSize)
    while true {
        let read = stream.read(&chunk, maxLength: chunk.count)
        if read < 0 {
            return .fileUnavailable(DictionaryLookupError
                .readFailed(stream.streamError?.localizedDescription ?? "未知错误").description)
        }
        if read == 0 { break }
        switch reader.consume(Array(chunk[0..<read])) {
        case .moreData: continue
        case .notFound: break
        case .found(let entry): return .found(entry)
        case .malformed: return .fileUnavailable("词典文件中该词的条目无法解析：\(key)")
        }
        break
    }
    switch reader.finish() {
    case .found(let entry): return .found(entry)
    case .malformed: return .fileUnavailable("词典文件中该词的条目无法解析：\(key)")
    case .notFound, .moreData: return .wordMissing
    }
}
