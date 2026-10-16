package com.notebar.app.domain

import com.notebar.engine.Entry
import com.notebar.engine.ReinforceDecision
import com.notebar.engine.ReinforceDraft
import com.notebar.engine.ReinforceFeedback
import com.notebar.engine.ReinforceSession
import com.notebar.engine.ReinforceSummary
import com.notebar.engine.StudyProgress
import com.notebar.engine.draftSnapshot
import com.notebar.engine.summary

/**
 * 复习 / 学习一组卡片的完整会话状态（纯逻辑，无 Android 依赖，可 JVM 单测）。
 *
 * 逐行对应 iOS `ReviewView` 的 `@State` 集合：queue / index / flipped / preview /
 * undoStack / weakKeys / reinforce / reinforceEntries / reinforceSummary。
 *
 * 设计要点（对齐 iOS 行为，不得"优化"）：
 * - **评分与推进是两步**：`rate()` 只算分并记录撤回点，`advance()` 才推进到下一张
 *   （iOS 里 `submit` 就是 `rate(dir)` + `advance()`，两者分开调用）；
 * - 学习模式下「不认识」记入 [weakKeys]（顺序 = 作答顺序、去重），仅内存；
 * - 一组正常阶段走完且 [weakKeys] 非空时**自动进入强化环节**（仅学习模式，步骤二）；
 * - 强化环节的判定只推进内存状态机，**绝不**写进度 / 边车（红线 3）；
 * - 触及安全上限或连续答错时返回对应反馈，由 UI 弹窗让用户显式决定。
 */
class ReviewSessionState(
    val mode: ReviewMode,
    val books: Set<String>,
    initialQueue: List<Entry>,
    /** 强化环节按 studyKey 取词 */
    reinforceEntries: Map<String, Entry> = emptyMap(),
) {

    var queue: List<Entry> = initialQueue
        private set

    var index: Int = 0
        private set

    var flipped: Boolean = false
        private set

    /** 「下次 X 天后」提示；未评分时为 null */
    var preview: String? = null
        private set

    /** 本组「不认识」的词（仅学习模式记录，仅内存） */
    val weakKeys: MutableList<String> = mutableListOf()

    /** 已强化环节的会话；null = 不在强化环节 */
    var reinforce: ReinforceSession<String>? = null
        private set

    /** 强化通过后的统计，用于结束页 */
    var reinforceSummary: ReinforceSummary? = null
        private set

    /** 撤回栈：(词条, 评分前的进度) */
    private val undoStack = ArrayDeque<Pair<Entry, StudyProgress>>()

    /** 强化环节按 studyKey 取词（进入强化时建一次） */
    var reinforceEntries: Map<String, Entry> = reinforceEntries
        private set

    /** 本组已用过的 studyKey（"再学一组"时排除） */
    var usedKeys: Set<String> = initialQueue.map { it.studyKey }.toSet()
        private set

    /** 最近一次强化作答的反馈（UI 据此弹窗） */
    var lastFeedback: ReinforceFeedback<String>? = null
        private set

    val current: Entry? get() = queue.getOrNull(index)

    val isReinforcing: Boolean get() = reinforce != null

    /** 当前应呈现的卡片：强化环节取会话当前词，否则取正常队列当前项 */
    val activeCard: Entry?
        get() = reinforce?.let { session -> session.current?.let { reinforceEntries[it] } } ?: current

    val canUndo: Boolean get() = undoStack.isNotEmpty()

    /** 正常阶段是否已走完 */
    val isQueueFinished: Boolean get() = index >= queue.size

    // ------------------------------------------------------------------ 正常阶段

    /**
     * 评分。学习模式下把「不认识」记入 [weakKeys]。
     * 返回 null 表示当前没有可评分的卡片。
     */
    fun rate(
        direction: ReviewDirection,
        now: java.time.Instant = java.time.Instant.now(),
        today: java.time.LocalDate = com.notebar.engine.FSRS.today(),
    ): RatingResult? {
        val entry = current ?: return null

        // 步骤一：学习阶段记录被标记「不认识」的词（顺序 = 作答顺序）
        if (mode == ReviewMode.learn && direction == ReviewDirection.again) {
            ReviewEngine.trackWeakKey(weakKeys, entry.studyKey)
        }

        val before = entry.progress
        val outcome = ReviewEngine.rate(entry, direction, now, today)
        val next = ReviewEngine.apply(entry, outcome)

        // iOS 是用同一个 SwiftData 对象就地改字段，因此对同一张卡再次评分时
        // history 是在**上一次结果**上继续累积。Kotlin 的 data class 不可变，
        // 这里把评分结果写回队列对应位置，保证「同卡再评」的累积语义与 iOS 一致。
        if (index in queue.indices) {
            queue = queue.toMutableList().also { it[index] = next }
        }

        undoStack.addLast(entry to before)
        preview = outcome.preview
        return RatingResult(original = entry, updated = next, outcome = outcome)
    }

    /** 推进到下一张；走完后按需进入强化环节 */
    fun advance() {
        index += 1
        flipped = false
        preview = null
        maybeStartReinforce()
    }

    /** 撤回上一次评分；返回被恢复的词条与进度（无记录时返回 null） */
    fun undo(): Pair<Entry, StudyProgress>? {
        val last = undoStack.removeLastOrNull() ?: return null
        index = maxOf(0, index - 1)
        flipped = false
        preview = null
        // 把队列里的卡片也还原成评分前的词条（对应 iOS 的 `entry.progress = progress`）
        if (index in queue.indices) {
            queue = queue.toMutableList().also { it[index] = last.first }
        }
        return last
    }

    /**
     * 步骤二：正常阶段学完本组后，不熟词集合非空则自动进入强化环节。
     * 集合为空（例如 20 个全认识）→ 什么都不做，直接停在结束页。
     * **仅学习模式触发**；复习模式的「不认识」由 FSRS 调度负责，不叠加强化环节。
     */
    fun maybeStartReinforce(): Boolean {
        if (mode != ReviewMode.learn || reinforce != null || !isQueueFinished) return false

        // 过滤掉词库里已被删除 / 取不到的词，避免强化环节卡在一张取不到的卡片上
        val usable = weakKeys.filter { reinforceEntries.containsKey(it) }
        if (usable.isEmpty()) return false

        weakKeys.clear()
        weakKeys.addAll(usable)
        reinforce = ReinforceSession(weakWords = usable, books = books.toList())
        flipped = false
        preview = null
        return true
    }

    /**
     * 用最新的词条索引重建 [reinforceEntries]（每次进入或恢复强化前调用）。
     */
    fun refreshEntryIndex(entries: List<Entry>) {
        reinforceEntries = entries.associateBy { it.studyKey }
    }

    // ------------------------------------------------------------------ 强化环节

    /**
     * 强化作答。**只改内存状态机**，不写任何复习进度字段。
     *
     * @return 本次反馈；不在强化环节时返回 null
     */
    fun answerReinforce(known: Boolean): ReinforceFeedback<String>? {
        val session = reinforce ?: return null
        val feedback = session.answer(if (known) ReinforceDecision.known else ReinforceDecision.unknown)
        lastFeedback = feedback

        when (feedback.kind) {
            ReinforceFeedback.Kind.Finished -> finishReinforce()
            ReinforceFeedback.Kind.Stuck -> flipped = true
            // limitReached 保持暂停态，由 UI 弹窗让用户决定继续 / 结束
            else -> flipped = false
        }
        // finished 时 finishReinforce 已把 reinforce 置空
        if (reinforce != null && feedback.kind != ReinforceFeedback.Kind.Stuck) flipped = false
        return feedback
    }

    /** 用户显式放行某个词（卡住时使用）：移出本环节队列，不写进度 */
    fun passCurrentWordManually(): Boolean {
        val session = reinforce ?: return false
        val key = session.current ?: return false
        session.passManually(key)
        flipped = false
        if (session.isFinished) finishReinforce()
        return true
    }

    /** 触及安全上限后选择「继续强化」 */
    fun continueAfterLimit() {
        reinforce?.extendAnswerLimit()
    }

    /** 步骤四：全部标记为「认识」→ 记录统计、清空环节状态 */
    private fun finishReinforce() {
        val session = reinforce ?: return
        reinforceSummary = session.summary
        reinforce = null
        reinforceEntries = emptyMap()
        weakKeys.clear()
        flipped = false
    }

    /** 中途退出强化：保留会话以便保存草稿 */
    fun exitReinforce() {
        lastFeedback = null
    }

    // -------------------------------------------------------------- 草稿与分组

    /** 保存草稿：只包含本环节的循环判定状态（字段白名单不扩张） */
    fun draftSnapshot(now: String = com.notebar.engine.TimeIso.nowString()): ReinforceDraft? =
        reinforce?.draftSnapshot(now)

    /**
     * 正常阶段提前退出且已有不熟词时，也要落一份草稿，
     * 避免这组不熟词丢失（对应 iOS `persistDraftIfNeeded` 的第二分支）。
     */
    fun partialDraftSnapshot(now: String = com.notebar.engine.TimeIso.nowString()): ReinforceDraft? {
        if (reinforce != null) return reinforce?.draftSnapshot(now)
        if (mode != ReviewMode.learn) return null
        if (weakKeys.isEmpty() || queue.isEmpty() || !(index < queue.size)) return null
        return ReinforceSession(weakWords = weakKeys.toList(), books = books.toList()).draftSnapshot(now)
    }

    /** 从草稿恢复强化环节；草稿已无待办时返回 false（调用方回到正常流程） */
    fun restoreReinforce(draft: ReinforceDraft): Boolean {
        val session = ReinforceSession.resuming(draft) ?: return false
        weakKeys.clear()
        weakKeys.addAll(draft.weakKeys)
        reinforce = session
        flipped = false
        preview = null
        return true
    }

    /**
     * 再学一组：用同一范围重建队列，排除本组已用过的词。
     * 对应 iOS `startAnotherGroup()` → `buildQueue(excluding: usedKeys)`。
     */
    fun startAnotherGroup(all: List<Entry>, limit: Int, today: String) {
        val nextQueue = StudyScope.buildQueue(
            entries = all,
            books = books,
            mode = mode,
            limit = limit,
            today = today,
            excluded = usedKeys,
        )
        resetForNewGroup(nextQueue)
    }

    private fun resetForNewGroup(nextQueue: List<Entry>) {
        reinforce = null
        reinforceEntries = emptyMap()
        weakKeys.clear()
        reinforceSummary = null
        lastFeedback = null
        queue = nextQueue
        usedKeys = usedKeys + nextQueue.map { it.studyKey }
        index = 0
        flipped = false
        preview = null
    }
}

/** [ReviewSessionState.rate] 的产物 */
data class RatingResult(
    val original: Entry,
    val updated: Entry,
    val outcome: RatingOutcome,
)
