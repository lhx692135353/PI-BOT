package dev.pibot.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Add
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import dev.pibot.android.data.ChatImage
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pibot.android.data.Approval
import dev.pibot.android.data.Bot
import dev.pibot.android.data.FromBot
import dev.pibot.android.data.Message
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.domain.Timeline
import dev.pibot.android.domain.delegationLabel
import dev.pibot.android.domain.mood
import dev.pibot.android.domain.relayLabel
import dev.pibot.android.face.PiBotFace
import dev.pibot.android.face.seedOf
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimelineScreen(
    repository: PiBotRepository,
    botId: String,
    onBack: () -> Unit,
    onEdit: () -> Unit,
    onFiles: () -> Unit,
    onOpenBot: (String) -> Unit,
    expanded: Boolean = false,
    draft: String,
    onDraftChange: (String) -> Unit,
) {
    val bot by remember(repository, botId) { repository.bot(botId) }.collectAsStateWithLifecycle(null)
    val timeline by remember(repository, botId) { repository.timeline(botId) }.collectAsStateWithLifecycle(Timeline())
    val devices by repository.devices.collectAsStateWithLifecycle()
    val target = devices.firstOrNull { it.id == bot?.executionDeviceId }
    val targetOnline = target?.online == true
    val scope = rememberCoroutineScope()
    var error by remember(botId) { mutableStateOf<String?>(null) }
    var loadingMore by remember(botId) { mutableStateOf(false) }
    var menuOpen by remember(botId) { mutableStateOf(false) }
    val now = rememberNow()

    LaunchedEffect(botId) {
        runCatching { repository.refreshBot(botId); repository.loadTail(botId) }.onFailure { error = errorText(it) }
    }
    val current = bot
    if (current == null) {
        Column(Modifier.fillMaxSize().background(Paper).statusBarsPadding()) {
            if (!expanded) CircleAction("返回", onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null) }
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                if (error == null) CircularProgressIndicator() else Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(error.orEmpty(), color = Danger)
                    TextButton(onClick = { scope.launch {
                        error = null
                        runCatching { repository.refreshBot(botId); repository.loadTail(botId) }.onFailure { error = errorText(it) }
                    } }) { Text("重试") }
                }
            }
        }
        return
    }
    val mood = current.mood(now, timeline.runningTool)

    Scaffold(
        topBar = {
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (!expanded) CircleAction("返回", onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null) }
                Row(
                    Modifier.weight(1f).background(Card, RoundedCornerShape(28.dp)).padding(start = 4.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PiBotFace(current.avatar, mood, 44.dp, seed = seedOf(current.id))
                    Spacer(Modifier.size(6.dp))
                    Column(Modifier.weight(1f)) {
                        Text(current.name, fontSize = 16.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${target?.label ?: "未绑定电脑"} · ${if (targetOnline) "在线" else "云端聊天 · 本地任务等待"}", fontSize = 11.sp, lineHeight = 14.sp, color = Muted)
                    }
                }
                Box {
                    CircleAction("更多选项", { menuOpen = true }) { Icon(Icons.Filled.MoreVert, null) }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("资料库") }, enabled = targetOnline, onClick = { menuOpen = false; onFiles() })
                        DropdownMenuItem(text = { Text("编辑 Bot") }, onClick = { menuOpen = false; onEdit() }, leadingIcon = { Icon(Icons.Filled.Edit, null) })
                    }
                }
            }
        },
        containerColor = Paper,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            val list = androidx.compose.runtime.key(botId) { rememberLazyListState() }
            val reversed = remember(timeline.messages) { timeline.messages.asReversed() }
            val atTop by remember(list) { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index == list.layoutInfo.totalItemsCount - 1 } }
            LaunchedEffect(botId, atTop, timeline.hasMore) {
                if (atTop && timeline.hasMore && !loadingMore) {
                    loadingMore = true
                    runCatching { repository.loadMore(botId) }.onFailure { error = errorText(it) }
                    loadingMore = false
                }
            }
            LazyColumn(
                state = list,
                reverseLayout = true,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(current.pendingApprovals, key = { "approval-${it.id}" }) { approval ->
                    ApprovalCard(approval) { approve ->
                        scope.launch { runCatching { repository.decide(approval, approve) }.onFailure { error = errorText(it) } }
                    }
                }
                current.activity?.summary?.let { summary ->
                    item(key = "task-activity") {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 6.dp)) {
                            PiBotFace(current.avatar, mood, 26.dp, seed = seedOf(current.id))
                            Spacer(Modifier.size(8.dp))
                            Text(summary, color = Muted, fontSize = 13.sp)
                        }
                    }
                }
                items(reversed, key = { it.id }) { message -> MessageItem(message, onOpenBot, repository) }
                if (timeline.loaded && timeline.messages.isEmpty()) {
                    item { Intro(current) }
                }
            }
            error?.let {
                Text(it, color = Danger, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
            Composer(botId, current.name, draft, onDraftChange) { text, requestId, images ->
                error = null
                try { repository.send(botId, text, requestId, images); true }
                catch (e: Exception) { error = errorText(e); false }
            }
        }
    }
}

@Composable
private fun Intro(bot: Bot) {
    Column(Modifier.fillMaxWidth().padding(vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        PiBotFace(bot.avatar, "happy", 112.dp, seed = seedOf(bot.id))
        Spacer(Modifier.height(12.dp))
        Text("和 ${bot.name} 打个招呼", fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(4.dp))
        Text(bot.persona.ifBlank { "它会记住你们的对话。" }, color = Muted, fontSize = 13.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun RelayItem(message: Message, from: FromBot, onOpenBot: (String) -> Unit, bubbleWidth: androidx.compose.ui.unit.Dp) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.Start) {
        Row(
            Modifier.clickable { onOpenBot(from.id) }.padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            from.avatar?.let { PiBotFace(it, "happy", 22.dp, seed = seedOf(from.id)) }
            Spacer(Modifier.size(6.dp))
            Text(relayLabel(from), fontSize = 12.sp, color = Muted)
        }
        Spacer(Modifier.height(4.dp))
        Box(
            Modifier.widthIn(max = bubbleWidth)
                .background(AccentSoft, RoundedCornerShape(18.dp))
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) { MarkdownText(message.content) }
        Spacer(Modifier.height(3.dp))
        Text(dayLabel(message.createdAt) + " " + clockTime(message.createdAt), fontSize = 11.sp, color = Muted)
    }
}

@Composable
private fun MessageItem(message: Message, onOpenBot: (String) -> Unit, repository: PiBotRepository) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val bubbleWidth = (maxWidth * 0.92f).coerceAtMost(600.dp)
        val from = message.fromBot
        if (message.role == "user" && from != null) {
            RelayItem(message, from, onOpenBot, bubbleWidth)
        } else {
            val user = message.role == "user"
            // Older servers and saved history may still include the retired placeholder.
            val remarks = message.progress.filter { it.filterNot(Char::isWhitespace) != "好，我来看看，稍后把结果给你。" }
            Column(Modifier.fillMaxWidth(), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
                val bubble = Modifier
                    .widthIn(max = bubbleWidth)
                    .background(if (user) Ink else Card, RoundedCornerShape(18.dp))
                    .padding(horizontal = 14.dp, vertical = 10.dp)
                if (!user && remarks.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (line in remarks) Box(bubble) { MarkdownText(line) }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                if (!user && message.agentTasks.any { it.kind != "background" }) {
                    Column(Modifier.padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (task in message.agentTasks.filter { it.kind != "background" }) {
                            val live = task.status == "queued" || task.status == "running"
                            Text(
                                delegationLabel(task) + " ›",
                                fontSize = 12.sp,
                                color = if (task.status == "failed") Danger else if (live) Accent else Muted,
                                modifier = Modifier
                                    .background(if (live) AccentSoft else Card, RoundedCornerShape(999.dp))
                                    .clickable { onOpenBot(task.botId) }
                                    .padding(horizontal = 10.dp, vertical = 3.dp),
                            )
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                if (message.images.isNotEmpty()) {
                    Column(Modifier.widthIn(max = bubbleWidth), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (image in message.images) androidx.compose.runtime.key(image.id) {
                            ChatPicture(remote = image, botId = message.botId, messageId = message.id, repository = repository)
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                if (!user || message.content.isNotBlank()) Box(bubble) {
                    when {
                        user -> Text(message.content, color = Color.White, lineHeight = 21.sp)
                        message.content.isBlank() && message.status == "running" -> Text("…", color = Muted)
                        message.content.isBlank() && message.status == "cancelled" -> Text("已停止", color = Muted)
                        else -> MarkdownText(message.content)
                    }
                }
                if (!user && message.ui != null) {
                    Spacer(Modifier.height(8.dp))
                    A2uiContent(message, repository, message.status != "completed")
                }
                Spacer(Modifier.height(3.dp))
                val note = when (message.status) {
                    "failed" -> "失败"
                    "cancelled" -> "已停止"
                    else -> if (!user && message.executor == "cloud") "云端" else null
                }
                Text(listOfNotNull(dayLabel(message.createdAt) + " " + clockTime(message.createdAt), note).joinToString(" · "), fontSize = 11.sp, color = if (message.status == "failed") Danger else Muted)
            }
        }
    }
}

@Composable
private fun ApprovalCard(approval: Approval, onDecide: (Boolean) -> Unit) {
    var deciding by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().background(AccentSoft, RoundedCornerShape(18.dp)).padding(14.dp),
    ) {
        Text("想访问资料库以外的位置", fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Text(approval.path, fontFamily = FontFamily.Monospace, fontSize = 13.sp, modifier = Modifier.fillMaxWidth().background(Card, RoundedCornerShape(8.dp)).padding(8.dp))
        if (approval.reason.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(approval.reason, color = Ink.copy(alpha = 0.8f))
        }
        Spacer(Modifier.height(10.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            OutlinedButton(onClick = { deciding = true; onDecide(false) }, enabled = !deciding) { Text("拒绝") }
            Spacer(Modifier.size(8.dp))
            Button(onClick = { deciding = true; onDecide(true) }, enabled = !deciding) { Text("允许本次任务访问") }
        }
    }
}

@Composable
private fun Composer(botId: String, botName: String, text: String, onTextChange: (String) -> Unit, onSend: suspend (String, String, List<ChatImage>) -> Boolean) {
    val currentText by rememberUpdatedState(text)
    var sending by remember(botId) { mutableStateOf(false) }
    var retryText by rememberSaveable(botId) { mutableStateOf("") }
    var requestId by rememberSaveable(botId) { mutableStateOf(java.util.UUID.randomUUID().toString()) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var images by remember(botId) { mutableStateOf<List<ChatImage>>(emptyList()) }
    var reading by remember(botId) { mutableStateOf(false) }
    var imageError by remember(botId) { mutableStateOf<String?>(null) }
    var retryImages by remember(botId) { mutableStateOf<List<ChatImage>>(emptyList()) }
    var pickingFor by remember { mutableStateOf<String?>(null) }
    val currentBotId by rememberUpdatedState(botId)
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val targetBot = pickingFor
        pickingFor = null
        if (uris.isNotEmpty() && targetBot == botId && !reading && !sending) {
            reading = true
            imageError = null
            scope.launch {
                try { val selected = readChatImages(context, uris, images); if (currentBotId == targetBot) images = selected }
                catch (e: Exception) { if (currentBotId == targetBot) imageError = errorText(e) }
                finally { if (currentBotId == targetBot) reading = false }
            }
        }
    }
    Column {
        imageError?.let { Text(it, color = Danger, modifier = Modifier.padding(horizontal = 16.dp)) }
        if (images.isNotEmpty()) Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            images.forEachIndexed { index, image ->
                Column(Modifier.weight(1f)) {
                    ChatPicture(image = image, modifier = Modifier.height(76.dp))
                    TextButton(enabled = !sending && !reading, onClick = { images = images.filterIndexed { i, _ -> i != index } }) { Text("移除") }
                }
            }
        }
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Row(
            Modifier.widthIn(max = 760.dp).fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp)
                .background(Card, RoundedCornerShape(28.dp)).border(1.dp, Line, RoundedCornerShape(28.dp)).padding(start = 4.dp, end = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(enabled = !sending && !reading && images.size < 4, onClick = { pickingFor = botId; picker.launch(arrayOf("image/jpeg", "image/png", "image/webp", "image/gif")) }) {
                Icon(Icons.Filled.Add, "上传图片")
            }
            TextField(
                text, onTextChange,
                placeholder = { Text("向 $botName 提问", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                maxLines = 5,
                modifier = Modifier.weight(1f),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    disabledIndicatorColor = Color.Transparent,
                ),
            )
            IconButton(
                onClick = {
                    val draft = text
                    val value = draft.trim()
                    val attachments = images
                    val targetBot = botId
                    if ((value.isNotEmpty() || attachments.isNotEmpty()) && !sending && !reading) {
                        if (retryText != value || retryImages != attachments) { retryText = value; retryImages = attachments; requestId = java.util.UUID.randomUUID().toString() }
                        sending = true
                        scope.launch {
                            try {
                                if (onSend(value, requestId, attachments) && currentBotId == targetBot) {
                                    if (currentText == draft) onTextChange("")
                                    images = emptyList()
                                    retryImages = emptyList()
                                    retryText = ""
                                }
                            } finally { if (currentBotId == targetBot) sending = false }
                        }
                    }
                },
                enabled = (text.isNotBlank() || images.isNotEmpty()) && !sending && !reading,
                colors = IconButtonDefaults.iconButtonColors(containerColor = Accent, contentColor = Color.White, disabledContainerColor = Line, disabledContentColor = Muted),
            ) { Icon(Icons.AutoMirrored.Filled.Send, "发送", Modifier.size(20.dp)) }
        }
    }
    }
}
