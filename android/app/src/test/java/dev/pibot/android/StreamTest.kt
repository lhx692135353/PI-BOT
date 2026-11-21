package dev.pibot.android
import org.junit.Test
import org.junit.Assert.*
import dev.pibot.android.data.Message
import dev.pibot.android.data.ReplySegment
import dev.pibot.android.domain.Timeline
import dev.pibot.android.domain.applyStream
import dev.pibot.android.domain.liveReplySegments
class StreamTest {
 private fun message(status:String="running",text:String="")=Message(id="m",botId="b",seq=1,role="assistant",status=status,content=text,createdAt="now",replySegments=listOf(ReplySegment(id="o",phase="opening",text="start",createdAt="now")))
 @Test fun firstLongResetAndTerminalAndDedup() {
  val text="汉字🙂".repeat(5000)
  var timeline=Timeline().applyStream(message(text=text),1)
  assertEquals(text,timeline.messages.single().content);assertEquals(text,timeline.messages.single().liveReplySegments.last().text)
  assertEquals(timeline,timeline.applyDelta("m","legacy"))
  assertEquals(timeline,timeline.applyStream(message(text="dup"),1))
  timeline=timeline.applyStream(message("cancelled","partial"),9)
  assertEquals(timeline,timeline.applyStream(message(text="late"),10))
  assertEquals("partial",timeline.merge(listOf(message().copy(streamSeq=2))).messages.single().content)
 }
}
