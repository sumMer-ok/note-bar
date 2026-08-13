import XCTest
@testable import NoteBarApp

final class FSRSTests: XCTestCase {
    func testFrozenVectors() throws {
        let url = Bundle(for: Self.self).url(forResource: "sync-vectors", withExtension: "json")!
        let data = try Data(contentsOf: url)
        let root = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let vectors = root["fsrs"] as! [[String: Any]]

        for vector in vectors {
            let input = vector["input"] as! [String: Any]
            let output = vector["output"] as! [String: Any]
            let s = input["s"] as? Double
            let d = input["d"] as? Double
            let elapsed = input["elapsedDays"] as! Double
            let grade = FSRSGrade(rawValue: input["grade"] as! Int)!

            var nextS: Double
            var nextD: Double
            if let s, let d {
                let r = FSRS.retrievability(elapsed, s)
                nextS = grade == .again
                    ? FSRS.nextForgetStability(d, s, r)
                    : FSRS.nextRecallStability(d, s, r, grade)
                nextD = FSRS.nextDifficulty(d, grade)
            } else {
                nextS = FSRS.initStability(grade)
                nextD = FSRS.initDifficulty(grade)
            }

            XCTAssertEqual(round9(nextS), (output["s"] as! NSNumber).doubleValue, accuracy: 1e-9)
            XCTAssertEqual(round9(nextD), (output["d"] as! NSNumber).doubleValue, accuracy: 1e-9)
            XCTAssertEqual(FSRS.nextInterval(nextS), output["interval"] as! Int)
        }
    }

    private func round9(_ value: Double) -> Double { (value * 1e9).rounded() / 1e9 }
}
