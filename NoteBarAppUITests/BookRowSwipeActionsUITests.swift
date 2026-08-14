import XCTest

final class BookRowSwipeActionsUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSwipeRevealsDefaultAndPinAndTheyToggle() throws {
        let app = XCUIApplication()
        app.launch()

        let book = app.staticTexts["Words/Daily English.canvas"].firstMatch
        XCTAssertTrue(book.waitForExistence(timeout: 15), "首页应显示词库行")

        // 未左滑时按钮不可见
        XCTAssertFalse(app.buttons["默认"].exists)

        // 左滑露出两个操作
        book.swipeLeft()
        let defaultButton = app.buttons["默认"].firstMatch
        let pinButton = app.buttons["置顶"].firstMatch
        XCTAssertTrue(defaultButton.waitForExistence(timeout: 3), "左滑后应出现「默认」按钮")
        XCTAssertTrue(pinButton.exists, "左滑后应出现「置顶」按钮")

        // 设为默认：词库名后出现红色（默认），按钮变为取消默认
        defaultButton.tap()
        XCTAssertTrue(app.staticTexts["（默认）"].waitForExistence(timeout: 3), "点击默认后应显示（默认）标记")
        XCTAssertTrue(app.buttons["取消默认"].firstMatch.exists, "点击默认后按钮应变为取消默认")

        // 设为置顶：按钮变为取消置顶
        pinButton.tap()
        XCTAssertTrue(app.buttons["取消置顶"].firstMatch.waitForExistence(timeout: 3), "点击置顶后按钮应变为取消置顶")

        // 复位状态，避免污染后续测试
        app.buttons["取消默认"].firstMatch.tap()
        app.buttons["取消置顶"].firstMatch.tap()
        XCTAssertTrue(app.buttons["默认"].waitForExistence(timeout: 3))
    }
}
