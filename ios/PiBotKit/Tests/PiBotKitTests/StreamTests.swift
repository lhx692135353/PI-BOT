import XCTest
@testable import PiBotKit
final class StreamTests:XCTestCase {
 func frame(_ seq:Int,_ text:String,_ status:String="running") throws -> JSONValue {
  let m:[String:Any] = ["id":"m","bot_id":"b","seq":1,"role":"assistant","content":"","status":status,"created_at":"2026-01-01T00:00:00Z","reply_segments":[["id":"o","phase":"opening","text":"starting","created_at":"now"]]]
  let obj:[String:Any] = ["reset":true,"offset":0,"seq":seq,"message_id":"m","message":m,"text":text,"status":status]
  return try JSONDecoder().decode(JSONValue.self,from:JSONSerialization.data(withJSONObject:obj))
 }
 func testFirstLongSnapshotAndSequenceAndTerminal() throws {
  var timeline=Timeline();let text=String(repeating:"汉字🙂",count:5000)
  timeline.applyStream(try frame(1,text));XCTAssertEqual(timeline.messages.count,1);XCTAssertEqual(timeline.messages[0].content,text)
  XCTAssertEqual(timeline.messages[0].liveReplySegments.last?.text,text)
  timeline=timeline.applyDelta(messageId:"m",content:"stale legacy");XCTAssertEqual(timeline.messages[0].content,text)
  timeline.applyStream(try frame(1,"duplicate"));XCTAssertEqual(timeline.messages[0].content,text)
  timeline.applyStream(try frame(9,"done","completed"));timeline.applyStream(try frame(10,"late"));XCTAssertEqual(timeline.messages[0].status,"completed")
  timeline=timeline.applyDelta(messageId:"m",content:"legacy");XCTAssertEqual(timeline.messages[0].content,"done")
 }
}
