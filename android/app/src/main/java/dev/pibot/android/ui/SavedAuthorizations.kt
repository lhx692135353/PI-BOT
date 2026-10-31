package dev.pibot.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.*
import androidx.compose.runtime.*
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.data.SavedAuthorization
import dev.pibot.android.data.AuthorizationLog
import kotlinx.coroutines.launch

@Composable
fun SavedAuthorizations(repository: PiBotRepository) {
    var rules by remember { mutableStateOf<List<SavedAuthorization>>(emptyList()) }
    var logs by remember { mutableStateOf<List<AuthorizationLog>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<SavedAuthorization?>(null) }
    var showLogs by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    suspend fun refresh() {
        busy = true; error = null
        try { rules = repository.authorizations(); logs = repository.authorizationLogs() }
        catch (e: Exception) { error = errorText(e) }
        finally { busy = false }
    }
    LaunchedEffect(repository) { refresh() }
    Column {
        Text("已保存授权")
        Text("仅当前账号、指定电脑和资源的读取；不包含写入、删除或执行命令。每次使用由服务器验证。", color = Muted)
        TextButton(enabled = !busy, onClick = { scope.launch { refresh() } }) { Text(if (busy) "正在加载…" else "刷新授权") }
        error?.let { Text(it, color = Danger) }
        if (!busy && error == null && rules.isEmpty()) Text("暂无已保存授权。", color = Muted)
        rules.forEach { rule ->
            Text("${rule.targetLabel} · 读取")
            Text(rule.resource + if (rule.resourceType == "directory") "（含子路径）" else "")
            Text("保存于 ${rule.createdAt}" + (rule.lastUsedAt?.let { " · 最近使用 $it" } ?: ""), color = Muted)
            TextButton(enabled = !busy, onClick = { removing = rule }) { Text("撤销", color = Danger) }
            HorizontalDivider()
        }
        TextButton(onClick = { showLogs = !showLogs }) { Text(if (showLogs) "收起授权日志" else "授权及使用日志（最近 100 条）") }
        if (showLogs) logs.forEach { log ->
            val action = when (log.action) { "grant" -> "保存授权"; "allow_once" -> "仅本次允许"; "reject" -> "拒绝"; "use" -> "使用授权"; "revoke" -> "撤销授权"; else -> log.action }
            Text("${log.createdAt} · $action · ${log.operation}\n${log.target}\n${log.resource}", color = Muted)
        }
    }
    removing?.let { rule -> AlertDialog(
        onDismissRequest = { removing = null }, title = { Text("撤销读取授权？") },
        text = { Text("${rule.targetLabel} · ${rule.resource}\n后续访问将重新确认。") },
        confirmButton = { TextButton(enabled = !busy, onClick = {
            removing = null; busy = true
            scope.launch {
                try { repository.revokeAuthorization(rule.id); refresh() }
                catch (e: Exception) { error = errorText(e) }
                finally { busy = false }
            }
        }) { Text("撤销", color = Danger) } },
        dismissButton = { TextButton(onClick = { removing = null }) { Text("取消") } },
    ) }
}
