import Foundation

public enum InboxWriterError: Error {
    case encodeFailed
    case openFailed(String)
}

public enum InboxWriter {
    public static let inboxFileName = "note-bar-inbox.jsonl"

    /// 单行 JSON，不含内嵌换行；插件按行解析
    public static func encodeLine(_ entry: InboxEntry) throws -> String {
        let encoder = JSONEncoder()
        // .sortedKeys：JSONEncoder 默认不保证键序；键序漂移会让提交进仓库的契约样本每次跑测试都变脏
        encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        guard let data = try? encoder.encode(entry),
              var line = String(data: data, encoding: .utf8) else {
            throw InboxWriterError.encodeFailed
        }
        line = line.replacingOccurrences(of: "\n", with: " ")
        line = line.replacingOccurrences(of: "\r", with: " ")
        return line
    }

    /// 追加写（O_APPEND），绝不重写整个文件；目录不存在则创建
    @discardableResult
    public static func append(_ entry: InboxEntry, inboxDir: String) throws -> URL {
        let dir = URL(fileURLWithPath: inboxDir, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(inboxFileName)

        if !FileManager.default.fileExists(atPath: file.path) {
            FileManager.default.createFile(atPath: file.path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: file.path) else {
            throw InboxWriterError.openFailed(file.path)
        }
        defer { try? handle.close() }
        try handle.seekToEnd()
        let payload = (try encodeLine(entry)) + "\n"
        try handle.write(contentsOf: Data(payload.utf8))
        try handle.synchronize()
        return file
    }
}
