package com.notebar.engine

/**
 * 学习 / 复习队列的纯判定逻辑，供视图与单元测试复用。
 *
 * 口径与桌面插件 src/hiwords/core/flashcard-queue.ts 的 getBookReviewStats 一致：
 * - 新词 = 还没有任何学习进度的词；
 * - 到期 = 有进度、未掌握、且无到期日或到期日 <= 今天。
 *
 * 逐行移植自 NoteBarApp/Engine/StudyQueue.swift。
 */
object StudyQueue {
    const val undatedLabel: String = "无日期"

    private val masteredLifecycles: Set<String> = setOf("graduated", "archived", "retired")

    /** 已掌握（自动毕业或旧数据状态），不应再进学习/复习队列 */
    fun isMastered(entry: Entry): Boolean =
        entry.status == "mastered" || masteredLifecycles.contains(entry.lifecycle ?: "")

    /** 是否已有学习进度（对应桌面 studyProgress 中有记录；手机端任一进度字段非空） */
    fun hasStudyProgress(entry: Entry): Boolean =
        entry.status != null ||
            entry.lastReview != null ||
            entry.dueDate != null ||
            entry.s != null ||
            entry.d != null ||
            entry.lapses != null ||
            entry.history != null ||
            entry.lifecycle != null ||
            entry.pinned != null

    /** 新词：没有任何学习进度且未掌握 */
    fun isLearnable(entry: Entry): Boolean = !hasStudyProgress(entry) && !isMastered(entry)

    /** 到期复习：有进度、未掌握、无到期日或到期日 <= 今天 */
    fun isReviewable(entry: Entry, today: String): Boolean =
        hasStudyProgress(entry) &&
            !isMastered(entry) &&
            (entry.dueDate ?: "") <= today

    /** 听写筛选：词库（空集表示全部） + 添加日期（空集表示全部日期） */
    fun dictationMatch(entry: Entry, books: Set<String>, dates: Set<String>): Boolean {
        if (books.isNotEmpty() && !books.contains(entry.book)) return false
        if (dates.isEmpty()) return true
        return dates.contains(entry.addedDate ?: undatedLabel)
    }
}
