import Foundation

struct ReviewRecord: Codable, Hashable {
    var date: String
    var quality: String // again | hard | good | easy
}

/// 与插件 StudyProgressItem 逐字段对应
struct StudyProgress: Codable {
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
}

struct SidecarFile: Codable {
    var version: Int
    var book: String
    var words: [String: StudyProgress]
    var updatedAt: String
}
