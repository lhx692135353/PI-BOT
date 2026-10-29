package dev.pibot.android.ui

import android.content.Context
import android.graphics.Rect
import android.graphics.Typeface
import android.text.Selection
import android.text.Spannable
import android.text.SpannableString
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.URLSpan
import android.text.util.Linkify
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.TextView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.get
import androidx.core.view.size
import dev.pibot.android.domain.MessageDocument
import dev.pibot.android.domain.MessageDocumentBuffer
import dev.pibot.android.domain.messageDocument
import kotlin.math.abs

/** Scoped to a conversation, not an Activity/global singleton. */
internal class MessageSelectionSession {
    var active by mutableStateOf<SelectableMessageView?>(null)
        private set
    var onActiveChanged: (Boolean) -> Unit = {}
    var reveal: (SelectableMessageView, Rect) -> Unit = { _, _ -> }
    fun start(view: SelectableMessageView) {
        if (active === view) return
        active?.finishSelection()
        active = view
        onActiveChanged(true)
    }
    fun end(view: SelectableMessageView) {
        if (active !== view) return
        active = null
        onActiveChanged(false)
    }
    fun clear() { active?.finishSelection() }
}
internal val LocalMessageSelection = staticCompositionLocalOf<MessageSelectionSession?> { null }

/** One native selection surface for the entire message, including all Markdown blocks. */
@Composable
fun CopyableMessage(
    text: String,
    modifier: Modifier = Modifier,
    markdown: Boolean = true,
    color: Color = Ink,
) {
    val session = LocalMessageSelection.current
    val document = remember(text, markdown) { messageDocument(text, markdown) }
    val viewHolder = remember { arrayOfNulls<SelectableMessageView>(1) }
    DisposableEffect(session) {
        onDispose { viewHolder[0]?.finishSelection(); viewHolder[0] = null }
    }
    AndroidView(
        modifier = modifier,
        factory = { context -> SelectableMessageView(context).also { viewHolder[0] = it } },
        update = { view ->
            view.session = session
            view.setTextColor(color.toArgb())
            view.bind(document)
        },
    )
}

/** Android owns word selection, handles, magnifier, clipboard, accessibility and floating toolbar. */
internal class SelectableMessageView(context: Context) : TextView(context) {
    var session: MessageSelectionSession? = null
    private var mode: ActionMode? = null
    private val buffer = MessageDocumentBuffer()
    private var downX = 0f
    private var downY = 0f
    private var downTime = 0L
    private var moved = false
    private var tappedLink: URLSpan? = null

    init {
        textSize = 14f
        includeFontPadding = false
        setLineSpacing(4 * resources.displayMetrics.density, 1f)
        setPadding(0, 0, 0, 0)
        setTextIsSelectable(true)
        // Keep ArrowKeyMovementMethod installed by setTextIsSelectable: LinkMovementMethod
        // would consume long presses and break selection. Short URL taps are handled below.
        customSelectionActionModeCallback = object : ActionMode.Callback {
            override fun onCreateActionMode(actionMode: ActionMode, menu: Menu): Boolean {
                mode = actionMode
                buffer.freeze()
                session?.start(this@SelectableMessageView)
                return true
            }
            override fun onPrepareActionMode(actionMode: ActionMode, menu: Menu): Boolean {
                for (index in menu.size - 1 downTo 0) {
                    val id = menu[index].itemId
                    if (id != android.R.id.copy && id != android.R.id.selectAll) menu.removeItem(id)
                }
                return true
            }
            override fun onActionItemClicked(actionMode: ActionMode, item: MenuItem): Boolean = false
            override fun onDestroyActionMode(actionMode: ActionMode) {
                mode = null
                session?.end(this@SelectableMessageView)
                // Do not mutate the buffer while Android's Editor is destroying its handles.
                post { if (mode == null) buffer.release()?.let { bind(it) } }
            }
        }
    }

    fun bind(document: MessageDocument) {
        buffer.offer(document)?.let { text = it.spannable() }
    }

    fun finishSelection() {
        mode?.finish()
        (text as? Spannable)?.let { Selection.removeSelection(it) }
        clearFocus()
    }

    override fun onDetachedFromWindow() {
        finishSelection()
        super.onDetachedFromWindow()
    }

    override fun requestRectangleOnScreen(rectangle: Rect, immediate: Boolean): Boolean {
        // TextView's Editor calls this while moving its native selection handles. Bridge the
        // requested caret rectangle to Compose's outer LazyColumn (there is no inner scroller).
        if (mode != null && session != null) {
            session?.reveal?.invoke(this, Rect(rectangle))
            return true
        }
        return super.requestRectangleOnScreen(rectangle, immediate)
    }

    override fun performClick(): Boolean {
        val link = tappedLink
        tappedLink = null
        val handled = super.performClick()
        if (link == null) return handled
        runCatching { link.onClick(this) }
        return true
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x; downY = event.y; downTime = event.eventTime; moved = false
            }
            MotionEvent.ACTION_MOVE -> {
                val slop = ViewConfiguration.get(context).scaledTouchSlop
                if (abs(event.x - downX) > slop || abs(event.y - downY) > slop) moved = true
            }
        }
        val shortTap = event.actionMasked == MotionEvent.ACTION_UP && !moved &&
            event.eventTime - downTime < ViewConfiguration.getLongPressTimeout() && mode == null
        val handled = super.onTouchEvent(event)
        if (shortTap) {
            val offset = getOffsetForPosition(event.x, event.y)
            val content = text as? Spanned
            val link = content?.getSpans(offset, offset, URLSpan::class.java)?.firstOrNull {
                offset >= content.getSpanStart(it) && offset < content.getSpanEnd(it)
            }
            val line = layout?.getLineForOffset(offset)
            val overText = line != null && event.x >= totalPaddingLeft + layout.getLineLeft(line) &&
                event.x <= totalPaddingLeft + layout.getLineRight(line) &&
                event.y >= totalPaddingTop && event.y < totalPaddingTop + layout.height
            if (overText && link != null && (link.url.startsWith("https://") || link.url.startsWith("http://"))) {
                tappedLink = link
                return performClick()
            }
        }
        return handled
    }
}

private fun MessageDocument.spannable(): SpannableString = SpannableString(text).also { result ->
    // Preserve plain web URLs as well as Markdown link labels, without a new dependency.
    Linkify.addLinks(result, Linkify.WEB_URLS)
    for (mark in marks) {
        val span = when (mark.kind) {
            "bold", "heading" -> StyleSpan(Typeface.BOLD)
            "italic" -> StyleSpan(Typeface.ITALIC)
            "code" -> TypefaceSpan("monospace")
            "quote" -> ForegroundColorSpan(0xFF77736B.toInt())
            "link" -> URLSpan(mark.value)
            else -> continue
        }
        result.setSpan(span, mark.start, mark.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        if (mark.kind == "code") {
            result.setSpan(BackgroundColorSpan(0xFFF2EFEA.toInt()), mark.start, mark.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        if (mark.kind == "heading") {
            result.setSpan(RelativeSizeSpan(1.25f), mark.start, mark.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }
}
