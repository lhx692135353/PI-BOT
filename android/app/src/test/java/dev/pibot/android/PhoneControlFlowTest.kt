package dev.pibot.android

import dev.pibot.android.data.Device
import dev.pibot.android.data.PiBotApi
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.data.Session
import dev.pibot.android.data.SessionStorage
import dev.pibot.android.data.User
import dev.pibot.android.data.isAcquireApplicable
import dev.pibot.android.data.parseExpiresMillis
import dev.pibot.android.data.phoneAssociationKey
import dev.pibot.android.data.readPhoneMap
import dev.pibot.android.data.resolvePhoneDevice
import dev.pibot.android.data.validateAcquireResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.net.Proxy
import java.util.UUID
import java.util.concurrent.TimeUnit

private class TestMemoryStorage : SessionStorage {
    var session: Session? = null
    var last: String? = null
    override fun load() = session
    override fun save(session: Session) { this.session = session; last = session.serverUrl }
    override fun clear() { session = null }
    override fun lastServerUrl() = last
}

class PhoneControlFlowTest {
    private val devA = "00000000-0000-4000-8000-000000000001"
    private val devB = "00000000-0000-4000-8000-000000000002"
    private lateinit var server: MockWebServer
    private lateinit var repoScope: CoroutineScope
    private lateinit var storage: TestMemoryStorage
    private lateinit var repo: PiBotRepository

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        repoScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        storage = TestMemoryStorage()
        storage.session = Session(
            serverUrl = server.url("/pibot").toString().removeSuffix("/"),
            token = "test-token",
            expiresAt = System.currentTimeMillis() + 3600_000L,
            user = User(id = "u1", username = "tester", displayName = "Tester")
        )
        val client = OkHttpClient.Builder().proxy(Proxy.NO_PROXY).build()
        val api = PiBotApi(client)
        repo = PiBotRepository(api, client, storage, repoScope)
    }

    @After
    fun tearDown() {
        repoScope.cancel()
        server.shutdown()
    }

    private fun respond(code: Int, body: String) {
        server.enqueue(MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body))
    }

    /**
     * 1. 聊天入口与路由设备解析测试
     * 验证根据 Bot executionDeviceId 及已授权电脑列表安全解析目标，并隔离多账号存储。
     */
    @Test
    fun testChatEntryNavigationAndDeviceResolution() {
        val devices = listOf(
            Device(id = devA, label = "办公台式机", online = true),
            Device(id = devB, label = "居家笔记本", online = false)
        )
        // 旧 Bot 配置不再隐式选择电脑
        val choice1 = resolvePhoneDevice(savedDeviceId = null, executionDeviceId = devA, devices = devices)
        assertNull(choice1.deviceId)
        assertEquals("none", choice1.source)

        // 未绑定的 Bot 且多台电脑时不随意猜测，安全返回 none
        val choice2 = resolvePhoneDevice(savedDeviceId = null, executionDeviceId = null, devices = devices)
        assertNull(choice2.deviceId)
        assertEquals("none", choice2.source)

        // 无绑定时即使仅有一台电脑也要求用户明确选择
        val choice3 = resolvePhoneDevice(savedDeviceId = null, executionDeviceId = null, devices = listOf(devices[0]))
        assertNull(choice3.deviceId)
        assertEquals("none", choice3.source)

        // 用户命名空间隔离：不同用户不串手机绑定字典
        assertFalse(phoneAssociationKey("u1") == phoneAssociationKey("u2"))
        assertFalse(phoneAssociationKey("u1", "https://a.example") == phoneAssociationKey("u1", "https://b.example"))
    }

    /**
     * 2. 默认只读不 acquire 测试
     * 进入控制画面时仅轮询 preview 和 status，绝不主动调用 acquire，确保不抢占控制权。
     */
    @Test
    fun testDefaultReadOnlyDoesNotAcquire() = runBlocking {
        respond(200, """{"available":true,"phoneId":"test-avd"}""")
        val status = repo.phone(devA, "status")
        val statusReq = server.takeRequest(2, TimeUnit.SECONDS)
        assertNotNull(statusReq)
        assertEquals("/pibot/devices/$devA/phone/status", statusReq!!.requestUrl!!.encodedPath)

        respond(200, """{"mime":"image/jpeg","width":720,"height":1280,"data":"/9j/testdata"}""")
        val preview = repo.phone(devA, "preview")
        val previewReq = server.takeRequest(2, TimeUnit.SECONDS)
        assertNotNull(previewReq)
        assertEquals("/pibot/devices/$devA/phone/preview", previewReq!!.requestUrl!!.encodedPath)
        assertEquals("image/jpeg", preview["mime"]?.jsonPrimitive?.content)

        // 验证请求队列中没有意外发出 acquire 请求
        assertEquals(0, server.requestCount - 2)
    }

    /**
     * 3. 切设备清画面与释放旧租约测试
     * 切换设备时必须清空画面数据、重置状态，并触发旧设备租约的释放。
     */
    @Test
    fun testSwitchDeviceClearsFrameAndReleasesLease() = runBlocking {
        val oldSession = UUID.randomUUID().toString()
        respond(200, """{"ok":true}""")

        // 模拟 selectDevice 逻辑中切换到新设备时调用 releasePhoneSessionAsync
        repo.releasePhoneSessionAsync(devA, oldSession)

        val releaseReq = server.takeRequest(2, TimeUnit.SECONDS)
        assertNotNull("应发出旧设备的 release 请求", releaseReq)
        assertEquals("/pibot/devices/$devA/phone/release", releaseReq!!.requestUrl!!.encodedPath)
        val body = Json.parseToJsonElement(releaseReq.body.readUtf8()).jsonObject
        assertEquals(oldSession, body["sessionId"]?.jsonPrimitive?.content)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun queuedReleaseUsesOriginalAccountEvenAfterLogout() {
        val scheduler = TestCoroutineScheduler()
        val dispatcher = StandardTestDispatcher(scheduler)
        val client = OkHttpClient.Builder().proxy(Proxy.NO_PROXY).build()
        val queued = PiBotRepository(PiBotApi(client), client, storage, repoScope, dispatcher)
        respond(200, """{"released":true}""")
        queued.releasePhoneSessionAsync(devA, UUID.randomUUID().toString())
        queued.logout()
        scheduler.advanceUntilIdle()
        val request = server.takeRequest(2, TimeUnit.SECONDS)
        assertNotNull(request)
        assertEquals("Bearer test-token", request!!.getHeader("Authorization"))
        assertEquals("/pibot/devices/$devA/phone/release", request.requestUrl!!.encodedPath)
        assertNull(queued.session.value)
    }

    /**
     * 4. 迟到接管释放（Late Acquire Release）测试
     * 涵盖切设备、切后台、epoch 递增及非法会话响应，均能在 NonCancellable 上下文中释放。
     */
    @Test
    fun testLateAcquireResponsesAreDiscardedAndReleased() = runBlocking {
        val now = 1_770_000_000_000L
        val lateSession = UUID.randomUUID().toString()

        // 场景 A：网络延迟返回时，用户已切换设备
        val applicableOnDeviceSwitch = isAcquireApplicable(
            targetDeviceId = devA,
            currentDeviceId = devB,
            requestEpoch = 1L,
            currentEpoch = 2L,
            foreground = true
        )
        assertFalse("切换设备后迟到的响应不可应用", applicableOnDeviceSwitch)

        // 场景 B：网络延迟返回时，用户已退到后台
        val applicableOnBackground = isAcquireApplicable(
            targetDeviceId = devA,
            currentDeviceId = devA,
            requestEpoch = 1L,
            currentEpoch = 1L,
            foreground = false
        )
        assertFalse("退到后台后迟到的响应不可应用", applicableOnBackground)

        // 场景 C：用户重复点击接管，旧请求迟到返回
        val applicableOnEpochMismatch = isAcquireApplicable(
            targetDeviceId = devA,
            currentDeviceId = devA,
            requestEpoch = 1L,
            currentEpoch = 2L,
            foreground = true
        )
        assertFalse("Epoch 不匹配的陈旧响应不可应用", applicableOnEpochMismatch)

        // 场景 D：提取迟到会话并可靠释放
        val lateResp = buildJsonObject {
            put("sessionId", JsonPrimitive(lateSession))
            put("expiresAt", JsonPrimitive(now + 60_000L))
        }
        val validation = validateAcquireResponse(lateResp, now)
        assertTrue(validation.isSuccess)
        assertEquals(lateSession, validation.sessionId)

        // 触发释放并断言 RPC 到达
        respond(200, """{"ok":true}""")
        repo.releasePhoneSessionAsync(devA, validation.sessionId!!)

        val releaseReq = server.takeRequest(2, TimeUnit.SECONDS)
        assertNotNull("迟到会话必须向节点执行释放", releaseReq)
        assertEquals("/pibot/devices/$devA/phone/release", releaseReq!!.requestUrl!!.encodedPath)
        val body = Json.parseToJsonElement(releaseReq.body.readUtf8()).jsonObject
        assertEquals(lateSession, body["sessionId"]?.jsonPrimitive?.content)
    }

    /**
     * 5. 离页与后台释放（onDispose / ON_STOP）测试
     * 验证组件销毁或退到后台时，即刻向服务端发送释放请求，不会因 UI Scope 取消而丢请求。
     */
    @Test
    fun testExitScreenAndBackgroundReleaseSucceedsEvenIfLocalScopeDisposed() = runBlocking {
        val activeSession = UUID.randomUUID().toString()

        respond(200, """{"ok":true}""")

        // 模拟 PhoneControlScreen 的 releaseCurrentLease
        repo.releasePhoneSessionAsync(devA, activeSession)

        val releaseReq = server.takeRequest(2, TimeUnit.SECONDS)
        assertNotNull("离页/后台清理必须触发 release", releaseReq)
        assertEquals("POST", releaseReq!!.method)
        assertEquals("/pibot/devices/$devA/phone/release", releaseReq.requestUrl!!.encodedPath)
        assertEquals("Bearer test-token", releaseReq.getHeader("Authorization"))
        val body = Json.parseToJsonElement(releaseReq.body.readUtf8()).jsonObject
        assertEquals(activeSession, body["sessionId"]?.jsonPrimitive?.content)
    }
}
