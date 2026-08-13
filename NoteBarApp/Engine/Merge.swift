import Foundation

enum Merge {
    static let historyLimit = 50

    static func timeOf(_ value: String?) -> Double {
        guard let value else { return 0 }
        return ISO8601DateFormatter().date(from: value)?.timeIntervalSince1970 ?? 0
    }

    static func history(a: [ReviewRecord]?, b: [ReviewRecord]?) -> [ReviewRecord]? {
        var map: [String: ReviewRecord] = [:]
        for record in (a ?? []) + (b ?? []) {
            let key = "\(record.date)|\(record.quality)"
            if let existing = map[key] {
                if timeOf(record.date) >= timeOf(existing.date) { map[key] = record }
            } else {
                map[key] = record
            }
        }
        let sorted = map.values.sorted { timeOf($0.date) < timeOf($1.date) }
        return sorted.isEmpty ? nil : Array(sorted.suffix(historyLimit))
    }

    /// lastReview 较新者胜；history 去重合并
    static func progress(local: StudyProgress?, remote: StudyProgress?) -> StudyProgress? {
        guard let local else { return remote }
        guard let remote else { return local }
        let remoteWins = timeOf(remote.lastReview) > timeOf(local.lastReview)
        let winner = remoteWins ? remote : local
        let loser = remoteWins ? local : remote

        var merged = loser
        if let s = winner.s { merged.s = s }
        if let d = winner.d { merged.d = d }
        merged.status = winner.status ?? loser.status
        merged.stage = winner.stage ?? loser.stage
        merged.reps = winner.reps ?? loser.reps
        merged.ef = winner.ef ?? loser.ef
        merged.interval = winner.interval ?? loser.interval
        merged.lapses = winner.lapses ?? loser.lapses
        merged.dueDate = winner.dueDate ?? loser.dueDate
        merged.lastReview = winner.lastReview ?? loser.lastReview
        merged.lifecycle = winner.lifecycle ?? loser.lifecycle
        merged.pinned = winner.pinned ?? loser.pinned
        merged.masteredAt = winner.masteredAt ?? loser.masteredAt
        merged.updatedAt = winner.updatedAt ?? loser.updatedAt
        merged.history = history(a: local.history, b: remote.history)
        return merged
    }

    static func isConflictCopy(_ name: String) -> Bool {
        name.range(of: "^.+ \\d+\\.nb-sync\\.json$", options: .regularExpression) != nil
    }

    static func conflictBaseName(_ name: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: "^(.+) \\d+\\.nb-sync\\.json$") else { return nil }
        let range = NSRange(name.startIndex..., in: name)
        guard let match = regex.firstMatch(in: name, range: range),
              match.numberOfRanges > 1,
              let r = Range(match.range(at: 1), in: name) else { return nil }
        return "\(name[r]).nb-sync.json"
    }
}
