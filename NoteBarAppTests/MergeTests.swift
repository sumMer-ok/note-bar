import XCTest
@testable import NoteBarApp

final class MergeTests: XCTestCase {
    func testLastReviewWinsAndHistoryDedup() {
        var local = StudyProgress()
        local.s = 10
        local.lastReview = "2026-08-12T00:00:00.000Z"
        local.history = [ReviewRecord(date: "2026-08-12T00:00:00.000Z", quality: "good")]

        var remote = StudyProgress()
        remote.s = 99
        remote.lastReview = "2026-08-13T00:00:00.000Z"
        remote.history = [
            ReviewRecord(date: "2026-08-12T00:00:00.000Z", quality: "good"),
            ReviewRecord(date: "2026-08-13T00:00:00.000Z", quality: "again"),
        ]

        let merged = Merge.progress(local: local, remote: remote)!
        XCTAssertEqual(merged.s, 99)
        XCTAssertEqual(merged.history?.count, 2)
        XCTAssertEqual(merged.history?.last?.quality, "again")
    }

    func testHistoryCappedAt50() {
        let a = (0..<50).map { i in
            ReviewRecord(date: ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: TimeInterval(i))), quality: "good")
        }
        let b = [ReviewRecord(date: "2026-08-14T00:00:00.000Z", quality: "hard")]
        let merged = Merge.history(a: a, b: b)!
        XCTAssertEqual(merged.count, 50)
        XCTAssertEqual(merged.last?.quality, "hard")
    }

    func testConflictCopyNaming() {
        XCTAssertTrue(Merge.isConflictCopy("英语词库 2.nb-sync.json"))
        XCTAssertEqual(Merge.conflictBaseName("英语词库 2.nb-sync.json"), "英语词库.nb-sync.json")
        XCTAssertFalse(Merge.isConflictCopy("英语词库.nb-sync.json"))
    }

    func testLegacyProgressDerivesFSRSFields() {
        // 旧插件进度：只有 interval/ef，没有 s/d
        var legacy = StudyProgress()
        legacy.status = "review"
        legacy.interval = 14
        legacy.ef = 2.5
        legacy.lastReview = "2026-08-13T09:22:23.219Z"

        let derived = legacy.withLegacyFieldsDerived()
        XCTAssertEqual(derived.s, 14)
        XCTAssertEqual(derived.d, 5.0)
        XCTAssertEqual(derived.dueDate?.prefix(10), "2026-08-27", "dueDate 应为 lastReview + interval 天")

        // 已有 s 的进度不动
        var modern = StudyProgress()
        modern.status = "review"
        modern.s = 7.7
        modern.d = 4.2
        let kept = modern.withLegacyFieldsDerived()
        XCTAssertEqual(kept.s, 7.7)
        XCTAssertEqual(kept.d, 4.2)

        // 新词不动
        var fresh = StudyProgress()
        fresh.status = "new"
        XCTAssertNil(fresh.withLegacyFieldsDerived().s)

        // mastered 直接落到毕业稳定度
        var mastered = StudyProgress()
        mastered.status = "mastered"
        mastered.interval = 30
        XCTAssertEqual(mastered.withLegacyFieldsDerived().s, 30)
    }
}
