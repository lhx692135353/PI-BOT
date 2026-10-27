package dev.pibot.android.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.data.encodePhoneMap
import dev.pibot.android.data.isAcquireApplicable
import dev.pibot.android.data.phoneAssociationKey
import dev.pibot.android.data.readPhoneMap
import dev.pibot.android.data.resolvePhoneDevice
import dev.pibot.android.data.validateAcquireResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.hypot

private const val PREFS = "pibot.phone.assoc"
private const val ABSOLUTE_MS = 10 * 60 * 1000L
private const val IDLE_MS = 45_000L

private class PhoneLease {
    var deviceId: String? = null
    var sessionId: String? = null
    var hardEnd = 0L
    var idleEnd = 0L
}

/** Full-screen phone view. Preview does not hold a lease; takeover is explicit. Association stays on this app only. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhoneControlScreen(repository: PiBotRepository, botId: String?, fixedDeviceId: String?, onBack: () -> Unit) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val sessionState by repository.session.collectAsStateWithLifecycle()
    val accountKey = remember(sessionState?.user?.id, sessionState?.serverUrl) { phoneAssociationKey(sessionState?.user?.id, sessionState?.serverUrl) }
    val devices by repository.devices.collectAsStateWithLifecycle()
    val bots by repository.bots.collectAsStateWithLifecycle()
    val executionId = bots?.firstOrNull { it.id == botId }?.executionDeviceId
    val lease = remember { PhoneLease() }
    var foreground by remember { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    var deviceId by remember { mutableStateOf(fixedDeviceId) }
    var selectionAccount by remember { mutableStateOf(accountKey) }
    var controlling by remember { mutableStateOf(false) }
    var acquirePending by remember { mutableStateOf(false) }
    var acquireEpoch by remember { mutableLongStateOf(0L) }
    var frame by remember { mutableStateOf<ImageBitmap?>(null) }
    var notice by remember { mutableStateOf("只读预览，不占用控制权") }
    var actionError by remember { mutableStateOf<String?>(null) }
    var sessionMessage by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }
    var retry by remember { mutableIntStateOf(0) }
    var sending by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    var confirmTakeover by remember { mutableStateOf(false) }
    var showDetails by remember { mutableStateOf(false) }
    var previewError by remember { mutableStateOf<String?>(null) }
    var previewLoading by remember { mutableStateOf(true) }
    var updatedAt by remember { mutableStateOf<String?>(null) }
    var statusLabel by remember { mutableStateOf<String?>(null) }
    var available by remember { mutableStateOf(false) }
    var occupied by remember { mutableStateOf(false) }

    fun releaseCurrentLease() {
        val sid = lease.sessionId ?: return
        val did = lease.deviceId ?: return
        lease.sessionId = null
        lease.deviceId = null
        repository.releasePhoneSessionAsync(did, sid)
    }

    fun persist(next: String) {
        if (botId.isNullOrBlank()) return
        val prefs = context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
        val map = readPhoneMap(prefs.getString(accountKey, null)).toMutableMap()
        map[botId] = next
        prefs.edit().putString(accountKey, encodePhoneMap(map)).apply()
    }

    fun selectDevice(nextId: String?, saveMapping: Boolean) {
        if (deviceId == nextId) return
        acquireEpoch++
        acquirePending = false
        confirmTakeover = false
        val oldSid = lease.sessionId
        val oldDid = lease.deviceId
        lease.sessionId = null
        lease.deviceId = null
        controlling = false
        frame = null
        previewError = null
        previewLoading = true
        updatedAt = null
        draft = ""
        statusLabel = null
        available = false
        occupied = false
        actionError = null
        sessionMessage = null
        notice = "只读预览，不占用控制权"
        deviceId = nextId
        if (oldDid != null && oldSid != null) {
            repository.releasePhoneSessionAsync(oldDid, oldSid)
        }
        if (saveMapping && !nextId.isNullOrBlank()) {
            persist(nextId)
        }
    }

    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) {
                foreground = true
            }
            if (event == Lifecycle.Event.ON_STOP) {
                foreground = false
                confirmTakeover = false
                acquireEpoch++
                acquirePending = false
                draft = ""
                releaseCurrentLease()
                controlling = false
                frame = null
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose {
            owner.lifecycle.removeObserver(observer)
            acquireEpoch++
            acquirePending = false
            releaseCurrentLease()
        }
    }

    LaunchedEffect(botId, fixedDeviceId, devices, executionId, accountKey, sessionState?.token) {
        // Never retain a prior account's selection, preview or lease.
        if (selectionAccount != accountKey) {
            selectionAccount = accountKey
            selectDevice(null, saveMapping = false)
        }
        if (!fixedDeviceId.isNullOrBlank()) {
            if (deviceId != fixedDeviceId) selectDevice(fixedDeviceId, saveMapping = false)
            return@LaunchedEffect
        }
        val saved = botId?.let {
            readPhoneMap(context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).getString(accountKey, null))[it]
        }
        val resolved = resolvePhoneDevice(saved, executionId, devices).deviceId
        if (resolved != deviceId) {
            selectDevice(resolved, saveMapping = false)
        }
    }

    LaunchedEffect(deviceId, foreground, retry, accountKey, sessionState?.token) {
        if (!foreground) return@LaunchedEffect
        val id = deviceId ?: return@LaunchedEffect
        while (isActive) {
            try {
                val status = repository.phone(id, "status")
                if (deviceId == id) {
                    available = status["available"]?.jsonPrimitive?.contentOrNull == "true"
                    occupied = status["occupied"]?.jsonPrimitive?.contentOrNull == "true"
                    statusLabel = status["label"]?.jsonPrimitive?.contentOrNull
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (deviceId == id) {
                    available = false
                    occupied = false
                }
            }
            delay(5000)
        }
    }

    LaunchedEffect(deviceId, foreground, controlling, retry, accountKey, sessionState?.token) {
        val id = deviceId
        if (!foreground || id.isNullOrBlank()) return@LaunchedEffect
        if (!controlling) {
            previewLoading = frame == null
            previewError = null
            while (isActive) {
                try {
                    val result = repository.phone(id, "preview")
                    if (deviceId == id && !controlling && foreground) {
                        frame = decodeFrame(result)
                        previewError = null
                        previewLoading = false
                        updatedAt = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date())
                        notice = "只读预览"
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (deviceId == id) {
                        frame = null
                        previewLoading = false
                        previewError = phonePreviewHelp(e)
                    }
                }
                delay(650)
            }
            return@LaunchedEffect
        }
        val session = lease.sessionId
        if (session == null || lease.deviceId != id) {
            controlling = false
            return@LaunchedEffect
        }
        try {
            while (isActive) {
                val now = System.currentTimeMillis()
                if (now >= lease.hardEnd) {
                    sessionMessage = "已达到 10 分钟上限，接管已自动结束。"
                    break
                }
                if (now >= lease.idleEnd) {
                    sessionMessage = "连接长时间未成功，接管已自动结束。"
                    break
                }
                val result = repository.phone(id, "frame", buildJsonObject {
                    put("sessionId", JsonPrimitive(session))
                })
                if (deviceId == id && controlling && foreground) {
                    frame = decodeFrame(result)
                    lease.idleEnd = minOf(lease.hardEnd, System.currentTimeMillis() + IDLE_MS)
                    notice = "正在接管 · 可以点击和滑动屏幕"
                }
                delay(650)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (deviceId == id) {
                actionError = "连接中断，已结束接管。请确认网络和手机服务后重新接管。"
            }
        } finally {
            releaseCurrentLease()
            frame = null
            draft = ""
            controlling = false
        }
    }

    val selected = devices.firstOrNull { it.id == deviceId && it.revokedAt == null }

    suspend fun send(event: JsonObject) {
        val session = lease.sessionId ?: return
        val device = lease.deviceId ?: return
        try {
            val body = buildJsonObject {
                put("sessionId", JsonPrimitive(session))
                put("event", event)
            }
            repository.phone(device, "input", body)
            lease.idleEnd = minOf(lease.hardEnd, System.currentTimeMillis() + IDLE_MS)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            actionError = "操作未送达。请检查连接后重试；为避免重复操作，系统不会自动重发。"
        }
    }

    fun acquirePhone() {
        if (!foreground || selected?.online != true || !available || occupied || acquirePending) return
        val id = deviceId ?: return
        actionError = null
        sessionMessage = null
        val myEpoch = ++acquireEpoch
        acquirePending = true
        notice = "正在申请接管…"
        scope.launch {
            var remoteSessionToRelease: String? = null
            try {
                val acquired = repository.phone(id, "acquire")
                val validation = validateAcquireResponse(acquired, System.currentTimeMillis())
                if (validation.sessionId != null) {
                    remoteSessionToRelease = validation.sessionId
                }
                if (!validation.isSuccess) {
                    error(validation.error ?: "会话校验失败")
                }
                val session = validation.sessionId!!
                val expires = validation.expiresAtMs!!
                val now = System.currentTimeMillis()

                if (!isAcquireApplicable(id, deviceId, myEpoch, acquireEpoch, foreground)) {
                    error("接管环境已变更，放弃迟到会话")
                }

                lease.deviceId = id
                lease.sessionId = session
                lease.hardEnd = minOf(now + ABSOLUTE_MS, expires)
                lease.idleEnd = minOf(lease.hardEnd, now + IDLE_MS)
                controlling = true
                notice = "正在接管 · 可以点击和滑动屏幕"
                remoteSessionToRelease = null
            } catch (e: CancellationException) {
                remoteSessionToRelease?.let { orphan ->
                    repository.releasePhoneSessionAsync(id, orphan)
                }
                throw e
            } catch (e: Exception) {
                remoteSessionToRelease?.let { orphan ->
                    repository.releasePhoneSessionAsync(id, orphan)
                }
                if (isAcquireApplicable(id, deviceId, myEpoch, acquireEpoch, foreground)) {
                    actionError = "未能接管手机。请确认手机未被占用，稍后重试。"
                }
            } finally {
                if (acquireEpoch == myEpoch) {
                    acquirePending = false
                }
            }
        }
    }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("虚拟手机") },
            navigationIcon = { TextButton(onClick = onBack) { Text("返回") } }
        )
    }, containerColor = Paper) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Surface(color = Card, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(bots?.firstOrNull { it.id == botId }?.name?.let { "$it 的手机" } ?: "我的虚拟手机", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(if (controlling) "正在接管" else if (selected?.online == true && available) "只读预览" else "等待连接", color = if (controlling) Accent else if (selected?.online == true && available) Good else Muted,
                        style = MaterialTheme.typography.labelLarge)
                    if (fixedDeviceId == null) {
                        TextButton(onClick = { picking = true }) {
                            Text(selected?.let { "${it.label} · ${if (it.online) "在线" else "离线"} · 切换" } ?: "选择执行电脑")
                        }
                        DropdownMenu(expanded = picking, onDismissRequest = { picking = false }) {
                            devices.filter { it.revokedAt == null }.forEach { device ->
                                DropdownMenuItem(
                                    text = { Text("${device.label} · ${platformOf(device.platform)} · ${if (device.online) "在线" else "离线"}") },
                                    onClick = {
                                        picking = false
                                        selectDevice(device.id, saveMapping = true)
                                    }
                                )
                            }
                        }
                    } else {
                        Text(selected?.let { "${it.label} · ${platformOf(it.platform)} · ${if (it.online) "在线" else "离线"}" } ?: "这台执行电脑已不可用")
                    }
                    Text(phoneAvailabilityHint(selected != null, selected?.online == true, available, occupied),
                        color = Muted, style = MaterialTheme.typography.bodyMedium)
                }
            }
            if (!controlling) {
                if (previewError != null) {
                    Surface(color = Card, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("暂时无法预览", fontWeight = FontWeight.SemiBold)
                            Text(previewError.orEmpty(), color = Muted)
                            TextButton(onClick = { retry++ }) { Text("重新读取预览") }
                        }
                    }
                } else if (frame == null) {
                    Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (previewLoading && selected?.online == true) CircularProgressIndicator()
                        Text(if (selected?.online == true) "正在连接手机…" else "等待连接", color = Muted)
                    }
                }
            }

            frame?.let { image ->
                Image(
                    bitmap = image,
                    contentDescription = if (controlling) "手机当前画面，可以操作" else "手机只读预览",
                    modifier = Modifier
                        .widthIn(max = 280.dp)
                        .fillMaxWidth()
                        .aspectRatio(720f / 1280f)
                        .background(Card, RoundedCornerShape(16.dp))
                        .pointerInput(controlling, lease.sessionId) {
                            if (!controlling) return@pointerInput
                            awaitEachGesture {
                                val down = awaitFirstDown(requireUnconsumed = false)
                                val start = down.position
                                var end = start
                                val at = down.uptimeMillis
                                var lastAt = at
                                do {
                                    val event = awaitPointerEvent()
                                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                    end = change.position
                                    lastAt = change.uptimeMillis
                                    change.consume()
                                } while (event.changes.any { it.id == down.id && it.pressed })
                                fun x(value: Float) = (value / size.width * 720).toInt().coerceIn(0, 719)
                                fun y(value: Float) = (value / size.height * 1280).toInt().coerceIn(0, 1279)
                                val isTap = hypot(end.x - start.x, end.y - start.y) < 10
                                val event = if (isTap) {
                                    buildJsonObject {
                                        put("type", JsonPrimitive("tap"))
                                        put("x", JsonPrimitive(x(end.x)))
                                        put("y", JsonPrimitive(y(end.y)))
                                    }
                                } else {
                                    buildJsonObject {
                                        put("type", JsonPrimitive("swipe"))
                                        put("x1", JsonPrimitive(x(start.x)))
                                        put("y1", JsonPrimitive(y(start.y)))
                                        put("x2", JsonPrimitive(x(end.x)))
                                        put("y2", JsonPrimitive(y(end.y)))
                                        put("duration", JsonPrimitive((lastAt - at).coerceIn(50, 2000)))
                                    }
                                }
                                scope.launch { send(event) }
                            }
                        }
                )
            }

            if (frame != null && !controlling) {
                Text("画面自动刷新 · 仅供预览${updatedAt?.let { " · 更新于 $it" } ?: ""}",
                    color = Muted, style = MaterialTheme.typography.labelMedium)
            }
            if (controlling) Text(notice, color = Accent, style = MaterialTheme.typography.bodyMedium)
            sessionMessage?.let { Text(it, color = Muted, style = MaterialTheme.typography.bodyMedium) }
            actionError?.let { Text(it, color = Danger, style = MaterialTheme.typography.bodyMedium) }

            // Confirmation is an explicit user action; no lease is acquired just by opening this screen.
            if (confirmTakeover) AlertDialog(
                onDismissRequest = { confirmTakeover = false },
                title = { Text("接管这台手机？") },
                text = { Text("接管后可点击、滑动和输入，Bot 将暂时不能操作这台手机。离开此页或应用进入后台时会自动结束接管，最长 10 分钟。") },
                confirmButton = { TextButton(onClick = { confirmTakeover = false; acquirePhone() }) { Text("确认接管") } },
                dismissButton = { TextButton(onClick = { confirmTakeover = false }) { Text("继续预览") } },
            )

            if (controlling) {
                Button(onClick = {
                    releaseCurrentLease()
                    controlling = false
                    sessionMessage = "接管已结束，现在是只读预览。"
                }) { Text("结束接管") }
            } else {
                Button(
                    enabled = selected?.online == true && !deviceId.isNullOrBlank() && available && !occupied && !acquirePending,
                    onClick = { confirmTakeover = true }
                ) {
                    Text(if (acquirePending) "正在连接…" else "接管手机")
                }
            }

            if (controlling) {
                listOf("返回" to 4, "主页" to 3, "最近" to 187, "删除" to 67, "回车" to 66).chunked(3).forEach { keys ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                        keys.forEach { (label, code) ->
                            TextButton(onClick = {
                                scope.launch {
                                    send(buildJsonObject {
                                        put("type", JsonPrimitive("key"))
                                        put("code", JsonPrimitive(code))
                                    })
                                }
                            }) { Text(label) }
                        }
                    }
                }

                OutlinedTextField(
                    value = draft,
                    onValueChange = { if (it.length <= 1000) draft = it },
                    enabled = controlling,
                    label = { Text("发送英文、数字和符号") },
                    supportingText = { Text("不支持中文直输；请勿发送密码或验证码。") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth()
                )

                Button(
                    enabled = controlling && draft.isNotEmpty() && !sending,
                    onClick = {
                        if (draft.any { it.code !in 32..126 }) {
                            notice = "只能发送英文、数字和符号"
                        } else {
                            val text = draft
                            draft = ""
                            sending = true
                            scope.launch {
                                try {
                                    send(buildJsonObject {
                                        put("type", JsonPrimitive("text"))
                                        put("text", JsonPrimitive(text))
                                    })
                                } finally {
                                    sending = false
                                }
                            }
                        }
                    }
                ) { Text("发送到手机") }

                Text("中文请使用手机画面中的软键盘输入。", color = Muted, style = MaterialTheme.typography.bodySmall)
            }
            if (!controlling && previewError == null) TextButton(onClick = { retry++ }) { Text("刷新画面") }
            TextButton(onClick = { showDetails = !showDetails }) { Text(if (showDetails) "收起使用说明" else "使用与隐私说明") }
            if (showDetails) Surface(color = Card, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("预览与接管", fontWeight = FontWeight.SemiBold)
                    statusLabel?.let { Text("设备：$it", color = Muted) }
                    Text("默认只读，画面为定时截图而非实时视频。接管最长 10 分钟，连续 45 秒未成功读取画面或输入会自动释放。")
                    Text("每台电脑使用管理员已配置的一台手机，此处不创建或管理模拟器。")
                    Text(if (botId.isNullOrBlank()) "此页不更改 Bot 的手机关联。" else "所选电脑仅在当前账号的本应用中为此 Bot 保存，不跨设备同步。")
                    Text("画面和输入通过已登录的 Pi Bot 连接传输，不作为聊天消息保存。请勿通过本页发送密码或验证码。")
                }
            }
        }
    }
}

private fun platformOf(platform: String) = when (platform) {
    "linux" -> "Linux"
    "darwin" -> "macOS"
    "win32" -> "Windows"
    else -> "未知平台"
}

private suspend fun decodeFrame(result: JsonObject): ImageBitmap {
    require(result["mime"]?.jsonPrimitive?.contentOrNull == "image/jpeg")
    require(result["width"]?.jsonPrimitive?.intOrNull == 720 && result["height"]?.jsonPrimitive?.intOrNull == 1280)
    val data = result["data"]?.jsonPrimitive?.contentOrNull ?: error("无画面")
    require(data.length in 16..1_500_000 && data.startsWith("/9j/"))
    return withContext(Dispatchers.Default) {
        val bytes = Base64.decode(data, Base64.DEFAULT)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth == 720 && bounds.outHeight == 1280) { "画面尺寸不支持" }
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error("无效画面")
        bitmap.asImageBitmap()
    }
}
