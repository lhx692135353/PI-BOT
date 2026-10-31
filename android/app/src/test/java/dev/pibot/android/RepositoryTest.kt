package dev.pibot.android

import dev.pibot.android.data.ApiException
import dev.pibot.android.data.BotInput
import dev.pibot.android.data.ChatImage
import kotlinx.serialization.json.jsonArray
import dev.pibot.android.data.LiveCall
import dev.pibot.android.data.PiBotApi
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.data.Session
import dev.pibot.android.data.SessionStorage
import dev.pibot.android.data.errorMessage
import dev.pibot.android.face.Avatar
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit

private class MemoryStorage : SessionStorage {
    var session: Session? = null
    var last: String? = null
    override fun load() = session
    override fun save(session: Session) { this.session = session; last = session.serverUrl }
    override fun clear() { session = null }
    override fun lastServerUrl() = last
}

private const val USER = """{"id":"u1","username":"bob","display_name":"Bob","role":"user","disabled":false,"created_at":"2026-10-11T08:00:00Z"}"""
private const val BOT = """{"id":"b1","name":"研究助理","slug":"research","persona":"","model_id":null,
  "avatar":{"shape":"blob","color":"orange","scheme":"light"},"created_at":"2026-10-11T08:00:00Z","updated_at":"2026-10-11T08:00:00Z",
  "last_active_at":"2026-10-11T08:00:00Z","latest_run":null,"last_message":null,"pending_approvals":[]}"""
private const val RUN = """{"id":"r1","bot_id":"b1","status":"running","executor":"device","error":null,"user_message_id":"m1","assistant_message_id":"m2","created_at":"2026-10-11T08:01:00Z","finished_at":null}"""
private fun msg(id: String, seq: Int, role: String, content: String, status: String) =
    """{"id":"$id","bot_id":"b1","run_id":"r1","seq":$seq,"role":"$role","content":"$content","status":"$status","executor":"device","tools":[],"created_at":"2026-10-11T08:01:00Z","updated_at":"2026-10-11T08:01:00Z"}"""

class RepositoryTest {
    private lateinit var server: MockWebServer
    private lateinit var storage: MemoryStorage
    private lateinit var repo: PiBotRepository
    private val http = OkHttpClient()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        storage = MemoryStorage()
        repo = PiBotRepository(PiBotApi(http), http, storage, CoroutineScope(SupervisorJob() + Dispatchers.Unconfined), io = Dispatchers.Unconfined)
    }

    @After
    fun tearDown() {
        repo.stopEvents()
        server.shutdown()
    }

    private fun respond(code: Int, body: String) = server.enqueue(MockResponse().setResponseCode(code).setHeader("content-type", "application/json").setBody(body))
    private fun base() = server.url("/pibot").toString()

    private fun login() = runBlocking {
        respond(200, """{"access_token":"tok","expires_in":3600,"user":$USER}""")
        repo.login(base(), " bob ", "secret")
        server.takeRequest()
    }

    @Test
    fun savedAuthorizationsUseScopedServerDataAndExplicitDecisionAndRevoke() = runBlocking {
        login()
        val approvalJson = """{"id":"a1","run_id":"r1","bot_id":"b1","kind":"outside_access","path":"/projects/demo","reason":"read","status":"pending","expires_at":"2099-01-01T00:00:00Z","access":"read","scope":"当前账号 · 办公电脑 · 读取 · /projects/demo，不包含写入或命令","can_remember":true}"""
        val approval = Json { ignoreUnknownKeys = true }.decodeFromString<dev.pibot.android.data.Approval>(approvalJson)
        assertTrue(approval.canRemember)
        assertTrue(approval.scope.contains("办公电脑"))
        respond(200, approvalJson.replace("pending", "approved"))
        respond(200, BOT)
        repo.decide(approval, "approve_always")
        val decision = server.takeRequest()
        assertEquals("/pibot/approvals/a1", decision.requestUrl!!.encodedPath)
        assertEquals("Bearer tok", decision.getHeader("Authorization"))
        assertEquals("approve_always", Json.parseToJsonElement(decision.body.readUtf8()).jsonObject["decision"]!!.jsonPrimitive.content)
        server.takeRequest()
        respond(200, """[{"id":"rule1","target":"device:pc1","target_label":"办公电脑","resource":"/projects/demo","resource_type":"directory","operation":"read","created_at":"2026-10-31T00:00:00Z","last_used_at":null}]""")
        val rules = repo.authorizations()
        assertEquals("办公电脑", rules.single().targetLabel)
        assertEquals("read", rules.single().operation)
        assertEquals("/pibot/authorizations", server.takeRequest().requestUrl!!.encodedPath)
        respond(200, """{"revoked":true}""")
        repo.revokeAuthorization("rule1")
        val revoke = server.takeRequest()
        assertEquals("DELETE", revoke.method)
        assertEquals("/pibot/authorizations/rule1", revoke.requestUrl!!.encodedPath)
        respond(200, """[{"id":1,"action":"revoke","target":"device:pc1","operation":"read","resource":"/projects/demo","created_at":"2026-10-31T00:00:00Z"}]""")
        assertEquals("revoke", repo.authorizationLogs().single().action)
        assertEquals("/pibot/authorizations/logs", server.takeRequest().requestUrl!!.encodedPath)
    }

    @Test
    fun pushRegistrationUsesCurrentBindingBearerAndPathPrefix() = runBlocking {
        login()
        val session = repo.session.value!!
        val installation = java.util.UUID.randomUUID().toString()
        respond(200, """{"ok":true,"enabled":true}""")
        PiBotApi(http).registerPush(session, installation, "fcm-token", "test-project")
        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/pibot/push/installations/$installation", request.requestUrl!!.encodedPath)
        assertEquals("Bearer tok", request.getHeader("Authorization"))
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("fcm-token", body["fcm_token"]!!.jsonPrimitive.content)
        assertEquals(session.pushBindingId, body["binding_id"]!!.jsonPrimitive.content)
        assertEquals("test-project", body["firebase_project_id"]!!.jsonPrimitive.content)
        respond(200, """{"ok":true}""")
        PiBotApi(http).unregisterPush(session, installation)
        val removal = server.takeRequest()
        assertEquals("DELETE", removal.method)
        assertEquals(session.pushBindingId, removal.requestUrl!!.queryParameter("binding_id"))
    }

    @Test
    fun pushConfigUsesAuthenticatedCurrentServerWithItsPathPrefix() = runBlocking {
        login()
        respond(200, """{"enabled":false,"firebase":null}""")
        val config = PiBotApi(http).pushConfig(repo.session.value!!)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/pibot/push/config", request.requestUrl!!.encodedPath)
        assertEquals("Bearer tok", request.getHeader("Authorization"))
        assertFalse(config.enabled)
        assertNull(config.firebase)
    }

    @Test
    fun pushRefreshCannotInstallOldAccountDataAfterRelogin() = runBlocking {
        login()
        val binding = repo.session.value!!.pushBindingId
        server.enqueue(MockResponse().setHeader("content-type", "application/json").setBody(BOT).setBodyDelay(400, TimeUnit.MILLISECONDS))
        val refresh = async(Dispatchers.IO) { repo.refreshFromPush("b1", binding) }
        assertEquals("/pibot/bots/b1", server.takeRequest(5, TimeUnit.SECONDS)!!.requestUrl!!.encodedPath)
        repo.logout()
        login()
        assertFalse(binding == repo.session.value!!.pushBindingId)
        refresh.await()
        assertNull(repo.bots.value)
        assertFalse(repo.timeline("b1").first().loaded)
    }

    @Test
    fun oldUnauthorizedRequestCannotLogOutNewSession() = runBlocking {
        login()
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}").setBodyDelay(400, TimeUnit.MILLISECONDS))
        val refresh = async(Dispatchers.IO) { runCatching { repo.refreshBots() }.exceptionOrNull() }
        server.takeRequest(5, TimeUnit.SECONDS)!!
        repo.logout()
        login()
        val binding = repo.session.value!!.pushBindingId
        assertEquals(401, (refresh.await() as ApiException).status)
        assertEquals(binding, repo.session.value!!.pushBindingId)
    }

    @Test
    fun loginStoresTheSessionUnderThePathPrefix() = runBlocking {
        val request = login()
        assertEquals("/pibot/auth/login", request.requestUrl!!.encodedPath)
        assertEquals("""{"username":"bob","password":"secret"}""", request.body.readUtf8())
        val session = repo.session.first()!!
        assertEquals("tok", session.token)
        assertEquals("bob", session.user.username)
        assertEquals(base().trimEnd('/'), storage.lastServerUrl())
    }

    @Test
    fun publicHttpServerSupportsLoginRestAndLiveEvents() = runBlocking {
        // Exercise a non-LAN hostname without using any external server or DNS.
        val client = http.newBuilder()
            .dns { listOf(InetAddress.getByName(server.hostName)) }
            .proxy(Proxy.NO_PROXY)
            .build()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        repo = PiBotRepository(PiBotApi(client), client, storage, scope, io = Dispatchers.Unconfined)
        try {
            val url = server.url("/pibot").newBuilder().host("http-server.example").build().toString()
            respond(200, """{"access_token":"tok","expires_in":3600,"user":$USER}""")
            repo.login(url, "bob", "secret")
            assertEquals("/pibot/auth/login", server.takeRequest(5, TimeUnit.SECONDS)!!.path)
            assertEquals(url, storage.load()!!.serverUrl)

            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("""{"type":"hello","device_online":true}""")
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
            }))
            respond(200, """{"bots":[$BOT],"computer":{"online":true}}""")
            repo.startEvents()
            withTimeout(5000) {
                repo.live.first { it }
                repo.bots.first { it != null }
            }
            val socket = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals("/pibot/ws/events?token=tok", socket.path)
            assertEquals("websocket", socket.getHeader("Upgrade")?.lowercase())
            val refreshed = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals("/pibot/bots", refreshed.path)
            assertEquals("Bearer tok", refreshed.getHeader("Authorization"))
            assertTrue(repo.computer.value.online)
        } finally {
            repo.stopEvents()
            scope.cancel()
        }
    }

    @Test
    fun wrongPasswordShowsTheServerMessage() = runBlocking {
        respond(401, """{"detail":"用户名或密码错误"}""")
        val e = assertThrows(ApiException::class.java) { runBlocking { repo.login(base(), "bob", "nope") } }
        assertEquals("用户名或密码错误", e.message)
        assertNull(repo.session.first())
    }

    @Test
    fun imageOnlyMessagesSendAndLoadThroughAuthenticatedApi() = runBlocking {
        login()
        val image = ChatImage("pixel.png", "image/png", "aW1hZ2U=")
        val user = msg("m1", 1, "user", "", "completed").dropLast(1) + """, "images":[{"id":"i1","name":"pixel.png","mime_type":"image/png"}]}"""
        respond(200, """{"run":$RUN,"messages":[$user]}""")
        repo.send("b1", "", "request-1", listOf(image))
        val request = server.takeRequest()
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("", body["text"]!!.jsonPrimitive.content)
        assertEquals(image.data, body["images"]!!.jsonArray.single().jsonObject["data"]!!.jsonPrimitive.content)
        assertEquals("i1", repo.timeline("b1").first().messages.single().images.single().id)
        respond(200, """{"name":"pixel.png","mime_type":"image/png","data":"aW1hZ2U="}""")
        assertEquals(image, repo.image("b1", "m1", "i1"))
        val read = server.takeRequest()
        assertEquals("/pibot/bots/b1/messages/m1/images/i1", read.path)
        assertEquals("Bearer tok", read.getHeader("Authorization"))
    }

    @Test
    fun botsMessagesAndSending() = runBlocking {
        login()
        respond(200, """{"bots":[$BOT],"computer":{"online":true,"device":{"id":"d1","label":"Bob 的 Mac","online":true}},"devices":[{"id":"d1","label":"Bob 的 Mac","platform":"darwin","online":true},{"id":"d2","label":"Linux","platform":"linux","online":false}]}""")
        repo.refreshBots()
        assertEquals("Bearer tok", server.takeRequest().getHeader("Authorization"))
        assertEquals("研究助理", repo.bots.value!!.single().name)
        assertTrue(repo.computer.value.online)
        assertEquals("Bob 的 Mac", repo.computer.value.device?.label)
        assertEquals(listOf("d1", "d2"), repo.devices.value.map { it.id })
        assertEquals("linux", repo.devices.value.last().platform)
        assertFalse(repo.devices.value.last().online)

        respond(200, """{"messages":[${msg("m0", 1, "user", "早", "completed")}],"has_more":true}""")
        repo.loadTail("b1")
        assertEquals("limit=50", server.takeRequest().requestUrl!!.encodedQuery)
        assertTrue(repo.timeline("b1").first().hasMore)

        respond(200, """{"run":$RUN,"messages":[${msg("m1", 2, "user", "写周报", "completed")},${msg("m2", 3, "assistant", "", "running")}]}""")
        repo.send("b1", "写周报")
        val sent = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("写周报", sent["text"]!!.jsonPrimitive.content)
        assertTrue(sent["request_id"]!!.jsonPrimitive.content.length >= 8)
        assertEquals("running", repo.bots.value!!.single().latestRun?.status)
        assertEquals(listOf("m0", "m1", "m2"), repo.timeline("b1").first().messages.map { it.id })

        repo.handleEvent(Json.parseToJsonElement("""{"type":"delta","bot_id":"b1","message_id":"m2","content":"本周"}""") as JsonObject)
        assertEquals("本周", repo.timeline("b1").first().messages.last().content)

        respond(200, """{"messages":[${msg("m9", 1, "user", "更早", "completed")}],"has_more":false}""")
        repo.loadMore("b1")
        assertEquals("1", server.takeRequest().requestUrl!!.queryParameter("before"))
        assertEquals(false, repo.timeline("b1").first().hasMore)
    }

    @Test
    fun replySegmentsAndTaskConversationKeepTheirWireFields() = runBlocking {
        login()
        val reply = msg("m2", 2, "assistant", "服务正常", "completed").dropLast(1) + """, "reply_segments":[{"id":"open","phase":"opening","text":"先检查服务。","created_at":"2026-10-27T12:00:00Z"},{"id":"answer","phase":"answer","text":"服务正常","created_at":"2026-10-27T12:00:01Z"}]}"""
        respond(200, """{"messages":[$reply],"has_more":false}""")
        repo.loadTail("b1"); server.takeRequest()
        assertEquals(listOf("opening", "answer"), repo.timeline("b1").first().messages.single().replySegments.map { it.phase })
        respond(200, """{"task_id":"t1","status":"completed","bots":[{"id":"b1","name":"甲"},{"id":"b2","name":"乙"}],"messages":[{"id":"8","seq":8,"from_bot_id":"b2","to_bot_id":"b1","kind":"answer","content":"已完成","created_at":null}],"total":3,"has_more":false,"next_after":8}""")
        val conversation = repo.taskConversation("b1", "t1", 7)
        val request = server.takeRequest()
        assertEquals("/pibot/bots/b1/tasks/t1/conversation?after=7", request.path)
        assertEquals("Bearer tok", request.getHeader("Authorization"))
        assertEquals("b2", conversation.messages.single().fromBotId)
        assertNull(conversation.messages.single().createdAt)
        assertEquals(3, conversation.total)
    }

    @Test
    fun anOlderBotRefreshCannotRestoreTheRunningIndicator() = runBlocking {
        login()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        repo = PiBotRepository(PiBotApi(http), http, storage, scope, io = Dispatchers.IO)
        try {
            server.enqueue(MockResponse().setBody(BOT.dropLast(1) + """, "activity":{"status":"running","summary":"正在检查"}}""").setBodyDelay(200, TimeUnit.MILLISECONDS))
            val old = async(Dispatchers.IO) { repo.refreshBot("b1") }
            server.takeRequest(5, TimeUnit.SECONDS)
            respond(200, BOT.dropLast(1) + """, "activity":{"status":null,"summary":null}}""")
            repo.refreshBot("b1")
            old.await()
            assertNull(repo.bots.value!!.single().activity?.summary)
            assertNull(repo.bots.value!!.single().activity?.status)
        } finally { scope.cancel() }
    }

    @Test
    fun anOlderBotListCannotOverwriteANewerIdleBot() = runBlocking {
        login()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        repo = PiBotRepository(PiBotApi(http), http, storage, scope, io = Dispatchers.IO)
        try {
            val running = BOT.dropLast(1) + """, "activity":{"status":"running","summary":"正在检查"}}"""
            server.enqueue(MockResponse().setBody("""{"bots":[$running]}""").setBodyDelay(200, TimeUnit.MILLISECONDS))
            val old = async(Dispatchers.IO) { repo.refreshBots() }
            server.takeRequest(5, TimeUnit.SECONDS)
            respond(200, BOT.dropLast(1) + """, "activity":{"status":null,"summary":null}}""")
            repo.refreshBot("b1")
            old.await()
            assertNull(repo.bots.value!!.single().activity?.status)
            assertNull(repo.bots.value!!.single().activity?.summary)
        } finally { scope.cancel() }
    }

    @Test
    fun idleForegroundDiscoversAndClearsTasksWithoutSocketNotifications() = runBlocking {
        login()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        repo = PiBotRepository(PiBotApi(http), http, storage, scope, io = Dispatchers.IO)
        val phase = java.util.concurrent.atomic.AtomicBoolean(false)
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                if (request.path.orEmpty().contains("/ws/events")) return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.send("""{"type":"hello","device_online":true}""") }
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
                })
                if (request.path == "/pibot/bots") {
                    val activity = if (phase.get()) """{"status":"running","summary":"正在检查服务启动","running_count":1}""" else """{"status":null,"summary":null,"running_count":0}"""
                    return MockResponse().setHeader("content-type", "application/json").setBody("""{"bots":[${BOT.dropLast(1)},"activity":$activity}]}""")
                }
                return MockResponse().setResponseCode(404)
            }
        }
        try {
            repo.startEvents()
            withTimeout(5000) { repo.bots.first { it != null } }
            assertNull(repo.bots.value!!.single().activity?.summary)
            phase.set(true)
            withTimeout(8000) { repo.bots.first { it?.singleOrNull()?.activity?.status == "running" } }
            assertEquals("正在检查服务启动", repo.bots.value!!.single().activity?.summary)
            phase.set(false)
            withTimeout(8000) { repo.bots.first { it?.singleOrNull()?.activity?.summary == null } }
            assertEquals(0, repo.bots.value!!.single().activity?.runningCount)
        } finally { repo.stopEvents(); scope.cancel() }
    }

    @Test
    fun botEditsAlwaysSendTheModelSoItCanBeCleared() = runBlocking {
        login()
        respond(200, BOT)
        repo.updateBot("b1", BotInput("研究助理", "", null, Avatar("cloud", "mint", "dark"), "d2"))
        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertTrue(body.containsKey("model_id"))
        assertEquals("d2", body["execution_device_id"]!!.jsonPrimitive.content)
        assertEquals("cloud", body["avatar"]!!.jsonObject["shape"]!!.jsonPrimitive.content)
    }

    @Test
    fun libraryPathsAreQueryEncodedAndOfflineIsExplained() = runBlocking {
        login()
        respond(200, """{"path":"报告","entries":[{"name":"周报.md","type":"file","size":12,"modified":"2026-10-11T08:00:00Z"}]}""")
        val list = repo.files("b1", "报告")
        assertEquals("报告", server.takeRequest().requestUrl!!.queryParameter("path"))
        assertEquals("周报.md", list.entries.single().name)
        respond(503, "")
        val e = assertThrows(ApiException::class.java) { runBlocking { repo.files("b1", "") } }
        assertEquals("电脑离线，资料库不可用", e.message)
    }

    @Test
    fun anExpiredSessionSignsOut() = runBlocking {
        login()
        respond(401, """{"detail":"登录已过期"}""")
        assertThrows(ApiException::class.java) { runBlocking { repo.refreshBots() } }
        assertNull(repo.session.first())
        assertNull(storage.session)
    }

    @Test
    fun callEventsTrackARemoteCallAndLeaveALocalOneAlone() {
        repo.handleEvent(Json.parseToJsonElement("""{"type":"call","bot_id":"b1","call_id":"c1","phase":"listening"}""") as JsonObject)
        assertEquals("listening", repo.liveCall.value?.phase)
        assertFalse(repo.liveCall.value!!.local)
        repo.handleEvent(Json.parseToJsonElement("""{"type":"call","bot_id":"b1","call_id":"c1","phase":"ended"}""") as JsonObject)
        assertNull(repo.liveCall.value)

        repo.updateLiveCall(LiveCall(botId = "b1", phase = "connecting", local = true))
        repo.handleEvent(Json.parseToJsonElement("""{"type":"call","bot_id":"b1","call_id":"other","phase":"ended"}""") as JsonObject)
        assertEquals("connecting", repo.liveCall.value?.phase)
        repo.handleEvent(Json.parseToJsonElement("""{"type":"call","bot_id":"b1","call_id":"c2","phase":"speaking"}""") as JsonObject)
        assertEquals("c2", repo.liveCall.value?.callId)
        assertTrue(repo.liveCall.value!!.local)
        repo.handleEvent(Json.parseToJsonElement("""{"type":"call","bot_id":"b1","call_id":"c2","phase":"ended"}""") as JsonObject)
        assertNull(repo.liveCall.value)
    }

    @Test
    fun errorMessagesFallBackToStatus() {
        assertEquals("请求失败（500）", errorMessage(500, "<html>"))
        assertEquals("Bot 不存在", errorMessage(404, """{"detail":"Bot 不存在"}"""))
    }

    @Test
    fun phoneRpcCallsDeviceEndpointWithStrictBearerAuth() = runBlocking {
        login()
        val deviceId = "00000000-0000-4000-8000-000000000001"
        respond(200, """{"available":true,"phoneId":"google-play-validation"}""")
        val status = repo.phone(deviceId, "status")
        val statusReq = server.takeRequest()
        assertEquals("POST", statusReq.method)
        assertEquals("/pibot/devices/$deviceId/phone/status", statusReq.requestUrl!!.encodedPath)
        assertEquals("Bearer tok", statusReq.getHeader("Authorization"))
        assertEquals("true", status["available"]!!.jsonPrimitive.content)

        respond(200, """{"sessionId":"00000000-0000-4000-8000-000000000002","expiresAt":12345}""")
        val acquire = repo.phone(deviceId, "acquire")
        val acqReq = server.takeRequest()
        assertEquals("/pibot/devices/$deviceId/phone/acquire", acqReq.requestUrl!!.encodedPath)
        assertEquals("00000000-0000-4000-8000-000000000002", acquire["sessionId"]!!.jsonPrimitive.content)

        respond(200, """{"ok":true}""")
        val inputBody = Json.parseToJsonElement("""{"sessionId":"00000000-0000-4000-8000-000000000002","event":{"type":"tap","x":100,"y":200}}""").jsonObject
        repo.phone(deviceId, "input", inputBody)
        val inReq = server.takeRequest()
        assertEquals("/pibot/devices/$deviceId/phone/input", inReq.requestUrl!!.encodedPath)
        assertEquals("""{"sessionId":"00000000-0000-4000-8000-000000000002","event":{"type":"tap","x":100,"y":200}}""", inReq.body.readUtf8())

        respond(200, """{"mime":"image/jpeg","width":720,"height":1280,"data":"/9j/aaaaaaaaaaaa"}""")
        repo.phone(deviceId, "preview")
        val previewReq = server.takeRequest()
        assertEquals("POST", previewReq.method)
        assertEquals("/pibot/devices/$deviceId/phone/preview", previewReq.requestUrl!!.encodedPath)
        assertEquals("{}", previewReq.body.readUtf8())
        assertEquals("Bearer tok", previewReq.getHeader("Authorization"))
    }
}
