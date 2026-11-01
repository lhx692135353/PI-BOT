package dev.pibot.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import dev.pibot.android.BuildConfig
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.update.ClientUpdater
import dev.pibot.android.update.UpdateCandidate
import kotlinx.coroutines.launch

@Composable
fun ClientUpdateSettings(repository: PiBotRepository) {
    val context = LocalContext.current
    val updater = remember { ClientUpdater(context) }
    val prefs = remember { context.getSharedPreferences("client-update", 0) }
    var channel by remember { mutableStateOf(prefs.getString("channel", "stable") ?: "stable") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var candidate by remember { mutableStateOf<UpdateCandidate?>(null) }
    var ready by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var progress by remember { mutableStateOf<Float?>(null) }
    val scope = rememberCoroutineScope()
    Column {
        Text("客户端更新 · ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        Text("默认稳定版；测试版来自 main 的成功构建，可能不稳定。更新不经过你的 Server。", color = Muted)
        Row {
            listOf("stable" to "稳定版", "test" to "测试版").forEach { (value, label) ->
                TextButton(enabled = !busy, onClick = {
                    channel = value; prefs.edit().putString("channel", value).apply()
                    candidate = null; ready = false; message = ""; failed = false; progress = null
                }) { Text(if (channel == value) "✓ $label" else label) }
            }
        }
        OutlinedButton(enabled = !busy, onClick = {
            busy = true; candidate = null; ready = false; message = "正在检查更新…"; failed = false; progress = null
            scope.launch {
                try { candidate = updater.check(channel); message = candidate?.let { "可更新至 ${it.version} · ${it.commit.take(7)}" } ?: "已是当前通道最新版本（暂无更高构建）" }
                catch (e: Exception) { failed = true; message = "检查失败：${e.message ?: "网络不可用"}" }
                finally { busy = false }
            }
        }) { Text("检查更新") }
        val update = candidate
        if (update != null) {
            OutlinedButton(enabled = !busy, onClick = {
                if (ready) confirm = true
                else {
                    busy = true; message = "正在下载并校验…"; failed = false; progress = 0f
                    scope.launch {
                        try { updater.download(update) { downloaded, total ->
                            progress = downloaded.toFloat() / total
                            message = if (downloaded == total) "下载完成，正在校验安装包和签名…" else "正在下载 ${(downloaded * 100 / total)}%"
                        }; ready = true; message = "安装包及签名已校验，等待你确认安装" }
                        catch (e: Exception) { failed = true; message = "下载失败：${e.message ?: "旧版仍可使用"}" }
                        finally { busy = false; progress = null }
                    }
                }
            }) { Text(if (ready) "安装更新" else "下载更新") }
        }
        progress?.let { LinearProgressIndicator(progress = { it }) }
        if (message.isNotEmpty()) Text(message, color = if (failed) Danger else Muted)
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("确认升级") },
        text = { Text("请先结束任务、通话和手机控制；服务器离线时，活动状态可能不完整，请自行确认已结束。安装会关闭当前客户端，但不会清除本地配置。系统仍会再次要求你确认。若需允许安装来源，授权后请回到这里再次点击安装。") },
        confirmButton = { TextButton(enabled = !busy, onClick = {
            confirm = false; busy = true
            scope.launch {
                try {
                    // Refresh when available; update installation itself must not require NAS.
                    runCatching { repository.refreshBots() }
                    val active = repository.bots.value.orEmpty().any {
                        it.latestRun?.active == true || it.activeTasks.isNotEmpty() ||
                            (it.activity?.runningCount ?: 0) > 0 || (it.activity?.queuedCount ?: 0) > 0
                    }
                    check(!active) { "仍有任务运行，请结束任务后再安装；安装包已保留" }
                    updater.verifyReady(candidate ?: error("更新信息失效"))
                    val permission = updater.permissionIntent()
                    context.startActivity(permission ?: updater.installIntent())
                    message = if (permission != null) "请允许此来源安装，返回后再次点击安装更新" else "已交给系统安装器，请确认安装"
                } catch (e: Exception) { failed = true; message = "安装失败：${e.message ?: "旧版不受影响"}" }
                finally { busy = false }
            }
        }) { Text("已结束活动，继续") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("稍后") } },
    )
}
