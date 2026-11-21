import XCTest
@testable import PiBotKit
final class ConversationOrderTests:XCTestCase {
 func testNewFieldsAndStableOrder() throws {
  let data=Data(#"[{"id":"b","name":"B","slug":"b","last_active_at":"2099-01-01T00:00:00Z","last_message_at":"2026-01-01T00:00:00Z","unread_count":2,"last_read_seq":3},{"id":"a","name":"A","slug":"a","last_active_at":"2020-01-01T00:00:00Z","last_message_at":"2026-01-01T00:00:00Z"},{"id":"m","name":"M","slug":"m","is_main":true,"last_active_at":"2020-01-01T00:00:00Z","last_message_at":"2020-01-01T00:00:00Z"}]"#.utf8)
  let bots=try JSONDecoder().decode([Bot].self,from:data)
  XCTAssertEqual(bots[0].unreadCount,2);XCTAssertEqual(bots[0].lastReadSeq,3)
  XCTAssertEqual(conversationOrder(bots).map(\.id),["m","a","b"])
 }
}
