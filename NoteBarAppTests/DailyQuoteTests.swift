import XCTest
@testable import NoteBarApp

final class DailyQuoteTests: XCTestCase {
    func testQuotesAreComplete() {
        XCTAssertGreaterThan(DailyQuoteBook.quotes.count, 10)
        for quote in DailyQuoteBook.quotes {
            XCTAssertFalse(quote.english.isEmpty)
            XCTAssertFalse(quote.chinese.isEmpty)
            XCTAssertFalse(quote.author.isEmpty)
        }
    }

    func testSameDayReturnsSameQuoteAndRotatesDaily() {
        let cal = Calendar.current
        let day = cal.date(from: DateComponents(year: 2026, month: 8, day: 14))!
        let next = cal.date(byAdding: .day, value: 1, to: day)!
        XCTAssertEqual(DailyQuoteBook.quote(for: day).id, DailyQuoteBook.quote(for: day).id)
        XCTAssertNotEqual(DailyQuoteBook.quote(for: day).id, DailyQuoteBook.quote(for: next).id)
    }
}
