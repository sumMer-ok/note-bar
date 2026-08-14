import XCTest
import UIKit

final class AssetTests: XCTestCase {
    func testAnimalImagesAreInBundle() {
        for name in ["rabbit", "bear", "fox", "cat"] {
            XCTAssertNotNil(UIImage(named: name), "动物素材缺失：\(name)")
        }
    }
}
