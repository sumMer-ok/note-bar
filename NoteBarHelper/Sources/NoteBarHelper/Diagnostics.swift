import Foundation

/// 统一日志：既写 NSLog，也追加到文件。
///
/// 为什么必须落文件：macOS 统一日志会把动态字符串标记为 `<private>`，
/// 排查「按了热键没反应」这类问题时 `log show` 读不到关键信息（本轮就因此多绕了一轮）。
/// 文件路径：~/Library/Application Support/NoteBarHelper/helper.log
public enum Diag {
    public static let logURL: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("NoteBarHelper", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("helper.log")
    }()

    public static func log(_ message: String) {
        NSLog("NoteBarHelper: %@", message)
        append("[\(timestamp())] \(message)\n")
    }

    /// 每次现建 formatter：ISO8601DateFormatter 非 Sendable，作为静态属性会被 Swift 6 并发检查拒绝
    private static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: Date())
    }

    private static func append(_ line: String) {
        guard let data = line.data(using: .utf8) else { return }
        let fm = FileManager.default

        // 简单滚动：超过 512KB 就重开，避免无限增长
        if let attrs = try? fm.attributesOfItem(atPath: logURL.path),
           let size = attrs[.size] as? Int, size > 512_000 {
            try? fm.removeItem(at: logURL)
        }

        if let handle = try? FileHandle(forWritingTo: logURL) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: logURL)
        }
    }
}
