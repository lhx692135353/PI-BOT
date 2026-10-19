package dev.pibot.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.pibot.android.data.ApiException
import dev.pibot.android.domain.epochMillis
import dev.pibot.android.face.Avatar
import dev.pibot.android.face.PiBotFace
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun errorText(e: Throwable): String = when (e) {
    is ApiException -> e.message ?: "请求失败"
    is IllegalArgumentException -> e.message ?: "输入有误"
    else -> e.message?.takeIf { it.isNotBlank() } ?: "出了点问题，请重试"
}

private val TIME = DateTimeFormatter.ofPattern("HH:mm")
private val DATE = DateTimeFormatter.ofPattern("M月d日")

fun clockTime(iso: String): String = epochMillis(iso)?.let { TIME.format(Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault())) } ?: ""

fun dayLabel(iso: String): String {
    val date = epochMillis(iso)?.let { Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault()).toLocalDate() } ?: return ""
    val today = LocalDate.now()
    return when (date) {
        today -> "今天"
        today.minusDays(1) -> "昨天"
        else -> DATE.format(date)
    }
}

/** Current time that ticks every few seconds so moods like "celebrate" fade on their own. */
@Composable
fun rememberNow(periodMs: Long = 2_000): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(periodMs) {
        while (true) {
            delay(periodMs)
            now = System.currentTimeMillis()
        }
    }
    return now
}

@Composable
fun MacChip(online: Boolean, modifier: Modifier = Modifier) {
    Row(
        modifier
            .background(if (online) Good.copy(alpha = 0.12f) else Muted.copy(alpha = 0.14f), RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).background(if (online) Good else Muted, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(if (online) "Mac 在线" else "Mac 离线", fontSize = 12.sp, lineHeight = 16.sp, color = if (online) Good else Muted)
    }
}

@Composable
fun EmptyState(avatar: Avatar, mood: String, title: String, body: String, modifier: Modifier = Modifier, action: @Composable () -> Unit = {}) {
    Column(
        modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        PiBotFace(avatar, mood, 160.dp)
        Spacer(Modifier.size(12.dp))
        Text(title, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        Spacer(Modifier.size(8.dp))
        Text(body, color = Muted, textAlign = TextAlign.Center, lineHeight = 22.sp)
        Spacer(Modifier.size(20.dp))
        action()
    }
}

val ORANGE = Avatar("blob", "orange", "light")

/** Shared 48 dp touch target for the list and conversation toolbars. */
@Composable
fun CircleAction(label: String, onClick: () -> Unit, content: @Composable () -> Unit) {
    IconButton(
        onClick = onClick,
        modifier = Modifier.size(48.dp).semantics { contentDescription = label },
        colors = IconButtonDefaults.iconButtonColors(containerColor = Card, contentColor = Ink),
        content = content,
    )
}
