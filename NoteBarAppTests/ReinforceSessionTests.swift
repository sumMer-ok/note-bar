import XCTest
@testable import NoteBarApp

/// 「本组不熟词强化」环节的验收用例。
/// 全部针对纯逻辑状态机，不依赖 SwiftData / SwiftUI，因此可在单测里完整驱动。
final class ReinforceSessionTests: XCTestCase {

    // MARK: - 辅助

    /// 把一段作答序列喂给会话，返回每次反馈
    @discardableResult
    private func answer(
        _ session: inout ReinforceSession<String>,
        _ decisions: [ReinforceDecision]
    ) -> [ReinforceFeedback<String>] {
        decisions.map { session.answer($0) }
    }

    // MARK: - 场景一：20 个全认识 → 跳过强化

    func testEmptyWeakSetIsFinishedImmediately() {
        // 不熟词集合为空 → 会话一建立就已结束，UI 应直接进入结果页，不出现强化界面
        var session = ReinforceSession<String>(weakWords: [])
        XCTAssertTrue(session.isFinished)
        XCTAssertNil(session.current)
        XCTAssertEqual(session.remainingCount, 0)
        XCTAssertEqual(session.round, 1)
        XCTAssertEqual(session.answer(.known).kind, .finished)
        XCTAssertFalse(session.draftSnapshot().isResumable)
    }

    // MARK: - 场景二：只呈现不熟词，且保持作答顺序

    func testWeakWordsKeepAnswerOrderAndDeduplicate() {
        let session = ReinforceSession<String>(weakWords: ["c", "a", "c", "b"])
        XCTAssertEqual(session.seed, ["c", "a", "b"], "顺序 = 正常学习阶段的作答顺序，重复项去重")
        XCTAssertEqual(session.current, "c")
        XCTAssertEqual(session.remainingCount, 3)
    }

    // MARK: - 场景三：入队顺序与循环终止条件

    func testUnknownIsRequeuedAtEndOfRoundInAnswerOrder() {
        // 第 1 轮 [a,b,c]：a 不认识、b 认识、c 不认识 → 下一轮必须是 [a,c]（按作答顺序追加）
        var session = ReinforceSession<String>(weakWords: ["a", "b", "c"])
        let feedback = answer(&session, [.unknown, .known, .unknown])
        XCTAssertEqual(feedback.map(\.kind), [.advanced, .advanced, .advanced])
        XCTAssertEqual(session.round, 2, "本轮走完后进入第 2 轮")
        XCTAssertEqual(session.currentRound, ["a", "c"])
        XCTAssertEqual(session.current, "a")
        XCTAssertEqual(session.nextRound, [], "提升为当前轮后 nextRound 必须清空")
    }

    func testFinishesOnlyWhenEveryWordIsKnown() {
        var session = ReinforceSession<String>(weakWords: ["a", "b", "c"])
        answer(&session, [.unknown, .known, .unknown])
        let feedback = answer(&session, [.known, .known])
        XCTAssertEqual(feedback.last?.kind, .finished)
        XCTAssertTrue(session.isFinished)
        XCTAssertNil(session.current)
        XCTAssertEqual(session.remainingCount, 0)
        XCTAssertEqual(session.round, 2)
        XCTAssertEqual(session.totalAnswers, 5)
    }

    func testUnknownAtEndOfRoundDoesNotFinishSession() {
        var session = ReinforceSession<String>(weakWords: ["a", "b"])
        // 本轮最后一题仍答「不认识」→ 不能误判为完成
        let feedback = answer(&session, [.known, .unknown])
        XCTAssertEqual(feedback.last?.kind, .advanced)
        XCTAssertFalse(session.isFinished)
        XCTAssertEqual(session.currentRound, ["b"])
        XCTAssertEqual(session.round, 2)
    }

    func testSingleWordRepeatsUntilKnown() {
        // 边界：整组只有 1 个不熟词且连续答错 → 每轮重新出现，直到答对
        var session = ReinforceSession<String>(weakWords: ["only"])
        let kinds = answer(&session, [.unknown, .unknown, .unknown, .known]).map(\.kind)
        XCTAssertEqual(session.round, 4)
        XCTAssertNil(session.current)
        XCTAssertTrue(session.isFinished)
        XCTAssertEqual(session.seenCount(of: "only"), 4)
        XCTAssertEqual(session.unknownCount(of: "only"), 3)
        XCTAssertEqual(kinds.last, .finished)
    }

    // MARK: - 场景三边界：全部不认识不得死循环

    func testAllUnknownHaltsAtSafetyLimitInsteadOfLoopingForever() {
        var session = ReinforceSession<String>(weakWords: ["a"], answerLimit: 6)
        var kinds: [ReinforceFeedback<String>.Kind] = []
        for _ in 0..<6 { kinds.append(session.answer(.unknown).kind) }

        XCTAssertEqual(kinds.last, .limitReached, "第 6 次作答必须回报触及上限")
        XCTAssertTrue(session.isHalted)
        XCTAssertEqual(session.totalAnswers, 6)

        // 暂停期间继续调用 answer：队列、计数、轮次全部不变
        let before = (session.currentRound, session.nextRound, session.round, session.totalAnswers)
        for _ in 0..<50 { _ = session.answer(.unknown) }
        XCTAssertEqual(session.currentRound, before.0)
        XCTAssertEqual(session.nextRound, before.1)
        XCTAssertEqual(session.round, before.2)
        XCTAssertEqual(session.totalAnswers, before.3, "暂停后不得再累加作答，避免无限循环")
        XCTAssertTrue(session.isHalted)
    }

    func testExtendLimitLetsUserContinueAfterHalting() {
        var session = ReinforceSession<String>(weakWords: ["a"], answerLimit: 3)
        answer(&session, [.unknown, .unknown, .unknown])
        XCTAssertTrue(session.isHalted)

        session.extendAnswerLimit(by: 2)
        XCTAssertFalse(session.isHalted)
        XCTAssertEqual(session.answer(.known).kind, .finished)
        XCTAssertTrue(session.isFinished)
    }

    func testPassManuallyResolvesStuckWord() {
        // 用户在「卡住了」提示里选择「标记为认识」→ 该词从两个队列中移除
        var session = ReinforceSession<String>(weakWords: ["a", "b"], answerLimit: 100)
        answer(&session, [.unknown, .unknown])
        XCTAssertEqual(session.currentRound, ["a", "b"])
        session.passManually("a")
        XCTAssertEqual(session.currentRound, ["b"])
        XCTAssertEqual(session.nextRound, [])
        session.passManually("b")
        XCTAssertTrue(session.isFinished)
    }

    // MARK: - 场景三：连续答错提示与多轮重复计数

    func testStuckHintFiresOncePerStreak() {
        var session = ReinforceSession<String>(weakWords: ["a"], answerLimit: 100)
        XCTAssertEqual(session.answer(.unknown).kind, .advanced)   // streak 1
        XCTAssertEqual(session.answer(.unknown).kind, .advanced)   // streak 2
        XCTAssertEqual(session.answer(.unknown).kind, .stuck)      // streak 3 = 阈值
        for _ in 0..<4 {
            XCTAssertEqual(session.answer(.unknown).kind, .advanced, "同一次连错内不应反复提示")
        }
    }

    func testWrongStreakResetsAfterKnown() {
        var session = ReinforceSession<String>(weakWords: ["a"], answerLimit: 100)
        answer(&session, [.unknown, .unknown])
        let feedback = session.answer(.known)
        XCTAssertEqual(feedback.kind, .finished)
        XCTAssertEqual(feedback.wrongStreak, 0)
        XCTAssertEqual(session.tally["a"]?.wrongStreak, 0)
    }

    func testPerWordCountersAccumulateAcrossRounds() {
        var session = ReinforceSession<String>(weakWords: ["a", "b"], answerLimit: 100)
        // 第 1 轮：a 错、b 对；第 2 轮：a 错；第 3 轮：a 对
        answer(&session, [.unknown, .known])
        answer(&session, [.unknown, .known])
        XCTAssertEqual(session.seenCount(of: "a"), 3, "同一单词多轮重复应累计呈现次数")
        XCTAssertEqual(session.unknownCount(of: "a"), 2)
        XCTAssertEqual(session.tally["a"]?.known, 1)
        XCTAssertEqual(session.seenCount(of: "b"), 1, "已通过的词不再出现，计数停在第 1 轮")
        XCTAssertEqual(session.totalAnswers, 4)
    }

    // MARK: - 场景四：完成后统计

    func testSummaryReportsAnswerCountAndHardestWords() {
        var session = ReinforceSession<String>(weakWords: ["a", "b"], answerLimit: 100)
        answer(&session, [.unknown, .unknown, .unknown, .known])
        let summary = session.summary
        XCTAssertEqual(summary.wordCount, 2)
        XCTAssertEqual(summary.totalAnswers, 4)
        XCTAssertEqual(summary.rounds, 3)
        XCTAssertEqual(summary.hardestWords, ["a", "b"], "按答错次数降序，a 错 2 次在前")
    }

    // MARK: - 边界：中途退出与恢复

    func testDraftRoundTripRestoresQueueRoundsAndCounters() {
        var session = ReinforceSession<String>(weakWords: ["a", "b", "c"], books: ["Words/A.canvas"], answerLimit: 100)
        answer(&session, [.unknown, .known, .unknown])

        let draft = session.draftSnapshot()
        let restored = ReinforceSession<String>(resuming: draft)
        XCTAssertNotNil(restored)
        XCTAssertEqual(restored?.currentRound, session.currentRound)
        XCTAssertEqual(restored?.round, session.round)
        XCTAssertEqual(restored?.totalAnswers, session.totalAnswers)
        XCTAssertEqual(restored?.seenCount(of: "a"), session.seenCount(of: "a"))
        XCTAssertEqual(restored?.books, ["Words/A.canvas"])
        XCTAssertEqual(draft.remainingCount, 2)

        // 恢复后继续作答，结果应与「从未退出」完全一致
        var interrupted = restored!
        var uninterrupted = session
        XCTAssertEqual(interrupted.answer(.known).kind, uninterrupted.answer(.known).kind)
        XCTAssertEqual(interrupted.answer(.known).kind, uninterrupted.answer(.known).kind)
        XCTAssertTrue(interrupted.isFinished)
        XCTAssertTrue(uninterrupted.isFinished)
    }

    func testDraftSurvivesEncodeDecode() throws {
        var session = ReinforceSession<String>(weakWords: ["a", "b"], answerLimit: 100)
        answer(&session, [.unknown, .known])
        let data = try JSONEncoder().encode(session.draftSnapshot())
        let draft = try JSONDecoder().decode(ReinforceDraft.self, from: data)
        let restored = ReinforceSession<String>(resuming: draft)
        XCTAssertEqual(restored?.currentRound, ["a"])
        XCTAssertEqual(restored?.round, 2)
        XCTAssertEqual(restored?.unknownCount(of: "a"), 1)
    }

    func testDraftIsNotResumableWhenQueueIsEmpty() {
        var done = ReinforceSession<String>(weakWords: ["a"])
        _ = done.answer(.known)
        let draft = done.draftSnapshot()
        XCTAssertFalse(draft.isResumable)
        XCTAssertNil(ReinforceSession<String>(resuming: draft), "空队列草稿不应恢复出空的强化环节")
    }

    func testRestoredDraftKeepsHaltedState() {
        // 触及上限时退出，恢复后必须仍处于暂停态，否则「全部不认识」会绕过上限继续循环
        var session = ReinforceSession<String>(weakWords: ["a"], answerLimit: 3)
        answer(&session, [.unknown, .unknown, .unknown])
        XCTAssertTrue(session.isHalted)
        var restored = ReinforceSession<String>(resuming: session.draftSnapshot())
        XCTAssertEqual(restored?.isHalted, true)
        XCTAssertEqual(restored?.answer(.unknown).kind, .limitReached)
    }

    // MARK: - 场景五（红线）：强化环节不写复习进度

    func testDraftPayloadNeverContainsStudyProgressFields() throws {
        // 强化环节只允许持久化「本环节循环判定状态」。
        // 一旦这里出现任何复习进度字段，就等于把强化判定写进了掌握度 / 下次复习时间。
        var session = ReinforceSession<String>(weakWords: ["a", "b"], answerLimit: 100)
        answer(&session, [.unknown, .known, .unknown])
        let data = try JSONEncoder().encode(session.draftSnapshot())
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        let allowed: Set<String> = [
            "weakKeys", "currentRound", "nextRound", "round", "totalAnswers",
            "tallies", "books", "answerLimit", "updatedAt",
        ]
        XCTAssertEqual(Set(payload.keys), allowed)

        let forbidden = [
            "dueDate", "lastReview", "history", "lapses", "status", "stage",
            "reps", "ef", "interval", "lifecycle", "masteredAt", "pinned", "firstLearnedDate",
        ]
        for field in forbidden {
            XCTAssertFalse(payload.keys.contains(field), "草稿不得包含复习进度字段 \(field)")
        }

        // 每个词的计数也只允许出现在本环节的四个维度上
        let tallies = try XCTUnwrap(payload["tallies"] as? [String: [String: Any]])
        XCTAssertFalse(tallies.isEmpty)
        for (_, tally) in tallies {
            XCTAssertEqual(Set(tally.keys), ["seen", "known", "unknown", "wrongStreak"])
        }
    }
}
