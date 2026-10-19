package dev.pibot.android

import dev.pibot.android.data.AgentTaskRef
import dev.pibot.android.data.Approval
import dev.pibot.android.data.Bot
import dev.pibot.android.data.BotActivity
import dev.pibot.android.domain.mood
import dev.pibot.android.data.FromBot
import dev.pibot.android.data.LastMessage
import dev.pibot.android.data.Message
import dev.pibot.android.data.Run
import dev.pibot.android.data.ToolEntry
import dev.pibot.android.domain.Block
import dev.pibot.android.domain.Span
import dev.pibot.android.domain.Timeline
import dev.pibot.android.domain.delegationLabel
import dev.pibot.android.domain.parseInline
import dev.pibot.android.domain.relayLabel
import dev.pibot.android.domain.parseMarkdown
import dev.pibot.android.domain.parseServerUrl
import dev.pibot.android.domain.plainPreview
import dev.pibot.android.domain.statusLine
import dev.pibot.android.domain.toolLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

fun message(id: String, seq: Int, status: String = "completed", content: String = "m$seq", tools: List<ToolEntry> = emptyList()) =
    Message(id = id, botId = "b", runId = "r", seq = seq, role = if (seq % 2 == 1) "user" else "assistant", content = content, status = status, tools = tools, createdAt = "2026-10-11T08:00:00Z")

class DomainTest {
    @Test
    fun timelineMergesByIdInSeqOrder() {
        val t = Timeline().merge(listOf(message("c", 3), message("d", 4)), hasMore = true)
        assertTrue(t.loaded && t.hasMore)
        val older = t.merge(listOf(message("a", 1), message("b", 2)), hasMore = false)
        assertEquals(listOf("a", "b", "c", "d"), older.messages.map { it.id })
        assertFalse(older.hasMore)
        val updated = older.merge(listOf(message("d", 4, content = "final")))
        assertEquals("final", updated.messages.last().content)
        assertEquals(4, updated.messages.size)
        assertEquals(1, updated.oldestSeq)
    }

    @Test
    fun deltasReplaceOnlyRunningMessagesAcrossToolRounds() {
        val t = Timeline().merge(listOf(message("u", 1), message("a", 2, status = "running", content = "你")))
        val grown = t.applyDelta("a", "你好")
        assertEquals("你好", grown.messages.last().content)
        val cleared = grown.applyDelta("a", "")
        assertEquals("", cleared.messages.last().content)
        assertEquals("结果", cleared.applyDelta("a", "结果").messages.last().content)
        assertEquals(grown, grown.applyDelta("missing", "x"))
        val done = grown.merge(listOf(message("a", 2, content = "你好！")))
        assertEquals(done, done.applyDelta("a", "你好！还有"))
    }

    @Test
    fun runningToolDrivesTheMood() {
        val tools = listOf(ToolEntry("1", "read_file", "completed"), ToolEntry("2", "run_command", "running"))
        val t = Timeline().merge(listOf(message("a", 2, status = "running", tools = tools)))
        assertEquals("run_command", t.runningTool)
        assertEquals("执行命令", toolLabel("run_command"))
        assertEquals("custom", toolLabel("custom"))
    }

    @Test
    fun backgroundActivitySurvivesACompletedConversation() {
        val bot = Bot(id = "b", name = "Pi Bot", slug = "pi", lastActiveAt = "2026-10-17T00:00:00Z",
            activity = BotActivity(status = "running", tool = "run_command", summary = "正在处理 2 个任务", runningCount = 2))
        assertEquals("正在处理 2 个任务", bot.statusLine())
        assertEquals("working", bot.mood())
        val waiting = bot.copy(activity = BotActivity(status = "waiting_approval", summary = "等你批准访问请求"))
        assertEquals("waiting", waiting.mood())
    }

    @Test
    fun statusLinesDescribeWhatTheBotIsDoing() {
        val now = Instant.parse("2026-10-11T08:00:00Z").toEpochMilli()
        val base = Bot(id = "b", name = "研究助理", slug = "research", lastActiveAt = "2026-10-11T07:59:00Z")
        assertEquals("还没有对话，打个招呼吧", base.statusLine(now))
        val running = base.copy(latestRun = Run("r", "b", "running", "mac", createdAt = "2026-10-11T07:59:00Z"))
        assertEquals("工作中…", running.statusLine(now))
        assertEquals("在云端思考…", running.copy(latestRun = running.latestRun!!.copy(executor = "cloud")).statusLine(now))
        val waiting = base.copy(pendingApprovals = listOf(Approval("a", "r", "b", path = "/Users/x/Desktop", expiresAt = "2026-10-11T08:10:00Z")))
        assertEquals("等你批准…", waiting.statusLine(now))
        val replied = base.copy(lastMessage = LastMessage("assistant", "\n周报写好了\n第二行", "completed", "2026-10-11T07:59:00Z"))
        assertEquals("周报写好了", replied.statusLine(now))
        val marked = base.copy(lastMessage = LastMessage("assistant", "## 结果\n已保存到 `weekly/a.md`", "completed", "2026-10-11T07:59:00Z"))
        assertEquals("结果", marked.statusLine(now))
        assertEquals("已保存到 weekly/a_b.md，很好", plainPreview("- 已保存到 `weekly/a_b.md`，**很好**"))
        val asleep = replied.copy(lastActiveAt = "2026-10-04T07:00:00Z")
        assertEquals("睡着了 · 7 天", asleep.statusLine(now))
    }

    @Test
    fun delegationsAreLabelledOnBothTimelines() {
        assertEquals("来自 Pi Bot 的委托", relayLabel(FromBot("p", "Pi Bot")))
        assertEquals("写作助手 的回报", relayLabel(FromBot("w", "写作助手", kind = "report")))
        assertEquals("交给了 写作助手 · 进行中", delegationLabel(AgentTaskRef("t", "w", "写作助手", "running")))
        assertEquals("交给了 写作助手 · 完成后回报", delegationLabel(AgentTaskRef("t", "w", "写作助手", "running", mode = "report")))
        assertEquals("交给了 写作助手 · 已完成", delegationLabel(AgentTaskRef("t", "w", "写作助手", "completed", mode = "report")))
        assertEquals("委托智能体", toolLabel("ask_agent"))
        val json = """{"id":"m","bot_id":"b","seq":1,"role":"user","content":"写周报","status":"completed","created_at":"2026-10-11T08:00:00Z",
            "from_bot":{"id":"p","name":"Pi Bot","avatar":{"shape":"bean","color":"orange","scheme":"light"},"kind":"task"},"agent_tasks":[]}"""
        val parsed = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }.decodeFromString(Message.serializer(), json)
        assertEquals("Pi Bot", parsed.fromBot?.name)
        assertEquals("task", parsed.fromBot?.kind)
    }

    @Test
    fun serverUrlsMayHaveAPathPrefix() {
        assertEquals("https://bot.example.com/pibot", parseServerUrl(" https://bot.example.com/pibot/ ").base)
        assertEquals(
            "wss://bot.example.com/pibot/ws/events?token=a%2Bb",
            parseServerUrl("https://bot.example.com/pibot").eventsSocket("a+b"),
        )
        assertEquals("ws://192.168.1.5:8787/ws/events?token=t", parseServerUrl("http://192.168.1.5:8787").eventsSocket("t"))
        assertEquals("http://example.com", parseServerUrl("http://example.com").base)
        assertEquals("http://203.0.113.5:8000/pibot", parseServerUrl(" http://203.0.113.5:8000/pibot/ ").base)
        assertEquals("ws://example.com:8000/pibot/ws/events?token=a%2Bb", parseServerUrl("HTTP://example.com:8000/pibot").eventsSocket("a+b"))
        assertEquals("wss://example.com/pibot/ws/events?token=t", parseServerUrl("HTTPS://example.com/pibot").eventsSocket("t"))
        for (invalid in listOf("https://x.com/?a=1", "http://x.com/#fragment", "http://user:password@x.com", "http:///missing-host", "ftp://x.com", "")) {
            assertThrows(IllegalArgumentException::class.java) { parseServerUrl(invalid) }
        }
    }

    @Test
    fun markdownBlocks() {
        val blocks = parseMarkdown(
            """
            # 报告
            主要结论：

            1. **头部集中**
            - 价格 `下探`
              - 子项
            > 引用
            ```
            ls -la
            ```
            | 厂商 | 定位 |
            |---|---|
            | A | 企业 |
            ---
            """.trimIndent(),
        )
        assertEquals(
            listOf(
                Block.Heading(1, "报告"),
                Block.Paragraph("主要结论："),
                Block.Bullet("1.", "**头部集中**", 0),
                Block.Bullet("•", "价格 `下探`", 0),
                Block.Bullet("•", "子项", 1),
                Block.Quote("引用"),
                Block.Code("ls -la"),
                Block.Table(listOf(listOf("厂商", "定位"), listOf("A", "企业"))),
                Block.Rule,
            ),
            blocks,
        )
    }

    @Test
    fun inlineMarks() {
        assertEquals(
            listOf(Span("用 "), Span("rg", code = true), Span(" 找 "), Span("全部", bold = true), Span(" 和 "), Span("斜体", italic = true)),
            parseInline("用 `rg` 找 **全部** 和 *斜体*"),
        )
        assertEquals(listOf(Span("2 * 3 = 6 和 a_b")), parseInline("2 * 3 = 6 和 a_b"))
        assertEquals(listOf(Span("**没闭合")), parseInline("**没闭合"))
    }
}
