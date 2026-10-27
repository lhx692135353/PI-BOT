package dev.pibot.android.data

import dev.pibot.android.domain.ServerUrl
import dev.pibot.android.domain.Timeline
import dev.pibot.android.domain.parseServerUrl
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** One live voice call. `local` means this phone holds the microphone. */
data class LiveCall(
    val botId: String,
    val callId: String? = null,
    val phase: String = "connecting",
    val muted: Boolean = false,
    val startedAt: Long = 0L,
    val error: String? = null,
    val local: Boolean = false,
)

/**
 * Single source of truth for the signed-in user's bots. REST for reads and actions;
 * `/ws/events` while the app is in the foreground for live updates.
 */
class PiBotRepository(
    private val api: PiBotApi,
    http: OkHttpClient,
    private val storage: SessionStorage,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val socketClient = http.newBuilder().pingInterval(25, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    private val _session = MutableStateFlow(storage.load())
    private val _bots = MutableStateFlow<List<Bot>?>(null)
    private val _computer = MutableStateFlow(ComputerStatus())
    private val _live = MutableStateFlow(false)
    private val _liveCall = MutableStateFlow<LiveCall?>(null)
    private val _voiceNotice = MutableStateFlow<String?>(null)
    private val _timelines = MutableStateFlow<Map<String, Timeline>>(emptyMap())
    private val dirty = ConcurrentHashMap<String, AtomicBoolean>()
    private var socket: WebSocket? = null
    private var reconnect: Job? = null
    private var wantEvents = false
    private var activityPoll: Job? = null
    private val botRequestClock = java.util.concurrent.atomic.AtomicLong()
    private val botListRequest = java.util.concurrent.atomic.AtomicLong()
    private val botRefreshVersions = ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicLong>()
    private val tailVersions = ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicLong>()
    private var attempts = 0

    val session: StateFlow<Session?> = _session.asStateFlow()
    /** null until the first load finishes. */
    val bots: StateFlow<List<Bot>?> = _bots.asStateFlow()
    private val _devices = MutableStateFlow<List<Device>>(emptyList())
    val devices: StateFlow<List<Device>> = _devices.asStateFlow()
    val computer: StateFlow<ComputerStatus> = _computer.asStateFlow()
    /** Whether the live events socket is connected. */
    val live: StateFlow<Boolean> = _live.asStateFlow()
    /** The user's current voice call, on this phone or another device. */
    val liveCall: StateFlow<LiveCall?> = _liveCall.asStateFlow()
    /** A call failure to show once, after the call itself has gone. */
    val voiceNotice: StateFlow<String?> = _voiceNotice.asStateFlow()

    suspend fun remoteArtifact(id: String): String {
        val account = _session.value ?: error("请先登录")
        val result = withContext(io) { api.remoteArtifact(ServerUrl(account.serverUrl),account.token,id) }
        return account.serverUrl.trimEnd('/') + (result["url"]?.jsonPrimitive?.content ?: error("结果不可用"))
    }

    suspend fun remoteDesktop(botId: String): String {
        val account = _session.value ?: error("请先登录")
        val result = withContext(io) { api.remoteDesktop(ServerUrl(account.serverUrl), account.token, botId) }
        val path = result["url"]?.jsonPrimitive?.content ?: error("云端桌面入口不可用")
        return account.serverUrl.trimEnd('/') + path
    }

    fun lastServerUrl(): String? = storage.lastServerUrl()

    fun timeline(botId: String): Flow<Timeline> = _timelines.map { it[botId] ?: Timeline() }.distinctUntilChanged()

    fun bot(botId: String): Flow<Bot?> = _bots.map { list -> list?.firstOrNull { it.id == botId } }.distinctUntilChanged()

    suspend fun login(rawUrl: String, username: String, password: String) {
        val url = parseServerUrl(rawUrl)
        val r = withContext(io) { api.login(url, username.trim(), password) }
        val session = Session(url.base, r.accessToken, System.currentTimeMillis() + r.expiresIn * 1000, r.user)
        storage.save(session)
        _session.value = session
    }

    fun logout() {
        stopEvents()
        storage.clear()
        _session.value = null
        _bots.value = null
        _timelines.value = emptyMap()
        _computer.value = ComputerStatus()
        _devices.value = emptyList()
        _liveCall.value = null
        _voiceNotice.value = null
    }

    fun updateLiveCall(call: LiveCall?) {
        _liveCall.value = call
    }

    fun clearVoiceNotice() {
        _voiceNotice.value = null
    }

    /** Drops the call indicator. A signed-out session does not keep a notice. */
    fun endLiveCall(botId: String, error: String?) {
        if (_session.value != null) {
            val notice = error?.takeIf { it.isNotBlank() && it != "hangup" && it != "ended" }
            if (notice != null) _voiceNotice.value = notice
        }
        _liveCall.update { current -> if (current?.botId == botId) null else current }
    }

    private suspend fun <T> authed(block: (ServerUrl, String) -> T): T {
        val s = _session.value ?: throw ApiException(401, "请先登录")
        try {
            return withContext(io) { block(ServerUrl(s.serverUrl), s.token) }
        } catch (e: ApiException) {
            if (e.unauthorized) logout()
            throw e
        }
    }

    suspend fun refreshBots() {
        val version = botRequestClock.incrementAndGet()
        val request = botListRequest.incrementAndGet()
        val originalSession = _session.value
        val list = authed { u, t -> api.bots(u, t) }
        if (_session.value != originalSession || botListRequest.get() != request) return
        _bots.update { previous ->
            val current = previous.orEmpty().associateBy { it.id }
            val incoming = list.bots.map { bot ->
                val counter = botRefreshVersions.computeIfAbsent(bot.id) { java.util.concurrent.atomic.AtomicLong() }
                if (counter.get() > version) current[bot.id] ?: bot
                else { counter.updateAndGet { maxOf(it, version) }; bot }
            }
            incoming + previous.orEmpty().filter { old -> incoming.none { it.id == old.id } && (botRefreshVersions[old.id]?.get() ?: 0) > version }
        }
        _computer.value = list.computer
        _devices.value = list.devices
    }

    suspend fun refreshMe(): Me = authed { u, t -> api.me(u, t) }.also { _computer.value = it.computer; _devices.value = it.devices }

    suspend fun revokeDevice(id: String) { authed { u,t -> api.revokeDevice(u,t,id) }; refreshMe() }

    suspend fun refreshBot(id: String) {
        val counter = botRefreshVersions.computeIfAbsent(id) { java.util.concurrent.atomic.AtomicLong() }
        val version = botRequestClock.incrementAndGet()
        counter.updateAndGet { maxOf(it, version) }
        val originalSession = _session.value
        try {
            val bot = authed { u, t -> api.bot(u, t, id) }
            if (counter.get() == version && _session.value == originalSession) upsert(bot)
        } catch (e: ApiException) {
            if (e.status == 404) { if (counter.get() == version && _session.value == originalSession) remove(id) } else throw e
        }
    }

    private fun upsert(bot: Bot) = _bots.update { list ->
        val current = list.orEmpty()
        val i = current.indexOfFirst { it.id == bot.id }
        val next = if (i < 0) listOf(bot) + current else current.toMutableList().also { it[i] = bot }
        next.sortedByDescending { it.lastActiveAt }
    }

    private fun remove(id: String) {
        _bots.update { list -> list?.filterNot { it.id == id } }
        _timelines.update { it - id }
    }

    suspend fun phone(deviceId: String, action: String, body: JsonObject = JsonObject(emptyMap())): JsonObject = authed { u, t -> api.phone(u, t, deviceId, action, body) }

    fun releasePhoneSessionAsync(deviceId: String, sessionId: String) {
        if (deviceId.isBlank() || sessionId.isBlank()) return
        // Capture credentials now; a queued cleanup must not use the next account.
        val original = _session.value ?: return
        scope.launch(NonCancellable + io) {
            withTimeoutOrNull(15_000) {
                runCatching {
                    api.phone(ServerUrl(original.serverUrl), original.token, deviceId, "release", buildJsonObject {
                        put("sessionId", JsonPrimitive(sessionId))
                    })
                }
            }
        }
    }

    suspend fun models(): List<Model> = authed { u, t -> api.models(u, t) }

    suspend fun createBot(input: BotInput): Bot = authed { u, t -> api.createBot(u, t, input) }.also(::upsert)

    suspend fun updateBot(id: String, input: BotInput): Bot = authed { u, t -> api.updateBot(u, t, id, input) }.also(::upsert)

    suspend fun archiveBot(id: String) {
        authed { u, t -> api.archiveBot(u, t, id) }
        remove(id)
    }

    suspend fun loadTail(botId: String) {
        val counter = tailVersions.computeIfAbsent(botId) { java.util.concurrent.atomic.AtomicLong() }
        val version = counter.incrementAndGet()
        val originalSession = _session.value
        val page = authed { u, t -> api.messages(u, t, botId) }
        if (counter.get() != version || _session.value != originalSession) return
        _timelines.update { all ->
            val current = all[botId] ?: Timeline()
            all + (botId to current.merge(page.messages, if (current.loaded) current.hasMore else page.hasMore))
        }
    }

    suspend fun loadMore(botId: String) {
        val oldest = _timelines.value[botId]?.oldestSeq ?: return loadTail(botId)
        val page = authed { u, t -> api.messages(u, t, botId, before = oldest) }
        _timelines.update { all -> all + (botId to (all[botId] ?: Timeline()).merge(page.messages, page.hasMore)) }
    }

    suspend fun taskConversation(botId: String, taskId: String, after: Long = 0): TaskConversation =
        authed { u, t -> api.taskConversation(u, t, botId, taskId, after) }

    suspend fun send(botId: String, text: String, requestId: String = UUID.randomUUID().toString(), images: List<ChatImage> = emptyList()): Run {
        val result = authed { u, t -> api.send(u, t, botId, text, requestId, images) }
        _timelines.update { all -> all + (botId to (all[botId] ?: Timeline()).merge(result.messages)) }
        _bots.update { list -> list?.map { if (it.id == botId) it.copy(latestRun = result.run) else it } }
        return result.run
    }

    suspend fun image(botId: String, messageId: String, imageId: String): ChatImage =
        authed { u, t -> api.image(u, t, botId, messageId, imageId) }

    suspend fun saveUiState(botId: String, messageId: String, payload: JsonObject): JsonObject {
        val message = authed { u, t -> api.uiState(u, t, botId, messageId, payload) }
        _timelines.update { all -> all + (botId to (all[botId] ?: Timeline()).merge(listOf(message))) }
        return message.ui ?: throw ApiException(422, "交互界面无效")
    }

    suspend fun submitUiAction(botId: String, messageId: String, payload: JsonObject) {
        val result = authed { u, t -> api.uiAction(u, t, botId, messageId, payload) }
        _timelines.update { all -> all + (botId to (all[botId] ?: Timeline()).merge(result.messages)) }
        _bots.update { list -> list?.map { if (it.id == botId) it.copy(latestRun = result.run) else it } }
    }

    suspend fun cancel(botId: String, runId: String) {
        authed { u, t -> api.cancel(u, t, runId) }
        refreshBot(botId)
        loadTail(botId)
    }

    suspend fun decide(approval: Approval, approve: Boolean) {
        authed { u, t -> api.decide(u, t, approval.id, approve) }
        refreshBot(approval.botId)
    }

    suspend fun files(botId: String, path: String): FileList = authed { u, t -> api.files(u, t, botId, path) }

    suspend fun file(botId: String, path: String): FileContent = authed { u, t -> api.file(u, t, botId, path) }

    suspend fun changePassword(old: String, new: String) {
        authed { u, t -> api.changePassword(u, t, old, new) }
    }

    /** Coalesces bursts of `bot` events into one refresh per bot. */
    private fun requestBotRefresh(id: String) {
        val flag = dirty.getOrPut(id) { AtomicBoolean() }
        if (flag.getAndSet(true)) return
        scope.launch {
            delay(200)
            flag.set(false)
            runCatching {
                refreshBot(id)
                if (_timelines.value[id]?.loaded == true) loadTail(id)
            }
        }
    }

    internal fun handleEvent(event: JsonObject) {
        when (event["type"]?.jsonPrimitive?.contentOrNull) {
            "delta" -> {
                val botId = event["bot_id"]?.jsonPrimitive?.contentOrNull ?: return
                val messageId = event["message_id"]?.jsonPrimitive?.contentOrNull ?: return
                val content = event["content"]?.jsonPrimitive?.contentOrNull ?: return
                _timelines.update { all -> all[botId]?.let { all + (botId to it.applyDelta(messageId, content)) } ?: all }
            }
            "bot" -> event["bot_id"]?.jsonPrimitive?.contentOrNull?.let(::requestBotRefresh)
            "presence" -> {
                _computer.update { it.copy(online = event["online"]?.jsonPrimitive?.booleanOrNull ?: it.online) }
                scope.launch { runCatching { refreshMe() } }
            }
            "bots" -> scope.launch { runCatching { refreshBots() } }
            "call" -> applyCall(event)
        }
    }

    private fun applyCall(event: JsonObject) {
        val botId = event["bot_id"]?.jsonPrimitive?.contentOrNull ?: return
        val phase = event["phase"]?.jsonPrimitive?.contentOrNull ?: return
        val callId = event["call_id"]?.jsonPrimitive?.contentOrNull
        if (phase == "ended") {
            _liveCall.update { current ->
                if (current == null || current.botId != botId) return@update current
                if (current.local && (current.callId == null || current.callId != callId)) return@update current
                if (!current.local && current.callId != null && current.callId != callId) return@update current
                null
            }
            requestBotRefresh(botId)
            return
        }
        _liveCall.update { current ->
            if (current?.local == true && current.botId == botId) {
                current.copy(callId = callId ?: current.callId, phase = phase)
            } else if (current?.local == true) {
                current
            } else {
                LiveCall(
                    botId = botId,
                    callId = callId,
                    phase = phase,
                    startedAt = if (current?.botId == botId && current.startedAt > 0) current.startedAt else System.currentTimeMillis(),
                )
            }
        }
    }

    @Synchronized
    fun startEvents() {
        wantEvents = true
        if (activityPoll?.isActive != true) activityPoll = scope.launch {
            while (wantEvents) {
                delay(5000)
                // Idle caches can miss the event that starts a task on another computer.
                runCatching {
                    refreshBots()
                    for ((id, timeline) in _timelines.value) if (timeline.loaded) loadTail(id)
                }
            }
        }
        if (socket == null) connect()
    }

    @Synchronized
    fun stopEvents() {
        wantEvents = false
        activityPoll?.cancel()
        activityPoll = null
        reconnect?.cancel()
        socket?.close(1000, null)
        socket = null
        _live.value = false
    }

    @Synchronized
    private fun connect() {
        val s = _session.value ?: return
        val request = Request.Builder().url(ServerUrl(s.serverUrl).eventsSocket(s.token)).build()
        socket = socketClient.newWebSocket(request, Listener())
    }

    @Synchronized
    private fun scheduleReconnect(ws: WebSocket) {
        if (socket !== ws) return
        socket = null
        _live.value = false
        if (!wantEvents) return
        val wait = minOf(30_000L, 1_000L shl minOf(attempts++, 5))
        reconnect = scope.launch {
            delay(wait)
            synchronized(this@PiBotRepository) { if (wantEvents && socket == null) connect() }
        }
    }

    private inner class Listener : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            val message = runCatching { API_JSON.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
            when (message["type"]?.jsonPrimitive?.contentOrNull) {
                "hello" -> {
                    attempts = 0
                    _live.value = true
                    _computer.update { it.copy(online = message["device_online"]?.jsonPrimitive?.booleanOrNull ?: it.online) }
                    scope.launch {
                        runCatching {
                            refreshBots()
                            for ((id, timeline) in _timelines.value) if (timeline.loaded) loadTail(id)
                        }
                    }
                }
                "event" -> (message["event"] as? JsonObject)?.let(::handleEvent)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
            if (code == 4401) logout()
            else scheduleReconnect(webSocket)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (response?.code == 401) logout()
            else scheduleReconnect(webSocket)
        }
    }
}
