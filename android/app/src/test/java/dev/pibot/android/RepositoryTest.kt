package dev.pibot.android

import dev.pibot.android.data.ApiException
import dev.pibot.android.data.BotInput
import dev.pibot.android.data.ChatImage
import kotlinx.serialization.json.jsonArray
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
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
    fun errorMessagesFallBackToStatus() {
        assertEquals("请求失败（500）", errorMessage(500, "<html>"))
        assertEquals("Bot 不存在", errorMessage(404, """{"detail":"Bot 不存在"}"""))
    }
}
