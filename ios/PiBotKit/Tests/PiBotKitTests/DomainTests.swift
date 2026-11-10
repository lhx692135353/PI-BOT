import XCTest
@testable import PiBotKit

func message(_ id: String, _ seq: Int, status: String = "completed", content: String? = nil, tools: [ToolEntry] = []) -> Message {
    Message(id: id, botId: "b", runId: "r", seq: seq, role: seq % 2 == 1 ? "user" : "assistant", content: content ?? "m\(seq)",
            status: status, tools: tools, createdAt: "2026-10-11T08:00:00Z")
}

final class DomainTests: XCTestCase {
    func testTimelineMergesByIdInSeqOrder() {
        let t = Timeline().merge([message("c", 3), message("d", 4)], hasMore: true)
        XCTAssertTrue(t.loaded && t.hasMore)
        let older = t.merge([message("a", 1), message("b", 2)], hasMore: false)
        XCTAssertEqual(older.messages.map(\.id), ["a", "b", "c", "d"])
        XCTAssertFalse(older.hasMore)
        let updated = older.merge([message("d", 4, content: "final")])
        XCTAssertEqual(updated.messages.last?.content, "final")
        XCTAssertEqual(updated.messages.count, 4)
        XCTAssertEqual(updated.oldestSeq, 1)
    }

    func testTailPagesKeepCachedHistoryButNeverLeaveAGap() {
        let cached = Timeline(messages: [message("a", 1), message("b", 2), message("c", 3)], hasMore: true)
        let overlapping = cached.mergeTail([message("c", 3, content: "新"), message("d", 4)], hasMore: true)
        XCTAssertEqual(overlapping.messages.map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(overlapping.messages[2].content, "新")
        XCTAssertTrue(overlapping.hasMore && overlapping.loaded)

        let reachesFurther = Timeline(messages: [message("c", 3)], hasMore: true).mergeTail([message("b", 2), message("c", 3)], hasMore: false)
        XCTAssertFalse(reachesFurther.hasMore)

        let detached = cached.mergeTail([message("y", 40), message("z", 41)], hasMore: true)
        XCTAssertEqual(detached.messages.map(\.id), ["y", "z"])
        XCTAssertTrue(detached.hasMore)
    }

    func testOlderPagesOnlyPrependOntoTheTimelineTheyWereRequestedFor() {
        let t = Timeline(messages: [message("c", 3), message("d", 4)], hasMore: true, loaded: true)
        let older = t.mergeOlder(before: "c", [message("a", 1), message("b", 2)], hasMore: false)
        XCTAssertEqual(older.messages.map(\.id), ["a", "b", "c", "d"])
        XCTAssertFalse(older.hasMore)
        XCTAssertEqual(t.mergeOlder(before: "x", [message("a", 1)], hasMore: false), t)
    }

    func testTimelineCacheKeepsTheNewestMessagesPerAccount() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = FileTimelineCache(root: root, limit: 2)
        var reply = message("m4", 4)
        reply.replySegments = [ReplySegment(id: "s", text: "段落", phase: "answer", createdAt: "2026-10-11T08:00:00Z")]
        cache.write(userId: "u1", botId: "b1", timeline: Timeline(messages: [message("m1", 1), message("m2", 2), message("m3", 3), reply, message("m5", 5)], hasMore: false, loaded: true))
        let read = try XCTUnwrap(cache.read(userId: "u1", botId: "b1"))
        XCTAssertEqual(read.messages.map(\.id), ["m4", "m5"])
        XCTAssertEqual(read.messages.first, reply)
        XCTAssertTrue(read.hasMore)
        XCTAssertFalse(read.loaded)
        XCTAssertNil(cache.read(userId: "u2", botId: "b1"))
        cache.clear(userId: "u1")
        XCTAssertNil(cache.read(userId: "u1", botId: "b1"))
    }

    func testDeltasReplaceOnlyRunningMessagesAcrossToolRounds() {
        let t = Timeline().merge([message("u", 1), message("a", 2, status: "running", content: "你")])
        let grown = t.applyDelta(messageId: "a", content: "你好")
        XCTAssertEqual(grown.messages.last?.content, "你好")
        let cleared = grown.applyDelta(messageId: "a", content: "")
        XCTAssertEqual(cleared.messages.last?.content, "")
        XCTAssertEqual(cleared.applyDelta(messageId: "a", content: "结果").messages.last?.content, "结果")
        XCTAssertEqual(grown.applyDelta(messageId: "missing", content: "x"), grown)
        let done = grown.merge([message("a", 2, content: "你好！")])
        XCTAssertEqual(done.applyDelta(messageId: "a", content: "你好！还有"), done)
    }

    func testRunningToolDrivesTheMood() {
        let tools = [ToolEntry(id: "1", name: "read_file", state: "completed"), ToolEntry(id: "2", name: "run_command", state: "running")]
        let t = Timeline().merge([message("a", 2, status: "running", tools: tools)])
        XCTAssertEqual(t.runningTool, "run_command")
        XCTAssertEqual(toolLabel("run_command"), "执行命令")
        XCTAssertEqual(toolLabel("custom"), "custom")
    }

    func testBackgroundActivitySurvivesACompletedConversation() {
        let bot = Bot(id: "b", name: "Pi Bot", slug: "pi", lastActiveAt: "2026-10-17T00:00:00Z",
                      activity: BotActivity(status: "running", tool: "run_command", summary: "正在处理 2 个任务", runningCount: 2))
        XCTAssertEqual(bot.statusLine(), "正在处理 2 个任务")
        XCTAssertEqual(bot.mood(), "working")
        var waiting = bot
        waiting.activity = BotActivity(status: "waiting_approval", summary: "等你批准访问请求")
        XCTAssertEqual(waiting.mood(), "waiting")
    }

    func testStatusLinesDescribeWhatTheBotIsDoing() {
        let now = epochMillis("2026-10-11T08:00:00Z")!
        let base = Bot(id: "b", name: "研究助理", slug: "research", lastActiveAt: "2026-10-11T07:59:00Z")
        XCTAssertEqual(base.statusLine(now: now), "还没有对话，打个招呼吧")
        var running = base
        running.latestRun = Run(id: "r", botId: "b", status: "running", executor: "device", createdAt: "2026-10-11T07:59:00Z")
        XCTAssertEqual(running.statusLine(now: now), "工作中…")
        running.latestRun?.executor = "cloud"
        XCTAssertEqual(running.statusLine(now: now), "在云端思考…")
        var waiting = base
        waiting.pendingApprovals = [Approval(id: "a", runId: "r", botId: "b", path: "/Users/x/Desktop", expiresAt: "2026-10-11T08:10:00Z")]
        XCTAssertEqual(waiting.statusLine(now: now), "等你批准…")
        var replied = base
        replied.lastMessage = LastMessage(role: "assistant", preview: "\n周报写好了\n第二行", status: "completed", createdAt: "2026-10-11T07:59:00Z")
        XCTAssertEqual(replied.statusLine(now: now), "周报写好了")
        var marked = base
        marked.lastMessage = LastMessage(role: "assistant", preview: "## 结果\n已保存到 `weekly/a.md`", status: "completed", createdAt: "2026-10-11T07:59:00Z")
        XCTAssertEqual(marked.statusLine(now: now), "结果")
        XCTAssertEqual(plainPreview("- 已保存到 `weekly/a_b.md`，**很好**"), "已保存到 weekly/a_b.md，很好")
        var asleep = replied
        asleep.lastActiveAt = "2026-10-04T07:00:00Z"
        XCTAssertEqual(asleep.statusLine(now: now), "睡着了 · 7 天")
    }

    func testDelegationsAreLabelledOnBothTimelines() throws {
        XCTAssertEqual(relayLabel(FromBot(id: "p", name: "Pi Bot")), "来自 Pi Bot 的委托")
        XCTAssertEqual(relayLabel(FromBot(id: "w", name: "写作助手", kind: "report")), "写作助手 的回报")
        XCTAssertEqual(delegationLabel(AgentTaskRef(id: "t", botId: "w", botName: "写作助手", status: "running")), "交给了 写作助手 · 进行中")
        XCTAssertEqual(delegationLabel(AgentTaskRef(id: "t", botId: "w", botName: "写作助手", status: "running", mode: "report")), "交给了 写作助手 · 完成后回报")
        XCTAssertEqual(delegationLabel(AgentTaskRef(id: "t", botId: "w", botName: "写作助手", status: "completed", mode: "report")), "交给了 写作助手 · 已完成")
        XCTAssertEqual(toolLabel("ask_agent"), "委托智能体")
        let json = """
        {"id":"m","bot_id":"b","seq":1,"role":"user","content":"写周报","status":"completed","created_at":"2026-10-11T08:00:00Z",
         "from_bot":{"id":"p","name":"Pi Bot","avatar":{"shape":"bean","color":"orange","scheme":"light"},"kind":"task"},"agent_tasks":[],"ui":null}
        """
        let parsed = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
        XCTAssertEqual(parsed.fromBot?.name, "Pi Bot")
        XCTAssertEqual(parsed.fromBot?.kind, "task")
        XCTAssertNil(parsed.ui)
    }

    func testServerUrlsMayHaveAPathPrefix() throws {
        XCTAssertEqual(try parseServerURL(" https://bot.example.com/pibot/ ").base, "https://bot.example.com/pibot")
        XCTAssertEqual(try parseServerURL("https://bot.example.com/pibot").eventsSocket(token: "a+b"), "wss://bot.example.com/pibot/ws/events?token=a%2Bb")
        XCTAssertEqual(try parseServerURL("http://192.168.1.5:8787").eventsSocket(token: "t"), "ws://192.168.1.5:8787/ws/events?token=t")
        XCTAssertEqual(try parseServerURL("http://example.com").base, "http://example.com")
        XCTAssertEqual(try parseServerURL(" http://203.0.113.5:8000/pibot/ ").base, "http://203.0.113.5:8000/pibot")
        XCTAssertEqual(try parseServerURL("HTTP://example.com:8000/pibot").eventsSocket(token: "a+b"), "ws://example.com:8000/pibot/ws/events?token=a%2Bb")
        XCTAssertEqual(try parseServerURL("HTTPS://example.com/pibot").eventsSocket(token: "t"), "wss://example.com/pibot/ws/events?token=t")
        XCTAssertEqual(
            try parseServerURL("https://bot.example.com/pibot").voiceSocket(token: "a+b", botId: "bot/1", callId: "call 1"),
            "wss://bot.example.com/pibot/ws/voice?token=a%2Bb&client=ios&bot=bot%2F1&call_id=call+1"
        )
        XCTAssertEqual(try parseServerURL("http://192.168.1.5:8787").voiceSocket(token: "t", botId: "b1"), "ws://192.168.1.5:8787/ws/voice?token=t&client=ios&bot=b1")
        for invalid in ["https://x.com/?a=1", "http://x.com/#fragment", "http://user:password@x.com", "http:///missing-host", "ftp://x.com", ""] {
            XCTAssertThrowsError(try parseServerURL(invalid), invalid)
        }
    }

    func testMarkdownBlocks() {
        let blocks = parseMarkdown("""
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
        """)
        XCTAssertEqual(blocks, [
            .heading(level: 1, text: "报告"),
            .paragraph("主要结论："),
            .bullet(marker: "1.", text: "**头部集中**", depth: 0),
            .bullet(marker: "•", text: "价格 `下探`", depth: 0),
            .bullet(marker: "•", text: "子项", depth: 1),
            .quote("引用"),
            .code("ls -la"),
            .table([["厂商", "定位"], ["A", "企业"]]),
            .rule,
        ])
    }

    func testInlineMarks() {
        XCTAssertEqual(parseInline("用 `rg` 找 **全部** 和 *斜体*"), [
            Span("用 "), Span("rg", code: true), Span(" 找 "), Span("全部", bold: true), Span(" 和 "), Span("斜体", italic: true),
        ])
        XCTAssertEqual(parseInline("2 * 3 = 6 和 a_b"), [Span("2 * 3 = 6 和 a_b")])
        XCTAssertEqual(parseInline("**没闭合"), [Span("**没闭合")])
    }

    func testMessageDocumentKeepsLinksAndCodeVerbatim() {
        let doc = messageDocument("# 标题\n看 [文档](https://example.com/a) 和 `a  b`\n```\n  x *y*\n```", markdown: true)
        XCTAssertEqual(doc.text, "标题\n\n看 文档 和 a  b\n\n  x *y*")
        XCTAssertTrue(doc.marks.contains(MessageMark(start: 0, end: 2, kind: "heading", value: "1")))
        XCTAssertTrue(doc.marks.contains(MessageMark(start: 6, end: 8, kind: "link", value: "https://example.com/a")))
        XCTAssertTrue(doc.marks.contains { $0.kind == "code" && (doc.text as NSString).substring(with: NSRange(location: $0.start, length: $0.end - $0.start)) == "  x *y*" })
        XCTAssertEqual(messageDocument("**原样**", markdown: false).text, "**原样**")
    }
}
