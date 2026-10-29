package dev.pibot.android.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pibot.android.data.FileContent
import dev.pibot.android.data.FileEntry
import dev.pibot.android.data.FileList
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.face.PiBotFace
import dev.pibot.android.face.seedOf

/** Read-only browser for a bot's library on the selected source(`~/pi-bot/<slug>`). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(repository: PiBotRepository, botId: String, onBack: () -> Unit) {
    val bot by repository.bot(botId).collectAsStateWithLifecycle(null)
    val devices by repository.devices.collectAsStateWithLifecycle()
    var sources by remember(botId) { mutableStateOf<List<dev.pibot.android.data.FileSource>>(emptyList()) }
    var source by remember(botId) { mutableStateOf<String?>(null) }
    val targetOnline = sources.firstOrNull { it.target == source }?.online == true
    var path by remember { mutableStateOf("") }
    var opened by remember { mutableStateOf<String?>(null) }
    var list by remember { mutableStateOf<FileList?>(null) }
    var file by remember { mutableStateOf<FileContent?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(botId, devices) {
        runCatching { repository.fileSources(botId).sources }.onSuccess {
            sources = it
            if (source == null) source = it.firstOrNull { s -> s.online }?.target ?: it.firstOrNull()?.target
        }.onFailure { error = errorText(it) }
    }

    LaunchedEffect(path, reload, targetOnline, source) {
        list = null
        error = null
        if (source == null) return@LaunchedEffect
        runCatching { repository.files(botId, path, source) }.onSuccess { list = it }.onFailure { error = errorText(it) }
    }
    LaunchedEffect(opened, source, targetOnline, reload) {
        file = null
        val target = opened ?: return@LaunchedEffect
        runCatching { repository.file(botId, target, source) }.onSuccess { file = it }.onFailure { error = errorText(it); opened = null }
    }
    fun up() {
        when {
            opened != null -> opened = null
            path.isNotEmpty() -> path = path.substringBeforeLast('/', "")
            else -> onBack()
        }
    }
    BackHandler(enabled = opened != null || path.isNotEmpty()) { up() }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = ::up) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                title = {
                    Column {
                        Text(opened?.substringAfterLast('/') ?: "资料库", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text((sources.firstOrNull { it.target == source }?.label ?: "文件来源") + " / " + (opened ?: path), fontSize = 12.sp, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Paper),
            )
        },
        containerColor = Paper,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
          androidx.compose.foundation.lazy.LazyRow {
            items(sources, key = {it.target}) { item ->
              androidx.compose.material3.TextButton(onClick = {source=item.target;path="";opened=null;list=null;file=null}) {
                Text("${if(item.target == source) "✓ " else ""}${item.label} · ${if(item.online) "在线" else "离线"}")
              }
            }
          }
          Box(Modifier.fillMaxSize()) {
            val b = bot
            val entries = list?.entries
            val failure = error
            when {
                opened != null -> FilePreview(file)
                failure != null -> EmptyState(
                    b?.avatar ?: ORANGE, if (targetOnline) "error" else "sleeping",
                    if (targetOnline) "打不开" else "电脑离线", failure,
                ) { Button(onClick = { reload++ }) { Text("重试") } }
                source == null -> EmptyState(b?.avatar ?: ORANGE, "idle", "暂无文件来源", "添加电脑或启用云端环境后，可在这里选择文件来源。")
                entries == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                entries.isEmpty() -> EmptyState(b?.avatar ?: ORANGE, "idle", "这里还是空的", "让 ${b?.name ?: "Bot"} 写点东西进来吧。")
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(entries, key = { it.name }) { entry ->
                        EntryRow(entry) {
                            val child = if (path.isEmpty()) entry.name else "$path/${entry.name}"
                            if (entry.type == "dir") path = child else opened = child
                        }
                        HorizontalDivider(color = Line, modifier = Modifier.padding(start = 56.dp))
                    }
                }
            }
            if (b != null && opened == null && !entries.isNullOrEmpty()) {
                PiBotFace(b.avatar, "searching", 56.dp, seed = seedOf(b.id), modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp))
            }
        }
    }
  }
}

@Composable
private fun EntryRow(entry: FileEntry, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (entry.type == "dir") "📁" else "📄", fontSize = 22.sp, modifier = Modifier.size(32.dp))
        Spacer(Modifier.size(8.dp))
        Column(Modifier.weight(1f)) {
            Text(entry.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (entry.type != "dir") Text(humanSize(entry.size) + (entry.modified?.let { " · " + dayLabel(it) + " " + clockTime(it) } ?: ""), fontSize = 12.sp, color = Muted)
        }
        if (entry.type == "dir") Text("›", color = Muted, fontSize = 20.sp)
    }
}

@Composable
private fun FilePreview(file: FileContent?) {
    if (file == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    when (file.kind) {
        "text" -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            if (file.name.endsWith(".md", ignoreCase = true)) MarkdownText(file.content.orEmpty())
            else Text(
                file.content.orEmpty(),
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                modifier = Modifier.background(Card, RoundedCornerShape(12.dp)).horizontalScroll(rememberScrollState()).padding(12.dp),
                softWrap = false,
            )
            if (file.truncated) Text("文件较大，只显示前 512KB。", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
        }
        "image" -> {
            val bitmap = remember(file.base64) {
                runCatching { Base64.decode(file.base64, Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it, 0, it.size) } }.getOrNull()
            }
            if (bitmap != null) Image(bitmap.asImageBitmap(), file.name, Modifier.fillMaxSize().padding(16.dp), contentScale = ContentScale.Fit)
            else Unsupported(file)
        }
        else -> Unsupported(file)
    }
}

@Composable
private fun Unsupported(file: FileContent) {
    Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center) {
        Text("📄", fontSize = 48.sp)
        Text(file.name, fontWeight = FontWeight.SemiBold)
        Text("${humanSize(file.size)} · 手机上暂不支持预览，请在电脑的文件管理器里打开。", color = Muted)
    }
}

fun humanSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "%.1f KB".format(bytes / 1024.0)
    else -> "%.1f MB".format(bytes / 1024.0 / 1024.0)
}
