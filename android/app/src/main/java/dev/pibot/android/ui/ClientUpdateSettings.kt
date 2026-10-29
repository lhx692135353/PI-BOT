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
    val scope = rememberCoroutineScope()
    Column {
        Text("客户端更新 · ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        Text("默认稳定版；测试版来自 main 的成功构建，可能不稳定。更新不经过你的 Server。", color = Muted)
        Row {
            listOf("stable" to "稳定版", "test" to "测试版").forEach { (value, label) ->
                TextButton(enabled = !busy, onClick = {
                    channel = value; prefs.edit().putString("channel", value).apply()
                    candidate = null; ready = false; message = ""
                }) { Text(if (channel == value) "✓ $label" else label) }
            }
        }
        OutlinedButton(enabled = !busy, onClick = {
            busy = true; candidate = null; ready = false; message = "正在检查…"
            scope.launch {
                try { candidate = updater.check(channel); message = candidate?.let { "可更新至 ${it.version} · ${it.commit.take(7)}" } ?: "当前通道暂无更高版本" }
                catch (e: Exception) { message = e.message ?: "检查失败" }
                finally { busy = false }
            }
        }) { Text("检查更新") }
        val update = candidate
        if (update != null) {
            OutlinedButton(enabled = !busy, onClick = {
                if (ready) confirm = true
                else {
                    busy = true; message = "正在下载并校验…"
                    scope.launch {
                        try { updater.download(update); ready = true; message = "安装包及签名已校验，等待你确认安装" }
                        catch (e: Exception) { message = e.message ?: "下载失败，旧版仍可使用" }
                        finally { busy = false }
                    }
                }
            }) { Text(if (ready) "安装更新" else "下载更新") }
        }
        if (message.isNotEmpty()) Text(message, color = Muted)
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
                } catch (e: Exception) { message = e.message ?: "暂不能安装，旧版不受影响" }
                finally { busy = false }
            }
        }) { Text("已结束活动，继续") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("稍后") } },
    )
}
