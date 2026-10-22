package dev.pibot.android.data

import dev.pibot.android.domain.ServerUrl
import dev.pibot.android.face.Avatar
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

@Serializable
data class User(
    val id: String,
    val username: String,
    @SerialName("display_name") val displayName: String = "",
    val role: String = "user",
)

@Serializable
data class LoginResponse(@SerialName("access_token") val accessToken: String, @SerialName("expires_in") val expiresIn: Long, val user: User)

@Serializable
data class Device(
    val id: String,
    val label: String,
    val platform: String = "darwin",
    @SerialName("revoked_at") val revokedAt: String? = null,
    @SerialName("last_seen_at") val lastSeenAt: String? = null,
    val online: Boolean = false,
)

@Serializable
data class ComputerStatus(val online: Boolean = false, val device: Device? = null)

@Serializable
data class Me(val user: User, val computer: ComputerStatus = ComputerStatus(), val devices: List<Device> = emptyList())

@Serializable
data class Model(val id: String, val name: String, @SerialName("is_default") val isDefault: Boolean = false)

@Serializable
data class Run(
    val id: String,
    @SerialName("bot_id") val botId: String,
    val status: String,
    val executor: String,
    val error: String? = null,
    @SerialName("assistant_message_id") val assistantMessageId: String? = null,
    @SerialName("created_at") val createdAt: String,
    @SerialName("finished_at") val finishedAt: String? = null,
) {
    val active: Boolean get() = status in ACTIVE_RUNS
}

val ACTIVE_RUNS = setOf("queued", "running", "waiting_approval")

@Serializable
data class LastMessage(val role: String, val preview: String, val status: String, @SerialName("created_at") val createdAt: String)

@Serializable
data class Approval(
    val id: String,
    @SerialName("run_id") val runId: String,
    @SerialName("bot_id") val botId: String,
    val kind: String = "outside_access",
    val path: String = "",
    val reason: String = "",
    val status: String = "pending",
    @SerialName("expires_at") val expiresAt: String,
)

@Serializable
data class Bot(
    val id: String,
    val name: String,
    val slug: String,
    val persona: String = "",
    @SerialName("model_id") val modelId: String? = null,
    val avatar: Avatar = Avatar(),
    @SerialName("is_main") val isMain: Boolean = false,
    @SerialName("last_active_at") val lastActiveAt: String,
    @SerialName("latest_run") val latestRun: Run? = null,
    @SerialName("last_message") val lastMessage: LastMessage? = null,
    @SerialName("active_tasks") val activeTasks: List<AgentTaskRef> = emptyList(),
    val activity: BotActivity? = null,
    @SerialName("pending_approvals") val pendingApprovals: List<Approval> = emptyList(),
    @SerialName("execution_device_id") val executionDeviceId: String? = null,
)

@Serializable
data class BotActivity(
    val status: String? = null,
    val tool: String? = null,
    val summary: String? = null,
    @SerialName("running_count") val runningCount: Int = 0,
    @SerialName("queued_count") val queuedCount: Int = 0,
)

@Serializable
data class BotList(val bots: List<Bot>, val computer: ComputerStatus = ComputerStatus(), val devices: List<Device> = emptyList())

@Serializable
data class ToolEntry(val id: String, val name: String, val state: String, val summary: String? = null)

@Serializable
data class ChatImage(val name: String, @SerialName("mime_type") val mimeType: String, val data: String)

@Serializable
data class MessageImage(val id: String, val name: String, @SerialName("mime_type") val mimeType: String)

@Serializable
data class Message(
    val id: String,
    @SerialName("bot_id") val botId: String,
    @SerialName("run_id") val runId: String? = null,
    @SerialName("task_id") val taskId: String? = null,
    val seq: Int,
    val role: String,
    val content: String,
    val images: List<MessageImage> = emptyList(),
    val status: String,
    val executor: String? = null,
    val tools: List<ToolEntry> = emptyList(),
    val progress: List<String> = emptyList(),
    val ui: JsonObject? = null,
    @SerialName("from_bot") val fromBot: FromBot? = null,
    @SerialName("agent_tasks") val agentTasks: List<AgentTaskRef> = emptyList(),
    @SerialName("created_at") val createdAt: String,
)

/** Another bot wrote this `user` message: a delegated task (`task`) or the report of a hand-off (`report`). */
@Serializable
data class FromBot(val id: String, val name: String, val avatar: Avatar? = null, val kind: String = "task")

@Serializable
data class AgentTaskRef(
    val id: String,
    @SerialName("bot_id") val botId: String,
    @SerialName("bot_name") val botName: String = "",
    val status: String,
    val mode: String = "wait",
    val kind: String = "delegation",
    val title: String = "",
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
data class MessagePage(val messages: List<Message>, @SerialName("has_more") val hasMore: Boolean = false)

@Serializable
data class SendResult(val run: Run, val messages: List<Message>)

@Serializable
data class FileEntry(val name: String, val type: String, val size: Long = 0, val modified: String? = null)

@Serializable
data class FileList(val path: String = "", val entries: List<FileEntry> = emptyList())

@Serializable
data class FileContent(
    val path: String,
    val name: String = "",
    val size: Long = 0,
    val kind: String,
    val content: String? = null,
    val base64: String? = null,
    val mime: String? = null,
    val truncated: Boolean = false,
)

/** `model_id = null` means "follow the admin's default model" and is always sent so edits can clear it. */
@Serializable
data class BotInput(
    val name: String,
    val persona: String,
    @SerialName("model_id") val modelId: String? = null,
    val avatar: Avatar,
    @SerialName("execution_device_id") val executionDeviceId: String? = null,
)

@Serializable
private data class LoginBody(val username: String, val password: String)

@Serializable
private data class SendBody(val text: String, @SerialName("request_id") val requestId: String, val images: List<ChatImage> = emptyList())

@Serializable
private data class DecisionBody(val decision: String)

@Serializable
private data class PasswordBody(@SerialName("old_password") val oldPassword: String, @SerialName("new_password") val newPassword: String)

@Serializable
private class EmptyBody

/** Server-side errors carry a Chinese `detail`; [unauthorized] means the session is gone. */
class ApiException(val status: Int, message: String) : Exception(message) {
    val unauthorized: Boolean get() = status == 401
}

class PiBotApi(private val http: OkHttpClient, private val json: Json = API_JSON) {
    fun login(url: ServerUrl, username: String, password: String): LoginResponse =
        call(url, "POST", "/auth/login", null, LoginBody(username, password))

    fun changePassword(url: ServerUrl, token: String, old: String, new: String): JsonObject =
        call(url, "POST", "/auth/password", token, PasswordBody(old, new))

    fun me(url: ServerUrl, token: String): Me = call(url, "GET", "/me", token)

    fun devices(url: ServerUrl, token: String): List<Device> = call(url, "GET", "/devices", token)

    fun revokeDevice(url: ServerUrl, token: String, id: String): Device = call(url, "POST", "/devices/$id/revoke", token, EmptyBody())

    fun models(url: ServerUrl, token: String): List<Model> = call(url, "GET", "/models", token)

    fun bots(url: ServerUrl, token: String): BotList = call(url, "GET", "/bots", token)

    fun bot(url: ServerUrl, token: String, id: String): Bot = call(url, "GET", "/bots/$id", token)

    fun createBot(url: ServerUrl, token: String, input: BotInput): Bot = call(url, "POST", "/bots", token, input)

    fun updateBot(url: ServerUrl, token: String, id: String, input: BotInput): Bot = call(url, "PATCH", "/bots/$id", token, input)

    fun archiveBot(url: ServerUrl, token: String, id: String): JsonObject = call(url, "DELETE", "/bots/$id", token)

    fun messages(url: ServerUrl, token: String, botId: String, before: Int? = null): MessagePage =
        call(url, "GET", "/bots/$botId/messages", token, query = listOfNotNull("limit" to "50", before?.let { "before" to it.toString() }))

    fun send(url: ServerUrl, token: String, botId: String, text: String, requestId: String, images: List<ChatImage> = emptyList()): SendResult =
        call(url, "POST", "/bots/$botId/messages", token, SendBody(text, requestId, images))

    fun image(url: ServerUrl, token: String, botId: String, messageId: String, imageId: String): ChatImage =
        call(url, "GET", "/bots/$botId/messages/$messageId/images/$imageId", token)

    fun uiState(url: ServerUrl, token: String, botId: String, messageId: String, body: JsonObject): Message =
        call(url, "POST", "/bots/$botId/messages/$messageId/ui-state", token, body)

    fun uiAction(url: ServerUrl, token: String, botId: String, messageId: String, body: JsonObject): SendResult =
        call(url, "POST", "/bots/$botId/messages/$messageId/ui-actions", token, body)

    fun cancel(url: ServerUrl, token: String, runId: String): Run = call(url, "POST", "/runs/$runId/cancel", token, EmptyBody())

    fun decide(url: ServerUrl, token: String, approvalId: String, approve: Boolean): Approval =
        call(url, "POST", "/approvals/$approvalId", token, DecisionBody(if (approve) "approve" else "reject"))

    fun files(url: ServerUrl, token: String, botId: String, path: String): FileList =
        call(url, "GET", "/bots/$botId/files", token, query = listOf("path" to path))

    fun file(url: ServerUrl, token: String, botId: String, path: String): FileContent =
        call(url, "GET", "/bots/$botId/files/content", token, query = listOf("path" to path))

    private inline fun <reified T> call(url: ServerUrl, method: String, path: String, token: String?, query: List<Pair<String, String>> = emptyList()): T =
        execute(request(url, method, path, token, query, null))

    private inline fun <reified T, reified B> call(url: ServerUrl, method: String, path: String, token: String?, body: B): T =
        execute(request(url, method, path, token, emptyList(), json.encodeToString(body)))

    private fun request(url: ServerUrl, method: String, path: String, token: String?, query: List<Pair<String, String>>, body: String?): Request {
        val target = (url.base + path).toHttpUrl().newBuilder().apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        val builder = Request.Builder().url(target).method(method, body?.toRequestBody(JSON_TYPE))
        if (token != null) builder.header("Authorization", "Bearer $token")
        return builder.build()
    }

    private inline fun <reified T> execute(request: Request): T {
        val response = try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            throw ApiException(0, "连不上服务器，请检查网络")
        }
        response.use {
            val text = it.body.string()
            if (!it.isSuccessful) throw ApiException(it.code, errorMessage(it.code, text))
            return json.decodeFromString(text)
        }
    }
}

fun errorMessage(status: Int, body: String): String {
    val detail = runCatching {
        val element = API_JSON.parseToJsonElement(body)
        ((element as? JsonObject)?.get("detail") as? JsonPrimitive)?.contentOrNull
    }.getOrNull()
    return detail?.takeIf { it.isNotBlank() } ?: when (status) {
        401 -> "登录已过期，请重新登录"
        503 -> "电脑离线，资料库不可用"
        else -> "请求失败（$status）"
    }
}

private val JSON_TYPE = "application/json".toMediaType()

val API_JSON: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
