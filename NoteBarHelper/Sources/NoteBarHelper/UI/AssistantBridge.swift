import Foundation

public struct AssistantFormPayload {
    public let word: String
    public let sentence: String?
    public let definition: String?
    public let aliases: [String]
    public let color: String?
    public let books: [String]
}

/// JS 桥收到的消息；解析失败一律返回 nil（宁可无操作，不写脏数据）
public enum AssistantMessage {
    case submit(AssistantFormPayload)
    case cancel

    /// 页面就绪信号：只用于对齐加载时序，**绝不能转发给上层**——
    /// 上层收到任何消息都会关闭面板，一旦转发就会「弹窗一闪而过」。
    public static func isReadySignal(body: Any) -> Bool {
        guard let dict = body as? [String: Any] else { return false }
        return dict["action"] as? String == "ready"
    }

    public init?(body: Any, fallbackWord: String, fallbackSentence: String?) {
        guard let dict = body as? [String: Any], let action = dict["action"] as? String else { return nil }
        if action == "cancel" { self = .cancel; return }

        let books = (dict["books"] as? [String]) ?? []
        let aliasesRaw = (dict["aliases"] as? String) ?? ""
        let aliases = aliasesRaw
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let definition = (dict["definition"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let colorRaw = (dict["color"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sentence = (dict["sentence"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

        self = .submit(AssistantFormPayload(
            word: fallbackWord,
            sentence: (sentence?.isEmpty == false) ? sentence : fallbackSentence,
            definition: (definition?.isEmpty == false) ? definition : nil,
            aliases: aliases,
            color: (colorRaw?.isEmpty == false) ? colorRaw : nil,
            books: books
        ))
    }
}
