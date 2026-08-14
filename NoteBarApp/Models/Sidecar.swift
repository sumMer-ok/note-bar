import Foundation

struct ReviewRecord: Codable, Hashable, Sendable {
    var date: String
    var quality: String // again | hard | good | easy
}

/// 与插件 StudyProgressItem 逐字段对应
struct StudyProgress: Codable, Equatable, Sendable {
    var status: String? // new | learning | review | mastered
    var stage: Int?
    var reps: Int?
    var ef: Double?
    var interval: Int?
    var s: Double?
    var d: Double?
    var lapses: Int?
    var dueDate: String?
    var lastReview: String?
    var history: [ReviewRecord]?
    var lifecycle: String? // active | graduated | archived | retired
    var pinned: Bool?
    var masteredAt: String?
    var updatedAt: String?

    init() {}

    /// 兼容旧插件数据：旧进度只有 interval/ef/stage，没有 FSRS 的 s/d。
    /// 在本 App 的 FSRS 参数下 interval≈s，据此补齐 s、d 与缺失的 dueDate，
    /// 让已学过的词正确落入熟练度分组与复习队列，而不是被当成「新词」。
    func withLegacyFieldsDerived() -> StudyProgress {
        var p = self
        guard p.s == nil, let status = p.status, status != "new" else { return p }

        if status == "mastered" {
            p.s = 30
        } else if let interval = p.interval, interval > 0 {
            p.s = Double(interval)
        } else {
            p.s = 1.0
        }
        if p.d == nil { p.d = 5.0 }

        if p.dueDate == nil, let last = p.lastReview,
           let date = Self.parseDate(last) {
            let days = max(1, p.interval ?? 1)
            if let due = Calendar.current.date(byAdding: .day, value: days, to: FSRS.startOfDay(date)) {
                p.dueDate = FSRS.dayString(due)
            }
        }
        return p
    }

    private static func parseDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}

struct SidecarFile: Codable, Sendable {
    var version: Int
    var book: String
    var words: [String: StudyProgress]
    var updatedAt: String
}
