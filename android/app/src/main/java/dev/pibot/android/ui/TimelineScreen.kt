package dev.pibot.android.ui

import android.graphics.Rect
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
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
import androidx.compose.material.icons.filled.Phone
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import dev.pibot.android.data.LiveCall
import dev.pibot.android.voice.VoiceCallService
import dev.pibot.android.data.ChatImage
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.material3.AlertDialog
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
import dev.pibot.android.data.AgentTaskRef
import dev.pibot.android.data.Approval
import dev.pibot.android.data.Bot
import dev.pibot.android.data.FromBot
import dev.pibot.android.data.Message
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.domain.selectionScrollDelta
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
    onPhone: () -> Unit,
    onOpenBot: (String) -> Unit,
    expanded: Boolean = false,
    draft: String,
    onDraftChange: (String) -> Unit,
) {
    val bot by remember(repository, botId) { repository.bot(botId) }.collectAsStateWithLifecycle(null)
    val timeline by remember(repository, botId) { repository.timeline(botId) }.collectAsStateWithLifecycle(Timeline())
    val devices by repository.devices.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var error by remember(botId) { mutableStateOf<String?>(null) }
    var loadingMore by remember(botId) { mutableStateOf(false) }
    var menuOpen by remember(botId) { mutableStateOf(false) }
    val call by repository.liveCall.collectAsStateWithLifecycle()
    val notice by repository.voiceNotice.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.RECORD_AUDIO] == true) VoiceCallService.start(context, botId)
        else error = "需要麦克风权限才能语音通话"
    }
    LaunchedEffect(notice) {
        if (!notice.isNullOrBlank()) {
            error = notice
            repository.clearVoiceNotice()
        }
    }
    val startCall = {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            VoiceCallService.start(context, botId)
        } else {
            val perms = mutableListOf(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) perms.add(Manifest.permission.POST_NOTIFICATIONS)
            micPermission.launch(perms.toTypedArray())
        }
    }
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
    val selection = remember(botId) { MessageSelectionSession() }
    var frozenTimeline by remember(botId) { mutableStateOf<Timeline?>(null) }
    var frozenBot by remember(botId) { mutableStateOf<Bot?>(null) }
    val latestTimeline by rememberUpdatedState(timeline)
    val latestBot by rememberUpdatedState(current)
    selection.onActiveChanged = { active ->
        frozenTimeline = if (active) latestTimeline else null
        frozenBot = if (active) latestBot else null
    }
    val displayTimeline = frozenTimeline ?: timeline
    val displayBot = frozenBot ?: current
    BackHandler(selection.active != null) { selection.clear() }
    DisposableEffect(selection) { onDispose { selection.clear() } }

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
                    }
                }
                Box {
                    CircleAction("更多选项", { menuOpen = true }) { Icon(Icons.Filled.MoreVert, null) }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("云端桌面与文件") }, onClick = { menuOpen = false; scope.launch { runCatching { val url = repository.remoteDesktop(botId); context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) }.onFailure { error = errorText(it) } } })
                        DropdownMenuItem(text = { Text("资料库") }, onClick = { menuOpen = false; onFiles() })
                        DropdownMenuItem(text = { Text("虚拟手机") }, onClick = { menuOpen = false; onPhone() })
                        DropdownMenuItem(text = { Text("编辑 Bot") }, onClick = { menuOpen = false; onEdit() }, leadingIcon = { Icon(Icons.Filled.Edit, null) })
                    }
                }
            }
        },
        containerColor = Paper,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            val activeCall = call
            if (activeCall?.local == true && activeCall.botId == botId) {
                CallOverlay(current, activeCall, { VoiceCallService.setMuted(context, it) }) { VoiceCallService.hangup(context) }
                return@Column
            }
            val list = androidx.compose.runtime.key(botId) { rememberLazyListState() }
            val reversed = remember(displayTimeline.messages) { displayTimeline.messages.asReversed() }
            var viewport by remember { mutableStateOf(Rect()) }
            selection.reveal = { view, rect ->
                val location = IntArray(2)
                view.getLocationInWindow(location)
                val top = location[1] + rect.top
                val bottom = location[1] + rect.bottom
                val margin = (24 * view.resources.displayMetrics.density).toInt()
                val delta = selectionScrollDelta(top, bottom, viewport.top, viewport.bottom, margin)
                if (delta != 0f) scope.launch { list.scrollBy(delta) }
            }
            val atTop by remember(list) { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index == list.layoutInfo.totalItemsCount - 1 } }
            LaunchedEffect(botId, atTop, timeline.hasMore, selection.active) {
                if (selection.active == null && atTop && timeline.hasMore && !loadingMore) {
                    loadingMore = true
                    runCatching { repository.loadMore(botId) }.onFailure { error = errorText(it) }
                    loadingMore = false
                }
            }
            CompositionLocalProvider(LocalMessageSelection provides selection) {
                LazyColumn(
                    state = list,
                    reverseLayout = true,
                    modifier = Modifier.weight(1f).fillMaxWidth().onGloballyPositioned {
                        val bounds = it.boundsInWindow()
                        viewport = Rect(bounds.left.toInt(), bounds.top.toInt(), bounds.right.toInt(), bounds.bottom.toInt())
                    },
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(displayBot.pendingApprovals, key = { "approval-${it.id}" }) { approval ->
                        ApprovalCard(approval) { decision ->
                            repository.decide(approval, decision)
                        }
                    }
                    displayBot.activity?.summary?.let { summary ->
                        item(key = "task-activity") {
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 6.dp)) {
                                PiBotFace(current.avatar, mood, 26.dp, seed = seedOf(current.id))
                                Spacer(Modifier.size(8.dp))
                                Text(summary, color = Muted, fontSize = 13.sp)
                            }
                        }
                    }
                    items(reversed, key = { it.id }) { message -> MessageItem(message, onOpenBot, repository) }
                    if (displayTimeline.loaded && displayTimeline.messages.isEmpty()) {
                        item { Intro(current) }
                    }
                }
            }
            error?.let {
                Text(it, color = Danger, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
            if (call != null && call?.botId != botId) {
                Text("语音通话在另一个对话里", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            } else if (call != null && call?.local != true) {
                Text("正在其他设备通话", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
            val callBlocked = call?.local == true || call?.botId == botId
            Composer(botId, current.name, draft, onDraftChange, onCall = startCall, callEnabled = !callBlocked) { text, requestId, images ->
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
        CopyableMessage(
            text = message.content,
            modifier = Modifier.widthIn(max = bubbleWidth)
                .background(AccentSoft, RoundedCornerShape(18.dp))
                .padding(horizontal = 14.dp, vertical = 10.dp),
        )
        Spacer(Modifier.height(3.dp))
        Text(dayLabel(message.createdAt) + " " + clockTime(message.createdAt), fontSize = 11.sp, color = Muted)
    }
}

@Composable
private fun MessageItem(message: Message, onOpenBot: (String) -> Unit, repository: PiBotRepository) {
    val context=LocalContext.current
    val scope=rememberCoroutineScope()
    var artifactError by remember { mutableStateOf<String?>(null) }
    var selectedTask by remember(message.id) { mutableStateOf<AgentTaskRef?>(null) }
    selectedTask?.let { TaskConversationDialog(message.botId, it, repository, { selectedTask = null }, onOpenBot) }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val bubbleWidth = (maxWidth * 0.92f).coerceAtMost(600.dp)
        val from = message.fromBot
        if (message.role == "user" && from != null) {
            RelayItem(message, from, onOpenBot, bubbleWidth)
        } else {
            val user = message.role == "user"
            val remarks = if (message.replySegments.isEmpty()) message.progress else emptyList()
            val showContent = message.content.isNotBlank() && message.replySegments.none { it.phase == "answer" }
            Column(Modifier.fillMaxWidth(), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
                val bubble = Modifier
                    .widthIn(max = bubbleWidth)
                    .background(if (user) Ink else Card, RoundedCornerShape(18.dp))
                    .padding(horizontal = 14.dp, vertical = 10.dp)
                if (!user && remarks.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (line in remarks) CopyableMessage(text = line, modifier = bubble)
                    }
                    Spacer(Modifier.height(6.dp))
                }
                if (!user) for (segment in message.replySegments) {
                    CopyableMessage(text = segment.text, modifier = bubble)
                    Text(clockTime(segment.createdAt), color = Muted, fontSize = 11.sp, modifier = Modifier.padding(vertical = 3.dp))
                    Spacer(Modifier.height(3.dp))
                }
                if (!user && message.agentTasks.any { it.kind != "background" }) {
                    Column(Modifier.padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (task in message.agentTasks.filter { it.kind != "background" }) {
                            val live = task.status == "queued" || task.status == "running"
                            Text(
                                "${task.messageCount} 条消息往来 · ${task.botName} · ${taskState(task.status)} ›",
                                fontSize = 12.sp,
                                color = if (task.status == "failed") Danger else if (live) Accent else Muted,
                                modifier = Modifier
                                    .background(if (live) AccentSoft else Card, RoundedCornerShape(999.dp))
                                    .clickable { selectedTask = task }
                                    .padding(horizontal = 10.dp, vertical = 3.dp),
                            )
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                message.attachments.forEach { file ->
                    androidx.compose.material3.OutlinedCard(
                        onClick = {
                            scope.launch {
                                runCatching {
                                    val url = repository.reportOpen(file.id)
                                    context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
                                }.onFailure { artifactError = errorText(it) }
                            }
                        },
                        modifier = Modifier.widthIn(max = bubbleWidth),
                    ) {
                        Column(Modifier.padding(16.dp)) {
                            Text(file.title,fontWeight=androidx.compose.ui.text.font.FontWeight.SemiBold)
                            Text("Markdown · ${file.size / 1024 + 1} KB · 打开报告 ›",color=Muted)
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                artifactError?.let { Text(it,color=Danger) }
                if (message.images.isNotEmpty()) {
                    Column(Modifier.widthIn(max = bubbleWidth), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (image in message.images) androidx.compose.runtime.key(image.id) {
                            ChatPicture(remote = image, botId = message.botId, messageId = message.id, repository = repository)
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
                if (user && message.content.isNotBlank() || !user && (showContent || message.replySegments.isEmpty())) {
                    when {
                        message.content.isNotBlank() -> CopyableMessage(
                            text = message.content, modifier = bubble,
                            markdown = !user, color = if (user) Color.White else Ink,
                        )
                        message.status == "running" -> Box(bubble) { Text("…", color = Muted) }
                        message.status == "cancelled" -> Box(bubble) { Text("已停止", color = Muted) }
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
                if (message.replySegments.isEmpty() || note != null) Text(listOfNotNull((dayLabel(message.createdAt) + " " + clockTime(message.createdAt)).takeIf { message.replySegments.isEmpty() }, note).joinToString(" · "), fontSize = 11.sp, color = if (message.status == "failed") Danger else Muted)
            }
        }
    }
}

@Composable
private fun ApprovalCard(approval: Approval, onDecide: suspend (String) -> Unit) {
    var deciding by remember { mutableStateOf(false) }
    var confirmAlways by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun decide(decision: String) {
        deciding = true; error = null
        scope.launch {
            try { onDecide(decision) } catch (e: Exception) { error = errorText(e) }
            finally { deciding = false }
        }
    }
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
        Text(approval.scope, fontSize = 12.sp)
        error?.let { Text(it, color = Danger) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = { decide("reject") }, enabled = !deciding) { Text("拒绝") }
            Spacer(Modifier.size(8.dp))
            TextButton(onClick = { decide("approve") }, enabled = !deciding) { Text("仅本次允许") }
            TextButton(onClick = { confirmAlways = true }, enabled = !deciding && approval.canRemember) { Text("一直允许") }
        }
        if (!approval.canRemember) Text("写入、命令和旧版宽泛权限需要逐次确认。", color = Muted, fontSize = 12.sp)
    }
    if (confirmAlways) AlertDialog(
        onDismissRequest = { confirmAlways = false }, title = { Text("记住以下权限？") },
        text = { Text("${approval.scope}\n可在设置 → 已保存授权中撤销。") },
        confirmButton = { TextButton(onClick = { confirmAlways = false; decide("approve_always") }) { Text("一直允许") } },
        dismissButton = { TextButton(onClick = { confirmAlways = false }) { Text("取消") } },
    )
}

@Composable
private fun CallOverlay(bot: Bot, call: LiveCall, onMute: (Boolean) -> Unit, onHangup: () -> Unit) {
    val now = rememberNow(1_000)
    val phase = when (call.phase) {
        "connecting" -> "接通中"
        "listening" -> "正在听"
        "speaking" -> "正在说"
        "thinking" -> "想一下"
        else -> "通话中"
    }
    val mood = when (call.phase) {
        "speaking" -> "working"
        "thinking", "connecting" -> "thinking"
        else -> "happy"
    }
    val elapsed = if (call.startedAt > 0) now - call.startedAt else 0L
    val seconds = (elapsed / 1000).coerceAtLeast(0)
    val clock = "%02d:%02d".format(seconds / 60, seconds % 60)
    Column(
        Modifier.fillMaxSize().navigationBarsPadding().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        PiBotFace(bot.avatar, mood, 180.dp, seed = seedOf(bot.id))
        Spacer(Modifier.height(16.dp))
        Text(bot.name, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Text(call.error ?: phase, color = if (call.error != null) Danger else Muted)
        Spacer(Modifier.height(8.dp))
        Text(clock, fontSize = 28.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(28.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = { onMute(!call.muted) }) { Text(if (call.muted) "取消静音" else "静音") }
            Button(onClick = onHangup, colors = ButtonDefaults.buttonColors(containerColor = Danger, contentColor = Color.White)) { Text("挂断") }
        }
    }
}

@Composable
private fun Composer(botId: String, botName: String, text: String, onTextChange: (String) -> Unit, onCall: () -> Unit, callEnabled: Boolean, onSend: suspend (String, String, List<ChatImage>) -> Boolean) {
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
            IconButton(enabled = callEnabled && !sending, onClick = onCall) { Icon(Icons.Filled.Phone, "语音通话") }
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
