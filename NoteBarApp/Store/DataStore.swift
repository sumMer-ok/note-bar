import Foundation
import SwiftData

@Model
final class Entry {
    @Attribute(.unique) var studyKey: String
    var book: String
    var source: String
    var nodeId: String
    var word: String
    var aliases: [String]
    var definition: String
    var color: String?
    var addedDate: String?
    var s: Double?
    var d: Double?
    var lapses: Int?
    var dueDate: String?
    var lastReview: String?
    var history: [ReviewRecord]?
    var lifecycle: String?
    var pinned: Bool?
    var status: String?
    var stage: Int?
    var mastered: Bool?
    var firstLearnedDate: String?

    init(
        studyKey: String, book: String, source: String, nodeId: String,
        word: String, aliases: [String] = [], definition: String = "",
        color: String? = nil, addedDate: String? = nil, mastered: Bool? = false
    ) {
        self.studyKey = studyKey
        self.book = book
        self.source = source
        self.nodeId = nodeId
        self.word = word
        self.aliases = aliases
        self.definition = definition
        self.color = color
        self.addedDate = addedDate
        self.mastered = mastered
    }

    var progress: StudyProgress {
        get {
            var p = StudyProgress()
            p.status = status; p.stage = stage; p.s = s; p.d = d
            p.lapses = lapses; p.dueDate = dueDate; p.lastReview = lastReview
            p.history = history; p.lifecycle = lifecycle; p.pinned = pinned
            return p
        }
        set {
            status = newValue.status; stage = newValue.stage; s = newValue.s; d = newValue.d
            lapses = newValue.lapses; dueDate = newValue.dueDate; lastReview = newValue.lastReview
            history = newValue.history; lifecycle = newValue.lifecycle; pinned = newValue.pinned
        }
    }
}

extension Entry {
    /// 词库显示名：相对路径去掉目录与 .canvas 后缀
    var bookDisplayName: String {
        let base = (book as NSString).lastPathComponent
        return base.hasSuffix(".canvas") ? String(base.dropLast(".canvas".count)) : base
    }
}

@MainActor
final class DataStore {
    let context: ModelContext
    init(context: ModelContext) { self.context = context }

    func entry(forKey key: String) throws -> Entry? {
        var descriptor = FetchDescriptor<Entry>(predicate: #Predicate { $0.studyKey == key })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    func upsert(word: ParsedWord, book: String, source: String, progress: StudyProgress?) throws {
        let key = StudyKey.canvas(source: source, nodeId: word.nodeId)
        if let existing = try entry(forKey: key) {
            existing.word = word.word
            existing.aliases = word.aliases
            existing.definition = word.definition
            existing.color = word.color
            existing.addedDate = word.addedDate
            existing.mastered = word.mastered
            if let progress { existing.progress = progress }
        } else {
            let entry = Entry(studyKey: key, book: book, source: source, nodeId: word.nodeId,
                              word: word.word, aliases: word.aliases, definition: word.definition,
                              color: word.color, addedDate: word.addedDate, mastered: word.mastered)
            if let progress { entry.progress = progress }
            context.insert(entry)
        }
    }
}
