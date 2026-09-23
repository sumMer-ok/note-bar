import Foundation

public enum SelectionSource: String {
    case accessibility = "ax"
    case clipboard = "clipboard"
}

public struct SelectionResult {
    public let text: String
    public let source: SelectionSource
}

public protocol TextAcquirer {
    var source: SelectionSource { get }
    func acquire() -> String?
}

/// Task 4 的兜底取词器在 Task 5 里作为策略链的一环使用；
/// 计划未在其类声明上写出 conformance，这里补上（无行为改动）。
extension ClipboardSelectionAcquirer: TextAcquirer {
    public var source: SelectionSource { .clipboard }
}

/// 三级取词策略的编排：按顺序尝试，取到即用，全失败返回 nil。
/// 第三级（JSA 宏上报）留给后续任务，只需再实现一个 TextAcquirer 追加进来。
public final class SelectionService {
    private let acquirers: [TextAcquirer]

    public init(_ acquirers: [TextAcquirer]) {
        self.acquirers = acquirers
    }

    public convenience init() {
        self.init([
            AXSelectionAcquirer(),
            ClipboardSelectionAcquirer(pasteboard: SystemPasteboard(), keys: SystemKeyEventPoster()),
        ])
    }

    public func acquire() -> SelectionResult? {
        for acquirer in acquirers {
            guard let raw = acquirer.acquire() else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            return SelectionResult(text: trimmed, source: acquirer.source)
        }
        return nil
    }
}
