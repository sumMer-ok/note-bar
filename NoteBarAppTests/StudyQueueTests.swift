import XCTest
import SwiftData
@testable import NoteBarApp

@MainActor
final class StudyQueueTests: XCTestCase {
    private func entry(
        word: String = "apple",
        book: String = "Words/Test.canvas",
        firstLearnedDate: String? = nil,
        dueDate: String? = nil,
        status: String? = nil,
        lifecycle: String? = nil,
        addedDate: String? = nil,
        s: Double? = nil
    ) -> Entry {
        let entry = Entry(
            studyKey: "\(book):\(word)",
            book: book,
            source: book,
            nodeId: word,
            word: word,
            aliases: [],
            definition: "释义"
        )
        entry.firstLearnedDate = firstLearnedDate
        entry.dueDate = dueDate
        entry.status = status
        entry.lifecycle = lifecycle
        entry.addedDate = addedDate
        entry.s = s
        return entry
    }

    func testUnlearnedWordIsNotReviewable() {
        // 没有任何进度字段 = 桌面 studyProgress 无记录 → 新词，不在复习
        let entry = entry(firstLearnedDate: nil, dueDate: nil, s: nil)
        XCTAssertFalse(StudyQueue.isReviewable(entry, today: "2026-08-17"))
        XCTAssertTrue(StudyQueue.isLearnable(entry))
    }

    func testLearnedDueWordIsReviewable() {
        // 只要同步带来了进度（此处 dueDate）就应进入复习，与是否在手机上点过学习无关
        let entry = entry(firstLearnedDate: nil, dueDate: "2026-08-16", s: 5)
        XCTAssertTrue(StudyQueue.isReviewable(entry, today: "2026-08-17"))
        XCTAssertFalse(StudyQueue.isLearnable(entry))
    }

    func testLearnedFutureWordIsNotReviewable() {
        let entry = entry(firstLearnedDate: nil, dueDate: "2026-08-20", s: 5)
        XCTAssertFalse(StudyQueue.isReviewable(entry, today: "2026-08-17"))
    }

    func testMasteredWordIsExcluded() {
        let mastered = entry(firstLearnedDate: nil, dueDate: "2026-08-16", status: "mastered", s: 40)
        XCTAssertFalse(StudyQueue.isReviewable(mastered, today: "2026-08-17"))
        XCTAssertFalse(StudyQueue.isLearnable(mastered))

        let graduated = entry(firstLearnedDate: nil, dueDate: "2026-08-16", lifecycle: "graduated", s: 40)
        XCTAssertFalse(StudyQueue.isReviewable(graduated, today: "2026-08-17"))
    }

    func testProgressWithoutDueDateCountsAsDue() {
        // 与桌面一致：有进度但无到期日（如 learning 阶段）视为今日到期
        let learning = entry(firstLearnedDate: nil, dueDate: nil, status: "learning")
        XCTAssertTrue(StudyQueue.isReviewable(learning, today: "2026-08-17"))
    }

    func testDictationMatchFiltersByBookAndDates() {
        let dated = entry(book: "Words/A.canvas", addedDate: "2026-08-10")
        XCTAssertTrue(StudyQueue.dictationMatch(dated, books: ["Words/A.canvas"], dates: ["2026-08-10"]))
        XCTAssertFalse(StudyQueue.dictationMatch(dated, books: ["Words/B.canvas"], dates: ["2026-08-10"]))
        XCTAssertFalse(StudyQueue.dictationMatch(dated, books: ["Words/A.canvas"], dates: ["2026-08-11"]))
        XCTAssertTrue(StudyQueue.dictationMatch(dated, books: [], dates: []))

        let undated = entry(book: "Words/A.canvas", addedDate: nil)
        XCTAssertTrue(StudyQueue.dictationMatch(undated, books: ["Words/A.canvas"], dates: [StudyQueue.undatedLabel]))
    }
}
