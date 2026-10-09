import Foundation

/// 强化环节的作答选项。
/// 只区分「认识 / 不认识」两个判定，与正常学习阶段的多档 FSRS 评分解耦：
/// 强化环节的判定**不产生任何 FSRS 评分**，因此不会影响 s/d/dueDate/lastReview 等字段。
enum ReinforceDecision: String, Codable {
    case known
    case unknown
}

/// 单个词在强化环节内的计数。
/// 只存在于本环节的内存状态里，**绝不写入 StudyProgress / sidecar**。
struct ReinforceTally: Codable, Equatable {
    /// 被呈现次数（跨轮累计）——同一单词多轮重复出现时用它计数
    var seen: Int = 0
    /// 答「认识」的次数
    var known: Int = 0
    /// 答「不认识」的次数
    var unknown: Int = 0
    /// 连续答「不认识」的次数（答对即清零），用于「先看释义」提示
    var wrongStreak: Int = 0
}

/// 一次作答之后会话给出的反馈，UI 据此决定下一步动作。
struct ReinforceFeedback<Key: Hashable>: Equatable {
    enum Kind: Equatable {
        /// 正常推进到下一题
        case advanced
        /// 队列已清空：本轮所有词都已被标记为「认识」
        case finished
        /// 同一词连续答「不认识」达到阈值：建议先展示释义再判定（队列不变）
        case stuck
        /// 触及安全作答上限：必须由用户显式决定「继续 / 结束」，用于兜住「全部不认识」的死循环
        case limitReached
    }

    let kind: Kind
    /// 当前应呈现的词；finished 时为 nil
    let current: Key?
    /// 刚作答的词是否被判「不认识」并在后续轮次重新入队
    let requeued: Bool
    /// 刚作答的词的连续答错次数
    let wrongStreak: Int
}

/// 本组不熟词强化环节的状态机（纯逻辑，无 SwiftData / SwiftUI 依赖，可独立单测）。
///
/// 队列结构（两缓冲，对应「本轮末尾重新入队」）：
/// - `currentRound`：当前轮待作答队列，队首即当前题；作答后从队首移除。
/// - `nextRound`   ：本轮被判「不认识」的词，按作答顺序追加，本轮走完后整体提升为下一轮队列。
/// - `seed`        ：进入强化时的初始不熟词集合（正常学习阶段的作答顺序），仅用于统计与草稿恢复。
///
/// 循环终止条件：某一轮结束时 `nextRound` 为空（即本轮所有词都被判定为「认识」）。
/// 安全上限：`totalAnswers >= answerLimit` 时返回 `.limitReached`，由用户显式决定，避免无限循环。
struct ReinforceSession<Key: Hashable & Codable>: Codable {

    // MARK: - 可调参数

    /// 同一词连续答错达到该次数时给出「先看释义」提示（不改变队列，只影响 UI）
    static var stuckThreshold: Int { 3 }

    /// 安全上限的最小值，保证即便只有 1 个词也有足够额度
    static var minimumAnswerLimit: Int { 50 }

    /// 安全上限的系数：额度 = max(minimumAnswerLimit, 初始词数 × 20)
    static var answerLimitFactor: Int { 20 }

    // MARK: - 状态

    /// 进入强化时的不熟词集合（已去重，顺序 = 正常学习阶段的作答顺序）
    private(set) var seed: [Key]
    /// 当前轮待作答队列（队首为当前题）
    private(set) var currentRound: [Key]
    /// 本轮被判「不认识」的词，本轮走完后成为下一轮队列
    private(set) var nextRound: [Key]
    /// 已累计的作答次数（跨轮）
    private(set) var totalAnswers: Int
    /// 安全作答上限
    private(set) var answerLimit: Int
    /// 当前轮次，从 1 开始
    private(set) var round: Int
    /// 每个词的计数
    private(set) var tally: [Key: ReinforceTally]
    /// 本组词来自哪些词库（仅用于恢复草稿时保持取词范围）
    private(set) var books: [String]
    /// 是否已因触及安全上限而暂停：暂停期间 `answer` 不再消耗队列，
    /// 保证「全部不认识」时本状态机在任何调用序列下都不会无限循环。
    private(set) var isHalted: Bool

    // MARK: - 初始化

    /// - Parameters:
    ///   - weakWords: 正常学习阶段被标记「不认识」的词，顺序即作答顺序；重复项会被去重
    ///   - books: 本组词库范围（仅用于草稿恢复）
    ///   - answerLimit: 覆盖默认安全上限，测试用
    init(weakWords: [Key], books: [String] = [], answerLimit: Int? = nil) {
        var deduped: [Key] = []
        var seen = Set<Key>()
        for word in weakWords where !seen.contains(word) {
            seen.insert(word)
            deduped.append(word)
        }

        self.seed = deduped
        self.currentRound = deduped
        self.nextRound = []
        self.totalAnswers = 0
        self.round = 1
        self.books = books
        self.answerLimit = answerLimit ?? max(Self.minimumAnswerLimit, deduped.count * Self.answerLimitFactor)
        self.tally = Dictionary(uniqueKeysWithValues: deduped.map { ($0, ReinforceTally()) })
        self.isHalted = false
    }

    // MARK: - 只读查询

    /// 当前题；全部通过时为 nil
    var current: Key? { currentRound.first }

    /// 是否已全部标记为「认识」
    var isFinished: Bool { currentRound.isEmpty && nextRound.isEmpty }

    /// 本轮剩余题量（含当前题）
    var roundRemainingCount: Int { currentRound.count }

    /// 本轮之后还剩多少词（不计当前轮）
    var queuedForNextRound: Int { nextRound.count }

    /// 尚未通过判定的词总量 = 当前轮剩余 + 后续轮待办
    var remainingCount: Int { currentRound.count + nextRound.count }

    /// 仍未通过判定的去重词数（结果页用）
    var pendingWordCount: Int {
        Set(currentRound + nextRound).count
    }

    /// 某个词被呈现过的次数（同一单词多轮重复出现的计数）
    func seenCount(of key: Key) -> Int { tally[key]?.seen ?? 0 }

    /// 某个词答「不认识」的次数
    func unknownCount(of key: Key) -> Int { tally[key]?.unknown ?? 0 }

    /// 按「答错次数」降序排列的词（结果页展示本组最难词）
    var hardestKeys: [Key] {
        seed.sorted { (tally[$0]?.unknown ?? 0) > (tally[$1]?.unknown ?? 0) }
    }

    // MARK: - 作答

    /// 记录一次作答并推进队列。**纯内存操作，不触碰任何复习进度字段。**
    mutating func answer(_ decision: ReinforceDecision) -> ReinforceFeedback<Key> {
        // 已全部通过：任何后续调用都只回报完成态
        if isFinished {
            return ReinforceFeedback(kind: .finished, current: nil, requeued: false, wrongStreak: 0)
        }
        // 已因安全上限暂停：不再消耗队列，必须由用户显式决定后才能继续
        guard !isHalted, let key = currentRound.first else {
            return ReinforceFeedback(kind: .limitReached, current: current, requeued: false, wrongStreak: 0)
        }
        currentRound.removeFirst()
        totalAnswers += 1

        var item = tally[key] ?? ReinforceTally()
        item.seen += 1
        var requeued = false

        switch decision {
        case .known:
            item.known += 1
            item.wrongStreak = 0          // 判定通过即清零，该词本轮出队
        case .unknown:
            item.unknown += 1
            item.wrongStreak += 1
            nextRound.append(key)          // 本轮末尾重新入队：按作答顺序追加到下一轮队尾
            requeued = true
        }
        tally[key] = item

        // 本轮走完：把下一轮队列整体提升为当前轮
        if currentRound.isEmpty && !nextRound.isEmpty {
            currentRound = nextRound
            nextRound = []
            round += 1
        }

        // 终止判定优先于上限判定：最后一题答对时应当直接结束，而不是报「触及上限」
        if isFinished {
            return ReinforceFeedback(kind: .finished, current: nil, requeued: requeued, wrongStreak: item.wrongStreak)
        }
        if totalAnswers >= answerLimit {
            isHalted = true
            return ReinforceFeedback(kind: .limitReached, current: current, requeued: requeued, wrongStreak: item.wrongStreak)
        }
        // 只在恰好达到阈值的那一次提示，避免连续答错时反复弹窗
        if decision == .unknown && item.wrongStreak == Self.stuckThreshold {
            return ReinforceFeedback(kind: .stuck, current: current, requeued: requeued, wrongStreak: item.wrongStreak)
        }
        return ReinforceFeedback(kind: .advanced, current: current, requeued: requeued, wrongStreak: item.wrongStreak)
    }

    /// 用户显式放行某个词（在「卡住了」或「触及上限」时使用）：
    /// 把该词移出待作答队列，仅影响本环节循环，不写复习进度。
    mutating func passManually(_ key: Key) {
        currentRound.removeAll { $0 == key }
        nextRound.removeAll { $0 == key }
        promoteNextRoundIfNeeded()
    }

    /// 触及安全上限后用户选择「继续强化」：追加一批额度并解除暂停
    mutating func extendAnswerLimit(by extra: Int? = nil) {
        answerLimit += max(1, extra ?? max(Self.minimumAnswerLimit, seed.count * Self.answerLimitFactor))
        isHalted = false
    }

    /// 本轮为空且下一轮有待办时提升轮次（供外部改动队列后复用）
    private mutating func promoteNextRoundIfNeeded() {
        if currentRound.isEmpty && !nextRound.isEmpty {
            currentRound = nextRound
            nextRound = []
            round += 1
        }
    }
}

/// 强化环节结束后的统计（仅展示用）
struct ReinforceSummary: Equatable, Codable {
    /// 进入强化时的不熟词数量
    var wordCount: Int
    /// 本环节总作答次数
    var totalAnswers: Int
    /// 实际经历的轮数
    var rounds: Int
    /// 答错次数最多的前几个词
    var hardestWords: [String]
}

extension ReinforceSession where Key == String {
    /// 供结果页展示的统计
    var summary: ReinforceSummary {
        ReinforceSummary(
            wordCount: seed.count,
            totalAnswers: totalAnswers,
            rounds: round,
            hardestWords: Array(hardestKeys.filter { unknownCount(of: $0) > 0 }.prefix(3))
        )
    }

    /// 导出可持久化的草稿快照
    func draftSnapshot(now: Date = Date()) -> ReinforceDraft {
        ReinforceDraft(
            weakKeys: seed,
            currentRound: currentRound,
            nextRound: nextRound,
            round: round,
            totalAnswers: totalAnswers,
            tallies: tally,
            books: books,
            answerLimit: answerLimit,
            updatedAt: ISO8601DateFormatter().string(from: now)
        )
    }
}

/// 强化环节的持久化草稿。
///
/// 红线说明：本结构只保存**本环节的循环判定状态**，字段与 `StudyProgress` / sidecar 完全无交集，
/// 因此恢复草稿不会影响掌握度、下次复习时间、历史记录等任何原有复习进度字段。
struct ReinforceDraft: Codable, Equatable {
    var weakKeys: [String]
    var currentRound: [String]
    var nextRound: [String]
    var round: Int
    var totalAnswers: Int
    var tallies: [String: ReinforceTally]
    var books: [String]
    var answerLimit: Int
    var updatedAt: String

    /// 草稿里还剩多少词未通过（首页入口展示用）
    var remainingCount: Int { Set(currentRound + nextRound).count }

    /// 草稿是否还有意义：队列空了就不该再让用户点进来
    var isResumable: Bool { !(currentRound.isEmpty && nextRound.isEmpty) }
}

extension ReinforceSession where Key == String {
    /// 从草稿恢复会话状态（计数与轮次原样恢复，保证「同一单词多轮重复出现」的计数不丢失）
    init?(resuming draft: ReinforceDraft) {
        guard draft.isResumable else { return nil }
        self.init(weakWords: draft.weakKeys, books: draft.books, answerLimit: draft.answerLimit)
        self.currentRound = draft.currentRound
        self.nextRound = draft.nextRound
        self.round = draft.round
        self.totalAnswers = draft.totalAnswers
        self.tally = draft.tallies
        // 暂停态不单独持久化，按同一条规则重算，避免草稿里出现第二份真相
        self.isHalted = draft.totalAnswers >= draft.answerLimit
    }
}
