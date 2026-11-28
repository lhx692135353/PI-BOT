package dev.pibot.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import dev.pibot.android.face.IronManAvatar
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.Switch
import androidx.compose.ui.Alignment
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import dev.pibot.android.voice.VoiceCallService
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pibot.android.BuildConfig
import dev.pibot.android.PiBotApp
import android.content.Intent
import android.provider.Settings
import dev.pibot.android.data.Device
import dev.pibot.android.data.PiBotRepository
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    repository: PiBotRepository,
    onBack: () -> Unit,
    onPhone: (String) -> Unit = {},
    onPreviewIntro: () -> Unit = {},
) {
    val session by repository.session.collectAsStateWithLifecycle()
    val computer by repository.computer.collectAsStateWithLifecycle()
    val live by repository.live.collectAsStateWithLifecycle()
    val devices by repository.devices.collectAsStateWithLifecycle()
    val cloud by repository.cloudComputer.collectAsStateWithLifecycle()
    val call by repository.liveCall.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val app = context.applicationContext as PiBotApp
    val push = app.push
    val skinStore = app.skinStore
    val currentSkin by skinStore.skin.collectAsStateWithLifecycle()
    val pushStatus by push.status.collectAsStateWithLifecycle()
    val pushRestartRequired by push.restartRequired.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var removing by remember { mutableStateOf<Device?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var changing by remember { mutableStateOf(false) }
    var pstack by remember { mutableStateOf<Boolean?>(null) }
    var savingPstack by remember { mutableStateOf(false) }
    var savingSkin by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { runCatching { repository.refreshMe() }.onFailure { error = errorText(it) } }
    LaunchedEffect(repository) {
        runCatching { repository.preferences() }.onSuccess {
            pstack = it.pstackEnabled
            skinStore.applyFromServer(it.skin)
        }.onFailure { error = errorText(it) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Paper),
            )
        },
        containerColor = Paper,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp)) {
            Group("外观与皮肤 · 随账号多端同步") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (option in AppSkin.entries) {
                        val selected = currentSkin == option
                        Column(
                            Modifier
                                .weight(1f)
                                .background(if (selected) AccentSoft else Paper, RoundedCornerShape(12.dp))
                                .border(BorderStroke(if (selected) 2.dp else 1.dp, if (selected) Accent else Line), RoundedCornerShape(12.dp))
                                .clickable(enabled = !savingSkin && !selected) {
                                    savingSkin = true
                                    skinStore.setLocal(option)
                                    scope.launch {
                                        try {
                                            val updated = repository.setPreferences(skin = option.wire)
                                            skinStore.applyFromServer(updated.skin)
                                        } catch (e: Exception) {
                                            error = errorText(e)
                                        } finally {
                                            savingSkin = false
                                        }
                                    }
                                }
                                .padding(12.dp),
                        ) {
                            Text(option.label, fontWeight = FontWeight.SemiBold, color = Ink)
                            Spacer(Modifier.height(4.dp))
                            Text(
                                if (option == AppSkin.IRONMAN) "红金反应堆配色 · 12 款固定机甲头像" else "经典暖纸界面 · 原生 Bot 头像",
                                color = Muted,
                                fontSize = 12.sp,
                            )
                        }
                    }
                }
                if (currentSkin == AppSkin.IRONMAN) {
                    Spacer(Modifier.height(12.dp))
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(ARMOR_MODELS) { armor ->
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                IronManAvatar(seed = armor.code, mood = "happy", size = 40.dp, armorIndex = armor.id)
                                Spacer(Modifier.height(2.dp))
                                Text(armor.code, color = Muted, fontSize = 10.sp)
                            }
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("每个 Bot 按 ID 固定分配机甲，不改动原头像", color = Muted, fontSize = 12.sp, modifier = Modifier.weight(1f))
                        TextButton(onClick = onPreviewIntro) { Text("预览启动动画") }
                    }
                }
            }
            Group("账号") {
                Item("用户", session?.user?.let { it.displayName.ifBlank { it.username } } ?: "")
                Item("服务器", session?.serverUrl ?: "")
                Item("实时连接", if (live) "已连接" else "未连接", last = true)
            }
            Group("开发") {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Pi 写代码时使用 pstack", modifier = Modifier.weight(1f))
                    Switch(checked = pstack ?: false, enabled = pstack != null && !savingPstack, onCheckedChange = { enabled ->
                        savingPstack = true
                        scope.launch {
                            try { pstack = repository.setPreferences(enabled).pstackEnabled }
                            catch (e: Exception) { error = errorText(e) }
                            finally { savingPstack = false }
                        }
                    })
                }
            }
            Group("通知") {
                Item("推送状态", pushStatus, last = true)
                if (pushRestartRequired) TextButton(onClick = push::restart) { Text("重新启动应用以启用通知") }
                TextButton(onClick = {
                    context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                }) { Text("系统通知设置") }
            }
            Group("执行电脑") {
                cloud?.let { Item(it.label, "Linux · ${if (it.online) "在线" else "准备中"} · 资料库") }
                if (cloud == null && devices.none { it.revokedAt == null }) Text("在 Mac 或 Linux 上安装 Pi Bot，并用同一个账号登录，即可添加执行电脑。", color = Muted, fontSize = 14.sp)
                for (d in devices.filter { it.revokedAt == null }.distinctBy { it.id }) {
                    Item(d.label, "${when (d.platform) { "linux" -> "Linux"; "darwin" -> "macOS"; "win32" -> "Windows"; else -> "未知平台" }} · ${if (d.online) "在线" else "离线"}")
                    TextButton(onClick = { onPhone(d.id) }) { Text("手机画面与控制") }
                    TextButton(onClick = { removing = d }) { Text("解绑", color = Danger) }
                }
                Text("任务默认在云端电脑上执行，需要你电脑上的文件或应用时才用那台电脑。资料库以云端电脑为准，电脑资料库里生成的文件会同步一份到云端。", color = Muted, fontSize = 12.sp)
                error?.let { Text(it, color = Danger) }
            }
            Spacer(Modifier.height(20.dp))
            OutlinedButton(onClick = { changing = true }, modifier = Modifier.fillMaxWidth()) { Text("修改密码") }
            Spacer(Modifier.height(10.dp))
            OutlinedButton(onClick = {
                if (call?.local == true) VoiceCallService.hangup(context)
                repository.logout()
            }, modifier = Modifier.fillMaxWidth()) { Text("退出登录", color = Danger) }
            Spacer(Modifier.height(20.dp))
            ClientUpdateSettings(repository)
            Spacer(Modifier.height(20.dp))
            SavedAuthorizations(repository)
            Spacer(Modifier.height(20.dp))
            Text("Pi Bot ${BuildConfig.VERSION_NAME}", color = Muted, fontSize = 12.sp, modifier = Modifier.fillMaxWidth())
        }
    }
    removing?.let { d -> AlertDialog(
        onDismissRequest = { removing = null }, title = { Text("解绑「${d.label}」？") },
        text = { Text("文件会保留；新任务会选择其他可用机器。依赖该电脑文件的任务将暂时无法执行。") },
        confirmButton = { TextButton(onClick = { removing = null; scope.launch { runCatching { repository.revokeDevice(d.id) }.onFailure { error = errorText(it) } } }) { Text("解绑", color = Danger) } },
        dismissButton = { TextButton(onClick = { removing = null }) { Text("取消") } },
    ) }
    if (changing) PasswordDialog(repository) { changing = false }
}

@Composable
private fun Group(title: String, content: @Composable () -> Unit) {
    Text(title, fontWeight = FontWeight.SemiBold, color = Muted, fontSize = 13.sp, modifier = Modifier.padding(start = 4.dp, top = 12.dp, bottom = 6.dp))
    Column(Modifier.fillMaxWidth().background(Card, RoundedCornerShape(18.dp)).padding(horizontal = 16.dp, vertical = 6.dp)) { content() }
}

@Composable
private fun Item(label: String, value: String, last: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Text(label, modifier = Modifier.weight(0.35f))
        Text(value, color = Muted, modifier = Modifier.weight(0.65f))
    }
    if (!last) HorizontalDivider(color = Line)
}

@Composable
private fun PasswordDialog(repository: PiBotRepository, onClose: () -> Unit) {
    var old by remember { mutableStateOf("") }
    var new by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("修改密码") },
        text = {
            Column {
                OutlinedTextField(old, { old = it }, label = { Text("原密码") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(new, { new = it }, label = { Text("新密码（至少 8 位）") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                error?.let { Text(it, color = Danger, modifier = Modifier.padding(top = 8.dp)) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && old.isNotEmpty() && new.length >= 8, onClick = {
                busy = true
                scope.launch {
                    try {
                        repository.changePassword(old, new)
                        onClose()
                    } catch (e: Exception) {
                        error = errorText(e)
                    } finally {
                        busy = false
                    }
                }
            }) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("取消") } },
    )
}
