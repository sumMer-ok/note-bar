import XCTest
@testable import NoteBarApp

final class CanvasEditorTests: XCTestCase {
    func testParseTemplate() throws {
        let json = """
        {"nodes":[
          {"id":"n1","type":"text","x":0,"y":0,"width":260,"height":120,"text":"hello\\n*hi, hey*\\n\\n你好，问候"}
        ],"edges":[]}
        """
        let words = try CanvasEditor.parseWords(data: Data(json.utf8), source: "English/words.canvas")
        XCTAssertEqual(words.count, 1)
        XCTAssertEqual(words[0].word, "hello")
        XCTAssertEqual(words[0].aliases, ["hi", "hey"])
        XCTAssertEqual(words[0].definition, "你好，问候")
    }

    func testAddWordCreatesTodayGroupAndPreservesUnknownFields() throws {
        var data = try JSONSerialization.jsonObject(with: Data(#"{"nodes":[],"edges":[],"futureField":{"keep":true}}"#.utf8)) as! [String: Any]
        let nodeId = try CanvasEditor.addWord(
            data: &data, word: "world", definition: "世界", aliases: ["globe"],
            color: "2", cardWidth: 260, cardHeight: 120
        )
        XCTAssertEqual(nodeId.count, 16)
        let nodes = data["nodes"] as! [[String: Any]]
        let group = nodes.first { ($0["type"] as? String) == "group" }
        XCTAssertEqual(group?["label"] as? String, CanvasEditor.todayLabel())
        let textNode = nodes.first { ($0["type"] as? String) == "text" }!
        XCTAssertEqual(textNode["text"] as? String, "world\n*globe*\n\n世界")
        XCTAssertEqual((data["futureField"] as? [String: Any])?["keep"] as? Bool, true)
    }

    func testUpdateAndDeleteWord() throws {
        var data = try JSONSerialization.jsonObject(with: Data(#"{"nodes":[{"id":"n1","type":"text","text":"old","x":0,"y":0}],"edges":[]}"#.utf8)) as! [String: Any]
        XCTAssertTrue(CanvasEditor.updateWord(data: &data, nodeId: "n1", word: "new", definition: "新", aliases: ["n"]))
        XCTAssertEqual((data["nodes"] as! [[String: Any]])[0]["text"] as? String, "new\n*n*\n\n新")
        XCTAssertTrue(CanvasEditor.deleteWord(data: &data, nodeId: "n1"))
        XCTAssertEqual((data["nodes"] as! [[String: Any]]).count, 0)
    }

    func testMasteredDetectionFromGroupAndColor() throws {
        let json = """
        {"nodes":[
          {"id":"g1","type":"group","label":"Mastered","x":0,"y":0,"width":300,"height":200},
          {"id":"n1","type":"text","x":10,"y":10,"width":50,"height":30,"text":"alpha\\n\\n释义A"},
          {"id":"n2","type":"text","x":100,"y":10,"width":50,"height":30,"text":"beta\\n\\n释义B","color":"4"},
          {"id":"n3","type":"text","x":10,"y":250,"width":50,"height":30,"text":"gamma\\n\\n释义C"}
        ],"edges":[]}
        """
        let words = try CanvasEditor.parseWords(data: Data(json.utf8), source: "Words/x.canvas")
        let byId = Dictionary(uniqueKeysWithValues: words.map { ($0.nodeId, $0) })
        XCTAssertEqual(byId["n1"]?.mastered, true)
        XCTAssertEqual(byId["n2"]?.mastered, true)
        XCTAssertEqual(byId["n3"]?.mastered, false)
    }
}
