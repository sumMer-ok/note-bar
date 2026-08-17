import Foundation

/// 学习 / 复习队列的纯判定逻辑，供视图与单元测试复用。
/// 口径与桌面插件 src/hiwords/core/flashcard-queue.ts 的 getBookReviewStats 一致：
/// - 新词 = 还没有任何学习进度的词；
/// - 到期 = 有进度、未掌握、且无到期日或到期日 <= 今天。
enum StudyQueue {
    static let undatedLabel = "无日期"
    private static let masteredLifecycles: Set<String> = ["graduated", "archived", "retired"]

    /// 已掌握（自动毕业或旧数据状态），不应再进学习/复习队列
    static func isMastered(_ entry: Entry) -> Bool {
        entry.status == "mastered" || masteredLifecycles.contains(entry.lifecycle ?? "")
    }

    /// 是否已有学习进度（对应桌面 studyProgress 中有记录；手机端任一进度字段非空）
    static func hasStudyProgress(_ entry: Entry) -> Bool {
        entry.status != nil
            || entry.lastReview != nil
            || entry.dueDate != nil
            || entry.s != nil
            || entry.d != nil
            || entry.lapses != nil
            || entry.history != nil
            || entry.lifecycle != nil
            || entry.pinned != nil
    }

    /// 新词：没有任何学习进度且未掌握
    static func isLearnable(_ entry: Entry) -> Bool {
        !hasStudyProgress(entry) && !isMastered(entry)
    }

    /// 到期复习：有进度、未掌握、无到期日或到期日 <= 今天
    static func isReviewable(_ entry: Entry, today: String) -> Bool {
        hasStudyProgress(entry)
            && !isMastered(entry)
            && (entry.dueDate ?? "") <= today
    }

    /// 听写筛选：词库（可空表示全部） + 添加日期（可空表示全部日期）
    static func dictationMatch(_ entry: Entry, books: Set<String>, dates: Set<String>) -> Bool {
        guard books.isEmpty || books.contains(entry.book) else { return false }
        guard !dates.isEmpty else { return true }
        return dates.contains(entry.addedDate ?? undatedLabel)
    }
}
