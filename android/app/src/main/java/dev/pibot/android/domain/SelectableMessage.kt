package dev.pibot.android.domain

/** Platform-independent rendered text/ranges; one document is one message's selection boundary. */
data class MessageDocument(val text: String, val marks: List<MessageMark>)
data class MessageMark(val start: Int, val end: Int, val kind: String, val value: String = "")

fun messageDocument(source: String, markdown: Boolean): MessageDocument {
    if (!markdown) return MessageDocument(source, emptyList())
    val text = StringBuilder()
    val marks = mutableListOf<MessageMark>()
    fun mark(start: Int, kind: String, value: String = "") {
        if (text.length > start) marks += MessageMark(start, text.length, kind, value)
    }
    fun inline(value: String) {
        for (span in parseInline(value)) {
            val start = text.length
            if (span.code) text.append(span.text) else {
                var offset = 0
                val links = Regex("\\[([^]\\n]+)]\\((https?://[^\\s)]+)\\)")
                for (link in links.findAll(span.text)) {
                    text.append(span.text.substring(offset, link.range.first))
                    val linkStart = text.length
                    text.append(link.groupValues[1])
                    mark(linkStart, "link", link.groupValues[2])
                    offset = link.range.last + 1
                }
                text.append(span.text.substring(offset))
            }
            if (span.bold) mark(start, "bold")
            if (span.italic) mark(start, "italic")
            if (span.code) mark(start, "code")
        }
    }
    parseMarkdown(source).forEachIndexed { index, block ->
        if (index > 0) text.append("\n\n")
        val start = text.length
        when (block) {
            is Block.Heading -> { inline(block.text); mark(start, "heading", block.level.toString()) }
            is Block.Paragraph -> inline(block.text)
            is Block.Bullet -> {
                text.append("  ".repeat(block.depth)).append(block.marker).append(' ')
                inline(block.text)
            }
            is Block.Quote -> { inline(block.text); mark(start, "quote") }
            // Never parse inline marks, trim, or replace spaces inside a fenced code block.
            is Block.Code -> { text.append(block.text); mark(start, "code") }
            is Block.Table -> block.rows.forEachIndexed { rowIndex, row ->
                if (rowIndex > 0) text.append('\n')
                val rowStart = text.length
                row.forEachIndexed { cellIndex, cell ->
                    if (cellIndex > 0) text.append("  |  ")
                    inline(cell)
                }
                if (rowIndex == 0) mark(rowStart, "bold")
            }
            Block.Rule -> text.append("────────")
        }
    }
    return MessageDocument(text.toString(), marks)
}

/** Window-Y selection bounds -> reverseLayout LazyColumn delta, bounded to avoid jumps. */
fun selectionScrollDelta(top: Int, bottom: Int, viewportTop: Int, viewportBottom: Int, margin: Int): Float {
    if (viewportBottom <= viewportTop || margin <= 0) return 0f
    val delta = when {
        top < viewportTop + margin -> top - viewportTop - margin
        bottom > viewportBottom - margin -> bottom - viewportBottom + margin
        else -> 0
    }
    return if (delta == 0) 0f else -delta.coerceIn(-margin, margin).toFloat()
}

/** Keep Android's live Spannable untouched while Editor owns a selection. Latest update wins. */
class MessageDocumentBuffer {
    var current: MessageDocument? = null
        private set
    private var frozen = false
    private var pending: MessageDocument? = null
    fun freeze() { frozen = true }
    fun offer(document: MessageDocument): MessageDocument? {
        if (frozen) { pending = document; return null }
        if (current == document) return null
        current = document
        return document
    }
    fun release(): MessageDocument? {
        frozen = false
        val latest = pending
        pending = null
        return latest
    }
}
