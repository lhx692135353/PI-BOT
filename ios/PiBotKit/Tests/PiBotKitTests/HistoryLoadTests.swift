import XCTest
@testable import PiBotKit

final class HistoryLoadTests: XCTestCase {
    func testFastSuccessNeverShowsSkeleton() {
        var state = HistoryLoadState()
        let id = state.begin()
        XCTAssertTrue(state.isLoading)
        XCTAssertFalse(state.showsSkeleton)
        state.finish(id)
        state.reveal(id)
        state.markSlow(id)
        XCTAssertEqual(state, HistoryLoadState())
    }

    func testSlowFailureAndRetry() {
        var state = HistoryLoadState()
        let id = state.begin()
        state.reveal(id)
        XCTAssertTrue(state.showsSkeleton)
        XCTAssertFalse(state.isSlow)
        state.markSlow(id)
        XCTAssertTrue(state.isSlow)
        state.finish(id, error: "网络不可用")
        XCTAssertFalse(state.isLoading)
        XCTAssertFalse(state.showsSkeleton)
        XCTAssertFalse(state.isSlow)
        XCTAssertEqual(state.error, "网络不可用")
        let retry = state.begin()
        XCTAssertNil(state.error)
        XCTAssertFalse(state.showsSkeleton)
        state.finish(retry)
        XCTAssertEqual(state, HistoryLoadState())
    }

    func testOldRequestCannotChangeNewConversationOrRetry() {
        var state = HistoryLoadState()
        let old = state.begin()
        let current = state.begin()
        state.reveal(old)
        state.markSlow(old)
        state.finish(old, error: "旧请求失败")
        XCTAssertEqual(state.requestID, current)
        XCTAssertFalse(state.showsSkeleton)
        XCTAssertFalse(state.isSlow)
        XCTAssertNil(state.error)
        state.finish(current)
        XCTAssertEqual(state, HistoryLoadState())
    }
}
