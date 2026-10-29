package dev.pibot.android

import dev.pibot.android.domain.MessageDocumentBuffer
import dev.pibot.android.domain.messageDocument
import dev.pibot.android.domain.selectionScrollDelta
import org.junit.Assert.*
import org.junit.Test

class SelectableMessageTest {
    @Test fun userMessageRemainsLiteralIncludingMarkdownAndWhitespace() {
        val source = "  **不要渲染用户输入** 👋\r\n\tcode\n"
        assertEquals(source, messageDocument(source, markdown = false).text)
        assertTrue(messageDocument(source, markdown = false).marks.isEmpty())
    }

    @Test fun markdownIsOneContinuousDocumentAcrossBlocks() {
        val doc = messageDocument("# 标题\n\n第一段 **重点**\n\n> 引用\n\n```kt\n  val x = 1\n    println(x)\n```\n\n最后一段", true)
        assertEquals("标题\n\n第一段 重点\n\n引用\n\n  val x = 1\n    println(x)\n\n最后一段", doc.text)
        // A single continuous substring can cross paragraph, quote and code boundaries.
        val selected = doc.text.substring(doc.text.indexOf("重点"), doc.text.indexOf("最后一段"))
        assertTrue(selected.contains("引用\n\n  val x = 1\n    println(x)"))
        assertEquals("  val x = 1\n    println(x)", doc.marks.single { it.kind == "code" }.let { doc.text.substring(it.start, it.end) })
    }

    @Test fun codeIsNeverReparsedAsInlineMarkdownOrLinks() {
        val source = "```\n  **literal**\n\t[not a label](https://example.com)\n  end  \n```"
        val doc = messageDocument(source, true)
        assertEquals("  **literal**\n\t[not a label](https://example.com)\n  end  ", doc.text)
        assertEquals(listOf("code"), doc.marks.map { it.kind })
    }

    @Test fun markdownLinksHaveVisibleLabelsAndSeparateTargets() {
        val doc = messageDocument("点 [官网](https://example.com/a) 和 `代码`", true)
        assertEquals("点 官网 和 代码", doc.text)
        val link = doc.marks.single { it.kind == "link" }
        assertEquals("官网", doc.text.substring(link.start, link.end))
        assertEquals("https://example.com/a", link.value)
    }

    @Test fun unsafeLinkSchemesAreNotMadeClickable() {
        val doc = messageDocument("[危险](javascript:alert) [本地](file:///etc/passwd)", true)
        assertTrue(doc.marks.none { it.kind == "link" })
        assertTrue(doc.text.contains("javascript:"))
    }

    @Test fun tableRowsAndListsRemainSelectableText() {
        val doc = messageDocument("- 苹果\n  - 香蕉\n\n| 名字 | 数量 |\n| --- | --- |\n| 梨 | 2 |", true)
        assertEquals("• 苹果\n\n  • 香蕉\n\n名字  |  数量\n梨  |  2", doc.text)
    }

    @Test fun unclosedStreamingCodeRetainsContent() {
        val doc = messageDocument("回答\n\n```sh\n  echo hello\n", true)
        assertEquals("回答\n\n  echo hello\n", doc.text)
    }

    @Test fun unicodeMarkRangesAlwaysIndexTheRenderedText() {
        val doc = messageDocument("👩‍💻 **你好👋** 与 *世界* 和 `a_b`", true)
        assertEquals("你好👋", doc.marks.single { it.kind == "bold" }.let { doc.text.substring(it.start, it.end) })
        assertEquals("世界", doc.marks.single { it.kind == "italic" }.let { doc.text.substring(it.start, it.end) })
        doc.marks.forEach { assertTrue(it.start >= 0 && it.end <= doc.text.length && it.end > it.start) }
    }

    @Test fun emptyMessagesHaveNoSelectablePlaceholderInTheirDocument() {
        assertEquals("", messageDocument("", true).text)
        assertEquals("", messageDocument("\n\n", true).text)
    }

    @Test fun selectAllScopeIsExactlyOneExplicitMessage() {
        assertEquals("当前消息", messageDocument("当前消息", true).text)
        assertFalse(messageDocument("当前消息", true).text.contains("另一条消息"))
    }

    @Test fun selectionInsideViewportDoesNotScroll() {
        assertEquals(0f, selectionScrollDelta(80, 120, 0, 400, 24))
    }

    @Test fun selectionEdgesScrollInReverseLayoutDirectionAndAreBounded() {
        assertEquals(24f, selectionScrollDelta(-100, -80, 0, 400, 24))
        assertEquals(-24f, selectionScrollDelta(480, 500, 0, 400, 24))
        assertEquals(-14f, selectionScrollDelta(370, 390, 0, 400, 24))
    }

    @Test fun unavailableViewportDoesNotJump() {
        assertEquals(0f, selectionScrollDelta(10, 30, 0, 0, 24))
    }
    @Test fun streamingDoesNotReplaceSelectedBufferAndLatestUpdateWins() {
        val buffer = MessageDocumentBuffer()
        val initial = messageDocument("正在", true)
        assertEquals(initial, buffer.offer(initial))
        buffer.freeze()
        assertNull(buffer.offer(messageDocument("正在回复", true)))
        val latest = messageDocument("正在回复\n\n```kt\n  val a = 1", true)
        assertNull(buffer.offer(latest))
        assertEquals(initial, buffer.current)
        assertEquals(latest, buffer.release())
        assertEquals(latest, buffer.offer(latest))
        assertEquals(latest, buffer.current)
    }

    @Test fun ordinaryRecompositionDoesNotResetSelectionOrText() {
        val buffer = MessageDocumentBuffer()
        val doc = messageDocument("文本", true)
        buffer.offer(doc)
        assertNull(buffer.offer(doc.copy()))
        buffer.freeze()
        assertNull(buffer.offer(doc.copy()))
        assertEquals(doc, buffer.release())
        assertNull(buffer.offer(doc))
    }

    @Test fun clearingDraftDuringSelectionIsDeferredToo() {
        val buffer = MessageDocumentBuffer()
        val before = messageDocument("旧草稿", true)
        val cleared = messageDocument("", true)
        buffer.offer(before)
        buffer.freeze()
        assertNull(buffer.offer(cleared))
        assertEquals(before, buffer.current)
        assertEquals(cleared, buffer.release())
        buffer.offer(cleared)
        assertEquals("", buffer.current?.text)
    }

}
