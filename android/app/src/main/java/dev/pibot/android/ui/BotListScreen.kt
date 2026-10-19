package dev.pibot.android.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pibot.android.data.Bot
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.domain.epochMillis
import dev.pibot.android.domain.mood
import dev.pibot.android.domain.statusLine
import dev.pibot.android.face.PiBotFace
import dev.pibot.android.face.seedOf
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotListScreen(
    repository: PiBotRepository,
    onOpen: (String) -> Unit,
    onCreate: () -> Unit,
    onSettings: () -> Unit,
    selectedId: String? = null,
    expanded: Boolean = false,
) {
    val bots by repository.bots.collectAsStateWithLifecycle()
    val mac by repository.mac.collectAsStateWithLifecycle()
    val session by repository.session.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    val now = rememberNow()
    val listState = rememberLazyListState()
    val username = session?.user?.let { it.displayName.ifBlank { it.username } }.orEmpty()

    suspend fun refresh() {
        try {
            repository.refreshBots()
            error = null
        } catch (e: Exception) {
            error = errorText(e)
        }
    }
    LaunchedEffect(Unit) { refresh() }

    Scaffold(
        topBar = {
            Column(Modifier.statusBarsPadding()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (!expanded) AccountAvatar(username, onSettings)
                    else Text("Pi Bot", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.weight(1f))
                    CircleAction(if (searching) "关闭搜索" else "搜索 Bot", onClick = {
                        searching = !searching
                        if (!searching) query = ""
                    }) { Icon(if (searching) Icons.Filled.Close else Icons.Filled.Search, null, Modifier.size(21.dp)) }
                    CircleAction("新建 Bot", onClick = onCreate) { Icon(Icons.Filled.Add, null, Modifier.size(24.dp)) }
                }
                AnimatedVisibility(searching) {
                    OutlinedTextField(
                        query, { query = it }, placeholder = { Text("搜索名字或最近消息") },
                        leadingIcon = { Icon(Icons.Filled.Search, null) },
                        singleLine = true, shape = RoundedCornerShape(18.dp),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                }
            }
        },
        bottomBar = {
            if (expanded) Row(
                Modifier.fillMaxWidth().background(Paper).navigationBarsPadding().padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AccountAvatar(username, onSettings)
                Text(username, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 10.dp))
                MacChip(mac.online)
            }
        },
        containerColor = Paper,
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
            modifier = Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding),
        ) {
            val all = bots
            val main = all?.firstOrNull { it.isMain } ?: all?.firstOrNull()
            val filtered = all.orEmpty().filter {
                query.isBlank() || it.name.contains(query.trim(), ignoreCase = true) || it.lastMessage?.preview?.contains(query.trim(), ignoreCase = true) == true
            }
            LazyColumn(
                state = listState,
                contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 24.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                item(key = "hero") {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Box(
                            Modifier.clip(RoundedCornerShape(28.dp))
                                .clickable(enabled = main != null, role = Role.Button, onClickLabel = "打开主 Bot") { main?.let { onOpen(it.id) } }
                                .padding(horizontal = 24.dp, vertical = 4.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            PiBotFace(main?.avatar ?: ORANGE, main?.mood(now) ?: "happy", 136.dp, seed = seedOf(main?.id ?: "welcome"), entrance = true)
                            if (main?.isMain == true) Box(
                                Modifier.align(Alignment.BottomEnd).padding(end = 20.dp, bottom = 12.dp).size(23.dp).background(Accent, CircleShape),
                                contentAlignment = Alignment.Center,
                            ) { Text("★", color = Color.White, fontSize = 13.sp, lineHeight = 16.sp) }
                        }
                        Text(main?.name ?: "Pi Bot", color = Muted, fontSize = 16.sp, lineHeight = 22.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                item(key = "section") {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(if (searching) "搜索结果" else "我的 Bot", color = Muted, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium)
                        Spacer(Modifier.weight(1f))
                        if (!expanded) MacChip(mac.online)
                    }
                }
                if (!mac.online && all != null) item(key = "offline") {
                    Text("Mac 离线 · 仍可聊天和联网搜索，资料库暂不可用", color = Muted, fontSize = 12.sp, lineHeight = 18.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp))
                }
                error?.let { message -> item(key = "error") {
                    Column(Modifier.padding(8.dp)) {
                        Text(message, color = Danger, fontSize = 13.sp)
                        Button(onClick = { scope.launch { refresh() } }) { Text("重试") }
                    }
                } }
                when {
                    all == null && error == null -> item { Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp)) } }
                    all?.isEmpty() == true -> item {
                        Column(Modifier.fillMaxWidth().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("新建你的第一个 Bot", fontWeight = FontWeight.SemiBold)
                            Text("每个 Bot 都有自己的性格和长期记忆。", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(vertical = 10.dp))
                            Button(onClick = onCreate) { Text("新建 Bot") }
                        }
                    }
                    all != null && filtered.isEmpty() -> item { Text("没有找到相关 Bot", color = Muted, modifier = Modifier.padding(20.dp)) }
                }
                items(filtered, key = { it.id }) { bot ->
                    BotConversationRow(bot, now, selectedId == bot.id) { onOpen(bot.id) }
                }
            }
        }
    }
}

@Composable
private fun AccountAvatar(name: String, onClick: () -> Unit) {
    Box(
        Modifier.size(48.dp).clip(CircleShape).background(AccentSoft)
            .clickable(onClickLabel = "账号与设置", role = Role.Button, onClick = onClick)
            .semantics { contentDescription = "账号与设置" },
        contentAlignment = Alignment.Center,
    ) { Text(name.firstOrNull()?.uppercase() ?: "P", color = Accent, fontSize = 18.sp, fontWeight = FontWeight.SemiBold) }
}

@Composable
private fun BotConversationRow(bot: Bot, now: Long, selected: Boolean, onClick: () -> Unit) {
    val waiting = bot.pendingApprovals.isNotEmpty()
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp))
            .background(if (selected) AccentSoft else Color.Transparent)
            .selectable(selected = selected, role = Role.Button, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            PiBotFace(bot.avatar, bot.mood(now), 54.dp, seed = seedOf(bot.id), paused = true, effects = false)
            if (waiting) Box(Modifier.align(Alignment.TopEnd).size(9.dp).background(Danger, CircleShape).semantics { contentDescription = "有待审批请求" })
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(bot.name, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Text(conversationTime(bot.lastMessage?.createdAt ?: bot.lastActiveAt, now), color = Muted, fontSize = 11.sp, lineHeight = 16.sp)
            }
            Text(bot.statusLine(now), color = if (waiting) Accent else Muted, fontSize = 13.sp, lineHeight = 19.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

private fun conversationTime(iso: String, now: Long): String {
    val zone = ZoneId.systemDefault()
    val date = epochMillis(iso)?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() } ?: return ""
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    return when (date) {
        today -> clockTime(iso)
        today.minusDays(1) -> "昨天"
        else -> "${date.monthValue}/${date.dayOfMonth}"
    }
}
