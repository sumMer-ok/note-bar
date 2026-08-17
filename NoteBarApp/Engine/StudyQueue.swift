import Foundation

/// 学习 / 复习队列的纯判定逻辑，供视图与单元测试复用。
/// 语义与参考实现（kirill-markin/flashcards-open-source-app）一致：
/// 未经过手机端首次评分的词视为「新词」，只有首次评分后才进入复习候选。
enum StudyQueue {
    static let undatedLabel = "无日期"
    private static let masteredLifecycles: Set<String> = ["graduated", "archived", "retired"]

    /// 已掌握（自动毕业或旧数据状态），不应再进学习/复习队列
    static func isMastered(_ entry: Entry) -> Bool {
        entry.status == "mastered" || masteredLifecycles.contains(entry.lifecycle ?? "")
    }

    /// 手机本地尚未开始学习（firstLearnedDate 只在手机端首次评分时写入）
    static func isLearnable(_ entry: Entry) -> Bool {
        entry.firstLearnedDate == nil && !isMastered(entry)
    }

    /// 手机本地已开始学习且已到期，且未掌握
    static func isReviewable(_ entry: Entry, today: String) -> Bool {
        entry.firstLearnedDate != nil
            && (entry.dueDate ?? "") <= today
            && !isMastered(entry)
    }

    /// 听写筛选：词库（可空表示全部） + 添加日期（可空表示全部日期）
    static func dictationMatch(_ entry: Entry, books: Set<String>, dates: Set<String>) -> Bool {
        guard books.isEmpty || books.contains(entry.book) else { return false }
        guard !dates.isEmpty else { return true }
        return dates.contains(entry.addedDate ?? undatedLabel)
    }
}
