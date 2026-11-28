package dev.pibot.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.SideEffect
import dev.pibot.android.domain.containsMath
import dev.pibot.android.domain.Block
import dev.pibot.android.domain.parseInline
import dev.pibot.android.domain.parseMarkdown

private val CodeBg = Color(0xFFF2EFEA)

fun inline(text: String): AnnotatedString = buildAnnotatedString {
    for (span in parseInline(text)) {
        val style = SpanStyle(
            fontWeight = if (span.bold) FontWeight.SemiBold else null,
            fontStyle = if (span.italic) FontStyle.Italic else null,
            fontFamily = if (span.code) FontFamily.Monospace else null,
            background = if (span.code) CodeBg else Color.Unspecified,
            fontSize = if (span.code) 13.sp else androidx.compose.ui.unit.TextUnit.Unspecified,
        )
        withStyle(style) { append(span.text) }
    }
}

@Composable
fun MarkdownText(source: String, modifier: Modifier = Modifier) {
    var hasMath by remember { mutableStateOf(false) }
    val renderMath = hasMath || containsMath(source)
    SideEffect { if(renderMath) hasMath = true }
    if(renderMath) { CopyableMessage(source,modifier);return }
    val blocks = remember(source) { parseMarkdown(source) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (block in blocks) {
            when (block) {
                is Block.Heading -> Text(inline(block.text), fontWeight = FontWeight.Bold, fontSize = (19 - block.level * 1.2).coerceAtLeast(15.0).sp)
                is Block.Paragraph -> Text(inline(block.text), lineHeight = 22.sp)
                is Block.Bullet -> Row(Modifier.padding(start = (block.depth * 14).dp)) {
                    Text(block.marker, color = Muted, modifier = Modifier.width(if (block.marker == "•") 14.dp else 22.dp))
                    Text(inline(block.text), lineHeight = 22.sp)
                }
                is Block.Quote -> Text(inline(block.text), color = Muted, modifier = Modifier.padding(start = 10.dp))
                is Block.Code -> Text(
                    block.text,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    modifier = Modifier.fillMaxWidth().background(CodeBg, RoundedCornerShape(8.dp)).horizontalScroll(rememberScrollState()).padding(10.dp),
                    softWrap = false,
                )
                is Block.Table -> Column(Modifier.horizontalScroll(rememberScrollState()).width(IntrinsicSize.Max)) {
                    block.rows.forEachIndexed { i, row ->
                        Row {
                            for (cell in row) Text(
                                inline(cell),
                                fontWeight = if (i == 0) FontWeight.SemiBold else null,
                                fontSize = 13.sp,
                                modifier = Modifier.widthIn(min = 64.dp, max = 200.dp).padding(horizontal = 6.dp, vertical = 4.dp),
                            )
                        }
                        if (i == 0) HorizontalDivider(color = Line)
                    }
                }
                Block.Rule -> {
                    Spacer(Modifier.height(2.dp))
                    HorizontalDivider(color = Line)
                }
            }
        }
    }
}
