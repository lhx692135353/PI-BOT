package dev.pibot.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.pibot.android.data.BotInput
import dev.pibot.android.data.Model
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.face.Avatar
import dev.pibot.android.face.BotFaceAssets
import dev.pibot.android.face.COLORS
import dev.pibot.android.face.PiBotFace
import dev.pibot.android.face.SHAPES
import dev.pibot.android.face.avatarFor
import dev.pibot.android.face.parseColor
import kotlinx.coroutines.launch
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun BotEditorScreen(repository: PiBotRepository, botId: String?, onDone: (String?) -> Unit, onArchived: () -> Unit) {
    val context = LocalContext.current
    val spec = remember { BotFaceAssets.spec(context) }
    val existing = remember(botId) { botId?.let { id -> repository.bots.value?.firstOrNull { it.id == id } } }
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var persona by remember { mutableStateOf(existing?.persona ?: "") }
    var modelId by remember { mutableStateOf(existing?.modelId) }
    var avatar by remember { mutableStateOf(existing?.avatar?.normalized() ?: avatarFor(UUID.randomUUID().toString())) }
    var models by remember { mutableStateOf<List<Model>>(emptyList()) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmArchive by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { runCatching { repository.refreshMe(); models = repository.models() }.onFailure { error = errorText(it) } }

    fun save() {
        if (saving || name.isBlank()) return
        saving = true
        error = null
        scope.launch {
            try {
                val input = BotInput(name.trim(), persona.trim(), modelId, avatar)
                val bot = if (botId == null) repository.createBot(input) else repository.updateBot(botId, input)
                onDone(bot.id)
            } catch (e: Exception) {
                error = errorText(e)
            } finally {
                saving = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (botId == null) "新建 Bot" else "编辑 Bot") },
                navigationIcon = { IconButton(onClick = { onDone(null) }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                actions = { TextButton(onClick = { save() }, enabled = !saving && name.isNotBlank()) { Text(if (botId == null) "创建" else "保存", fontWeight = FontWeight.SemiBold) } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Paper),
            )
        },
        containerColor = Paper,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
            val dark = avatar.scheme == "dark"
            Column(
                Modifier.fillMaxWidth()
                    .background(Brush.verticalGradient(if (dark) listOf(Color(0xFF2C2D33), Color(0xFF1C1D21)) else listOf(Color(0xFFFFF6EE), Color(0xFFF6EFE7))), RoundedCornerShape(24.dp))
                    .padding(vertical = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                PiBotFace(avatar, "happy", 150.dp)
                Text(name.ifBlank { "新 Bot" }, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, color = if (dark) Color(0xFFF2F1EF) else Ink)
                Text("${spec.shape(avatar.shape).label} · ${spec.color(avatar.color).label}", color = Muted, fontSize = 13.sp)
                TextButton(onClick = { avatar = avatarFor(UUID.randomUUID().toString()).copy(scheme = avatar.scheme) }) { Text("随机换一个") }
            }
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(name, { name = it.take(40) }, label = { Text("名字") }, placeholder = { Text("例如：研究助理") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                persona, { persona = it.take(8000) },
                label = { Text("人设与职责") },
                placeholder = { Text("它负责做什么、用什么风格说话、有哪些习惯……") },
                minLines = 4,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            ModelPicker(models, modelId) { modelId = it }

            Section("造型")
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(SHAPES) { shape ->
                    val picked = shape == avatar.shape
                    Box(
                        Modifier.size(64.dp)
                            .background(if (picked) Card else Color(0xFFEFEBE5), RoundedCornerShape(16.dp))
                            .border(BorderStroke(2.dp, if (picked) Accent else Color.Transparent), RoundedCornerShape(16.dp))
                            .clickable { avatar = avatar.copy(shape = shape) },
                        contentAlignment = Alignment.Center,
                    ) { PiBotFace(avatar.copy(shape = shape), "idle", 56.dp, paused = true, effects = false) }
                }
            }

            Section("颜色")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                for (color in COLORS) {
                    val c = spec.color(color)
                    val picked = color == avatar.color
                    Box(
                        Modifier.size(34.dp)
                            .border(BorderStroke(2.dp, if (picked) Accent else Color.Transparent), CircleShape)
                            .padding(4.dp)
                            .background(Brush.linearGradient(c.light.map(::parseColor)), CircleShape)
                            .clickable { avatar = avatar.copy(color = color) },
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("深色", modifier = Modifier.weight(1f))
                androidx.compose.material3.Switch(checked = dark, onCheckedChange = { avatar = avatar.copy(scheme = if (it) "dark" else "light") })
            }

            if (botId == null) {
                Spacer(Modifier.height(8.dp))
                Text("资料库会建在电脑的 ~/pi-bot/ 下，以名字生成文件夹；改名不会移动文件夹。", color = Muted, fontSize = 13.sp)
            }
            error?.let { Spacer(Modifier.height(8.dp)); Text(it, color = Danger) }
            Spacer(Modifier.height(20.dp))
            Button(onClick = { save() }, enabled = !saving && name.isNotBlank(), modifier = Modifier.fillMaxWidth().height(50.dp)) {
                Text(if (botId == null) "创建" else "保存")
            }
            if (botId != null) {
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = { confirmArchive = true }, modifier = Modifier.fillMaxWidth()) { Text("归档这个 Bot", color = Danger) }
            }
            Spacer(Modifier.height(32.dp))
        }
    }

    if (confirmArchive && botId != null) {
        AlertDialog(
            onDismissRequest = { confirmArchive = false },
            title = { Text("归档「$name」？") },
            text = { Text("它会从列表消失。电脑上的资料库文件夹保留不动。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmArchive = false
                    scope.launch {
                        try {
                            repository.archiveBot(botId)
                            onArchived()
                        } catch (e: Exception) {
                            error = errorText(e)
                        }
                    }
                }) { Text("归档", color = Danger) }
            },
            dismissButton = { TextButton(onClick = { confirmArchive = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun Section(title: String) {
    Spacer(Modifier.height(18.dp))
    Text(title, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(8.dp))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelPicker(models: List<Model>, selected: String?, onSelect: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val default = models.firstOrNull { it.isDefault }
    val label = models.firstOrNull { it.id == selected }?.name ?: "跟随默认" + (default?.let { "（${it.name}）" } ?: "")
    Box {
        OutlinedTextField(
            label, {},
            readOnly = true,
            label = { Text("模型") },
            modifier = Modifier.fillMaxWidth(),
            enabled = false,
            colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(disabledTextColor = Ink, disabledBorderColor = Line, disabledLabelColor = Muted),
        )
        Box(Modifier.matchParentSize().clickable { open = true })
        DropdownMenu(open, { open = false }) {
            DropdownMenuItem(text = { Text("跟随默认" + (default?.let { "（${it.name}）" } ?: "")) }, onClick = { onSelect(null); open = false })
            for (m in models) DropdownMenuItem(text = { Text(m.name) }, onClick = { onSelect(m.id); open = false })
        }
    }
}
