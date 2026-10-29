package dev.pibot.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.pibot.android.data.AgentTaskRef
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.data.TaskConversation
import dev.pibot.android.face.PiBotFace
import dev.pibot.android.face.seedOf
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal fun taskState(status: String): String = when (status) {
    "queued" -> "排队中"
    "running" -> "进行中"
    "waiting_approval" -> "等你批准"
    "completed" -> "已完成"
    "cancelled" -> "已取消"
    else -> "未完成"
}

@Composable
internal fun TaskConversationDialog(botId: String, task: AgentTaskRef, repository: PiBotRepository, onClose: () -> Unit, onOpenBot: (String) -> Unit) {
    var page by remember(task.id) { mutableStateOf<TaskConversation?>(null) }
    var busy by remember(task.id) { mutableStateOf(false) }
    var error by remember(task.id) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    suspend fun load(more: Boolean = false) {
        if (busy) return
        busy = true
        try {
            val old = page
            val after = if (old != null && (more || !old.hasMore)) old.nextAfter else 0L
            val next = repository.taskConversation(botId, task.id, after)
            page = next.copy(
                messages = (old?.messages.orEmpty() + next.messages).distinctBy { it.id }.sortedBy { it.seq },
                nextAfter = maxOf(old?.nextAfter ?: 0, next.nextAfter),
                hasMore = if (after == 0L && old != null) old.hasMore else next.hasMore,
            )
            error = null
        } catch (e: Exception) { error = errorText(e) }
        finally { busy = false }
    }
    LaunchedEffect(task.id) {
        load()
        while (true) { delay(5000); load() }
    }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(shape = MaterialTheme.shapes.large, color = Paper, modifier = Modifier.fillMaxWidth().padding(12.dp).heightIn(max = 720.dp)) {
            Column(Modifier.padding(16.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("传话详情", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    TextButton(onClick = onClose) { Text("关闭") }
                }
                page?.bots?.let { bots ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        bots.forEachIndexed { i, bot ->
                            if (i > 0) Text("↔", color = Muted)
                            PiBotFace(bot.avatar, "happy", 24.dp, seed = seedOf(bot.id))
                            Text(bot.name, fontSize = 13.sp, modifier = Modifier.weight(1f))
                        }
                    }
                }
                Text("${page?.total ?: task.messageCount} 条消息往来 · ${taskState(page?.status ?: task.status)}", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(vertical = 10.dp))
                page?.executionLabel?.let { Text("本次使用：$it", color = Muted, fontSize = 12.sp) }
                LazyColumn(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (page == null && busy) item { Text("正在加载传话…", color = Muted) }
                    if (page?.messages?.isEmpty() == true) item { Text("还没有传话记录", color = Muted) }
                    items(page?.messages.orEmpty(), key = { it.id }) { message ->
                        val sender = page?.bots?.find { it.id == message.fromBotId }
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                sender?.let { PiBotFace(it.avatar, "happy", 22.dp, seed = seedOf(it.id)) }
                                Text(sender?.name ?: "智能体", color = Accent, fontSize = 13.sp, modifier = Modifier.weight(1f))
                                message.createdAt?.let { Text(clockTime(it), color = Muted, fontSize = 11.sp) }
                            }
                            Surface(shape = MaterialTheme.shapes.medium, color = Card) {
                                Box(Modifier.fillMaxWidth().padding(12.dp)) { MarkdownText(message.content) }
                            }
                        }
                    }
                    error?.let { text -> item { Column { Text(text, color = Danger); TextButton(enabled = !busy, onClick = { scope.launch { load() } }) { Text("重试") } } } }
                    if (page?.hasMore == true) item { TextButton(enabled = !busy, onClick = { scope.launch { load(true) } }) { Text(if (busy) "正在加载…" else "加载更多往来") } }
                }
                TextButton(onClick = { onClose(); onOpenBot(task.botId) }) { Text("打开 ${task.botName} 的聊天 ›") }
            }
        }
    }
}
