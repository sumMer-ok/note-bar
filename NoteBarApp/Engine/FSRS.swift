import Foundation

enum FSRSGrade: Int, CaseIterable {
    case again = 1, hard = 2, good = 3, easy = 4
}

enum FSRS {
    static let w: [Double] = [
        0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604,
        0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605,
        2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
    ]
    static let decay = -0.5
    static let factor = pow(0.9, 1.0 / decay) - 1
    static let maxInterval = 36500.0

    static func clampD(_ d: Double) -> Double { min(10, max(1, d)) }

    static func initStability(_ grade: FSRSGrade) -> Double {
        max(0.1, w[grade.rawValue - 1])
    }

    static func initDifficulty(_ grade: FSRSGrade) -> Double {
        clampD(w[4] - exp(w[5] * Double(grade.rawValue - 1)) + 1)
    }

    static func nextDifficulty(_ d: Double, _ grade: FSRSGrade) -> Double {
        let delta = -w[6] * Double(grade.rawValue - 3)
        let damped = d + (delta * (10 - d)) / 9
        let regressed = w[7] * initDifficulty(.easy) + (1 - w[7]) * damped
        return clampD(regressed)
    }

    static func retrievability(_ tDays: Double, _ s: Double) -> Double {
        pow(1 + (factor * tDays) / s, decay)
    }

    static func nextRecallStability(_ d: Double, _ s: Double, _ r: Double, _ grade: FSRSGrade) -> Double {
        let hard = grade == .hard ? w[15] : 1.0
        let easy = grade == .easy ? w[16] : 1.0
        return s * (1 + exp(w[8]) * (11 - d) * pow(s, -w[9]) * (exp((1 - r) * w[10]) - 1) * hard * easy)
    }

    static func nextForgetStability(_ d: Double, _ s: Double, _ r: Double) -> Double {
        w[11] * pow(d, -w[12]) * (pow(s + 1, w[13]) - 1) * exp((1 - r) * w[14])
    }

    static func nextInterval(_ s: Double, targetRetention: Double = 0.9) -> Int {
        let interval = (s / factor) * (pow(targetRetention, 1.0 / decay) - 1)
        return min(Int(maxInterval), max(1, Int(interval.rounded())))
    }

    static func humanInterval(_ days: Double) -> String {
        if days < 1 { return "<1天" }
        if days < 30 { return "\(Int(days))天" }
        if days < 365 { return "\(Int((days / 30).rounded()))个月" }
        return String(format: "%.1f年", days / 365)
    }

    static func schedule(
        s: Double?, d: Double?, lapses: Int?, elapsedDays: Double,
        grade: FSRSGrade, today: Date = Date(), graduatedThreshold: Double = 30
    ) -> (s: Double, d: Double, lapses: Int, interval: Int, dueDate: String, graduated: Bool) {
        var nextS: Double
        var nextD: Double
        var nextLapses = lapses ?? 0
        if let s, let d {
            let r = retrievability(elapsedDays, s)
            if grade == .again {
                nextS = nextForgetStability(d, s, r)
                nextLapses += 1
            } else {
                nextS = nextRecallStability(d, s, r, grade)
            }
            nextD = nextDifficulty(d, grade)
        } else {
            nextS = initStability(grade)
            nextD = initDifficulty(grade)
        }
        let interval = nextInterval(nextS)
        let due = Calendar.current.date(byAdding: .day, value: interval, to: startOfDay(today))!
        return (nextS, nextD, nextLapses, interval, dayString(due), nextS >= graduatedThreshold)
    }

    static func startOfDay(_ date: Date) -> Date {
        Calendar.current.startOfDay(for: date)
    }

    static func dayString(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }
}
