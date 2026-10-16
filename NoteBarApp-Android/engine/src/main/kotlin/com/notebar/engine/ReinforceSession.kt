package com.notebar.engine

import kotlinx.serialization.Serializable

/**
 * 强化环节的作答选项。
 *
 * 只区分「认识 / 不认识」两个判定，与正常学习阶段的多档 FSRS 评分解耦：
 * 强化环节的判定**不产生任何 FSRS 评分**，因此不会影响 s/d/dueDate/lastReview 等字段。
 */
@Serializable
enum class ReinforceDecision {
    known,
    unknown,
}

/**
 * 单个词在强化环节内的计数。
 * 只存在于本环节的内存状态里，**绝不写入 StudyProgress / sidecar**。
 */
@Serializable
data class ReinforceTally(
    /** 被呈现次数（跨轮累计）——同一单词多轮重复出现时用它计数 */
    val seen: Int = 0,
    /** 答「认识」的次数 */
    val known: Int = 0,
    /** 答「不认识」的次数 */
    val unknown: Int = 0,
    /** 连续答「不认识」的次数（答对即清零），用于「先看释义」提示 */
    val wrongStreak: Int = 0,
)

/** 一次作答之后会话给出的反馈，UI 据此决定下一步动作。 */
data class ReinforceFeedback<Key : Any>(
    val kind: Kind,
    /** 当前应呈现的词；finished 时为 null */
    val current: Key?,
    /** 刚作答的词是否被判「不认识」并在后续轮次重新入队 */
    val requeued: Boolean,
    /** 刚作答的词的连续答错次数 */
    val wrongStreak: Int,
) {
    enum class Kind {
        /** 正常推进到下一题 */
        Advanced,

        /** 队列已清空：本轮所有词都已被标记为「认识」 */
        Finished,

        /** 同一词连续答「不认识」达到阈值：建议先展示释义再判定（队列不变） */
        Stuck,

        /** 触及安全作答上限：必须由用户显式决定「继续 / 结束」，用于兜住「全部不认识」的死循环 */
        LimitReached,
    }
}

/**
 * 本组不熟词强化环节的状态机（纯逻辑，无框架依赖，可独立单测）。
 *
 * 队列结构（两缓冲，对应「本轮末尾重新入队」）：
 * - [currentRound]：当前轮待作答队列，队首即当前题；作答后从队首移除。
 * - [nextRound]   ：本轮被判「不认识」的词，按作答顺序追加，本轮走完后整体提升为下一轮队列。
 * - [seed]        ：进入强化时的初始不熟词集合（正常学习阶段的作答顺序），仅用于统计与草稿恢复。
 *
 * 循环终止条件：某一轮结束时 [nextRound] 为空（即本轮所有词都被判定为「认识」）。
 * 安全上限：[totalAnswers] >= [answerLimit] 时返回 [ReinforceFeedback.Kind.LimitReached]，
 * 由用户显式决定，避免无限循环。
 *
 * 逐行移植自 NoteBarApp/Engine/ReinforceSession.swift。
 */
class ReinforceSession<Key : Any>(
    weakWords: List<Key>,
    val books: List<String> = emptyList(),
    answerLimit: Int? = null,
) {
    companion object {
        /** 同一词连续答错达到该次数时给出「先看释义」提示（不改变队列，只影响 UI） */
        const val STUCK_THRESHOLD: Int = 3

        /** 安全上限的最小值，保证即便只有 1 个词也有足够额度 */
        const val MINIMUM_ANSWER_LIMIT: Int = 50

        /** 安全上限的系数：额度 = max(MINIMUM_ANSWER_LIMIT, 初始词数 × 20) */
        const val ANSWER_LIMIT_FACTOR: Int = 20

        /**
         * 从草稿恢复会话状态（计数与轮次原样恢复，保证「同一单词多轮重复出现」的计数不丢失）。
         * 队列为空的草稿返回 null。对应 iOS `ReinforceSession(resuming:)`。
         *
         * 定义在 companion 内是为了能访问 private setter —— 恢复必须原样写回
         * currentRound/nextRound/round/totalAnswers/tally，但不允许外部绕过这些 setter。
         */
        fun resuming(draft: ReinforceDraft): ReinforceSession<String>? {
            if (!draft.isResumable) return null
            val session = ReinforceSession(
                weakWords = draft.weakKeys,
                books = draft.books,
                answerLimit = draft.answerLimit,
            )
            session.currentRound = draft.currentRound.toMutableList()
            session.nextRound = draft.nextRound.toMutableList()
            session.round = draft.round
            session.totalAnswers = draft.totalAnswers
            session.tally = draft.tallies.toMutableMap()
            // 暂停态不单独持久化，按同一条规则重算，避免草稿里出现第二份真相
            session.isHalted = draft.totalAnswers >= draft.answerLimit
            return session
        }
    }

    /** 进入强化时的不熟词集合（已去重，顺序 = 正常学习阶段的作答顺序） */
    val seed: List<Key>

    /** 当前轮待作答队列（队首为当前题） */
    var currentRound: MutableList<Key> = mutableListOf()
        private set

    /** 本轮被判「不认识」的词，本轮走完后成为下一轮队列 */
    var nextRound: MutableList<Key> = mutableListOf()
        private set

    /** 已累计的作答次数（跨轮） */
    var totalAnswers: Int = 0
        private set

    /** 安全作答上限 */
    var answerLimit: Int
        private set

    /** 当前轮次，从 1 开始 */
    var round: Int = 1
        private set

    /** 每个词的计数 */
    var tally: MutableMap<Key, ReinforceTally> = mutableMapOf()
        private set

    /**
     * 是否已因触及安全上限而暂停：暂停期间 [answer] 不再消耗队列，
     * 保证「全部不认识」时本状态机在任何调用序列下都不会无限循环。
     */
    var isHalted: Boolean = false
        private set

    init {
        val deduped = ArrayList<Key>()
        val seen = HashSet<Key>()
        for (word in weakWords) {
            if (seen.add(word)) deduped.add(word)
        }
        this.seed = deduped
        this.currentRound = deduped.toMutableList()
        this.nextRound = mutableListOf()
        this.totalAnswers = 0
        this.round = 1
        this.answerLimit = answerLimit ?: maxOf(MINIMUM_ANSWER_LIMIT, deduped.size * ANSWER_LIMIT_FACTOR)
        this.tally = deduped.associateWithTo(mutableMapOf()) { ReinforceTally() }
        this.isHalted = false
    }

    // MARK: - 只读查询

    /** 当前题；全部通过时为 null */
    val current: Key? get() = currentRound.firstOrNull()

    /** 是否已全部标记为「认识」 */
    val isFinished: Boolean get() = currentRound.isEmpty() && nextRound.isEmpty()

    /** 本轮剩余题量（含当前题） */
    val roundRemainingCount: Int get() = currentRound.size

    /** 本轮之后还剩多少词（不计当前轮） */
    val queuedForNextRound: Int get() = nextRound.size

    /** 尚未通过判定的词总量 = 当前轮剩余 + 后续轮待办 */
    val remainingCount: Int get() = currentRound.size + nextRound.size

    /** 仍未通过判定的去重词数（结果页用） */
    val pendingWordCount: Int get() = (currentRound + nextRound).toSet().size

    /** 某个词被呈现过的次数（同一单词多轮重复出现的计数） */
    fun seenCount(of: Key): Int = tally[of]?.seen ?: 0

    /** 某个词答「不认识」的次数 */
    fun unknownCount(of: Key): Int = tally[of]?.unknown ?: 0

    /** 按「答错次数」降序排列的词（结果页展示本组最难词） */
    val hardestKeys: List<Key>
        get() = seed.sortedByDescending { tally[it]?.unknown ?: 0 }

    // MARK: - 作答

    /**
     * 记录一次作答并推进队列。**纯内存操作，不触碰任何复习进度字段。**
     */
    fun answer(decision: ReinforceDecision): ReinforceFeedback<Key> {
        // 已全部通过：任何后续调用都只回报完成态
        if (isFinished) {
            return ReinforceFeedback(ReinforceFeedback.Kind.Finished, null, false, 0)
        }
        // 已因安全上限暂停：不再消耗队列，必须由用户显式决定后才能继续
        if (isHalted || currentRound.isEmpty()) {
            return ReinforceFeedback(ReinforceFeedback.Kind.LimitReached, current, false, 0)
        }
        val key = currentRound.removeAt(0)
        totalAnswers += 1

        val item = tally[key] ?: ReinforceTally()
        var updated = item.copy(seen = item.seen + 1)
        var requeued = false

        when (decision) {
            ReinforceDecision.known -> {
                updated = updated.copy(known = updated.known + 1, wrongStreak = 0) // 判定通过即清零
            }

            ReinforceDecision.unknown -> {
                updated = updated.copy(unknown = updated.unknown + 1, wrongStreak = updated.wrongStreak + 1)
                nextRound.add(key) // 本轮末尾重新入队：按作答顺序追加到下一轮队尾
                requeued = true
            }
        }
        tally[key] = updated

        // 本轮走完：把下一轮队列整体提升为当前轮
        promoteNextRoundIfNeeded()

        // 终止判定优先于上限判定：最后一题答对时应当直接结束，而不是报「触及上限」
        if (isFinished) {
            return ReinforceFeedback(ReinforceFeedback.Kind.Finished, null, requeued, updated.wrongStreak)
        }
        if (totalAnswers >= answerLimit) {
            isHalted = true
            return ReinforceFeedback(ReinforceFeedback.Kind.LimitReached, current, requeued, updated.wrongStreak)
        }
        // 只在恰好达到阈值的那一次提示，避免连续答错时反复弹窗
        if (decision == ReinforceDecision.unknown && updated.wrongStreak == STUCK_THRESHOLD) {
            return ReinforceFeedback(ReinforceFeedback.Kind.Stuck, current, requeued, updated.wrongStreak)
        }
        return ReinforceFeedback(ReinforceFeedback.Kind.Advanced, current, requeued, updated.wrongStreak)
    }

    /**
     * 用户显式放行某个词（在「卡住了」或「触及上限」时使用）：
     * 把该词移出待作答队列，仅影响本环节循环，不写复习进度。
     */
    fun passManually(key: Key) {
        currentRound.removeAll { it == key }
        nextRound.removeAll { it == key }
        promoteNextRoundIfNeeded()
    }

    /** 触及安全上限后用户选择「继续强化」：追加一批额度并解除暂停 */
    fun extendAnswerLimit(by: Int? = null) {
        answerLimit += maxOf(1, by ?: maxOf(MINIMUM_ANSWER_LIMIT, seed.size * ANSWER_LIMIT_FACTOR))
        isHalted = false
    }

    /** 本轮为空且下一轮有待办时提升轮次（供外部改动队列后复用） */
    private fun promoteNextRoundIfNeeded() {
        if (currentRound.isEmpty() && nextRound.isNotEmpty()) {
            currentRound = nextRound.toMutableList()
            nextRound = mutableListOf()
            round += 1
        }
    }
}

/** 强化环节结束后的统计（仅展示用） */
data class ReinforceSummary(
    /** 进入强化时的不熟词数量 */
    val wordCount: Int,
    /** 本环节总作答次数 */
    val totalAnswers: Int,
    /** 实际经历的轮数 */
    val rounds: Int,
    /** 答错次数最多的前几个词 */
    val hardestWords: List<String>,
)

/** 供结果页展示的统计（对应 iOS `extension ReinforceSession where Key == String`） */
val ReinforceSession<String>.summary: ReinforceSummary
    get() = ReinforceSummary(
        wordCount = seed.size,
        totalAnswers = totalAnswers,
        rounds = round,
        hardestWords = hardestKeys.filter { unknownCount(it) > 0 }.take(3),
    )

/**
 * 强化环节的持久化草稿。
 *
 * 红线说明：本结构只保存**本环节的循环判定状态**，字段与 [StudyProgress] / sidecar 完全无交集，
 * 因此恢复草稿不会影响掌握度、下次复习时间、历史记录等任何原有复习进度字段。
 * 字段白名单由单测钉死（DraftPayloadNeverContainsStudyProgressFields）。
 */
@Serializable
data class ReinforceDraft(
    val weakKeys: List<String>,
    val currentRound: List<String>,
    val nextRound: List<String>,
    val round: Int,
    val totalAnswers: Int,
    val tallies: Map<String, ReinforceTally>,
    val books: List<String>,
    val answerLimit: Int,
    val updatedAt: String,
) {
    /** 草稿里还剩多少词未通过（首页入口展示用） */
    val remainingCount: Int get() = (currentRound + nextRound).toSet().size

    /** 草稿是否还有意义：队列空了就不该再让用户点进来 */
    val isResumable: Boolean get() = !(currentRound.isEmpty() && nextRound.isEmpty())
}

/** 导出可持久化的草稿快照（对应 iOS draftSnapshot(now:)） */
fun ReinforceSession<String>.draftSnapshot(now: String = TimeIso.nowString()): ReinforceDraft =
    ReinforceDraft(
        weakKeys = seed,
        currentRound = currentRound.toList(),
        nextRound = nextRound.toList(),
        round = round,
        totalAnswers = totalAnswers,
        tallies = tally.toMap(),
        books = books,
        answerLimit = answerLimit,
        updatedAt = now,
    )
