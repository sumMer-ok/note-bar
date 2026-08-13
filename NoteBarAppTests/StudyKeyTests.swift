import XCTest
@testable import NoteBarApp

final class StudyKeyTests: XCTestCase {
    func testFrozenVectors() throws {
        let url = Bundle(for: Self.self).url(forResource: "sync-vectors", withExtension: "json")!
        let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let vectors = root["studyKeys"] as! [[String: Any]]
        for vector in vectors {
            let input = vector["input"] as! [String: Any]
            let expected = vector["expected"] as! String
            let key = StudyKey.build(
                word: input["word"] as! String,
                language: input["language"] as? String,
                type: input["type"] as? String
            )
            XCTAssertEqual(key, expected, "input: \(input)")
        }
    }

    func testCanvasFallbackKey() {
        XCTAssertEqual(StudyKey.canvas(source: "English/words.canvas", nodeId: "abcd"), "English/words.canvas:abcd")
    }
}
