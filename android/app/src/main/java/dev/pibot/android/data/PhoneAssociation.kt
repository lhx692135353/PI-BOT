package dev.pibot.android.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.util.UUID

data class PhoneChoice(val deviceId: String?, val source: String)

/** Choose one already authorized execution computer. Does not invent phones or AVDs. */
fun resolvePhoneDevice(savedDeviceId: String?, executionDeviceId: String?, devices: List<Device>): PhoneChoice {
    val live = devices.filter { it.revokedAt == null }
    fun has(id: String?) = id != null && live.any { it.id == id }
    // A stale explicit binding is not permission to silently select another computer.
    if (!savedDeviceId.isNullOrBlank()) return if (has(savedDeviceId)) PhoneChoice(savedDeviceId, "saved") else PhoneChoice(null, "missing")
    return PhoneChoice(null, "none")
}

/** Namespaced key for SharedPreferences mapping per account. */
fun phoneAssociationKey(userId: String?, serverUrl: String? = null): String {
    val trimmed = userId?.trim().orEmpty()
    val server = serverUrl?.trim()?.trimEnd('/').orEmpty()
    // Length prefix avoids separator collisions. Legacy user-only maps are not migrated:
    // their server identity is unknown, so users must explicitly select again.
    return "map.v2.${server.length}:$server.${trimmed.length}:$trimmed"
}

fun readPhoneMap(raw: String?): Map<String, String> {
    if (raw.isNullOrBlank()) return emptyMap()
    val obj = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return emptyMap()
    return obj.mapNotNull { (key, value) ->
        val primitive = value as? JsonPrimitive ?: return@mapNotNull null
        if (!primitive.isString) return@mapNotNull null
        val id = primitive.content
        if (key.isBlank() || id.isBlank()) null else key to id
    }.toMap()
}

fun encodePhoneMap(map: Map<String, String>): String = JsonObject(map.mapValues { JsonPrimitive(it.value) }).toString()

/** Parses timestamp from Long/String or ISO-8601 format to epoch millis. */
fun parseExpiresMillis(value: JsonElement?): Long? {
    val primitive = value as? JsonPrimitive ?: return null
    val raw = primitive.longOrNull ?: primitive.content.toLongOrNull()
    if (raw != null) return if (raw < 1_000_000_000_000L) raw * 1000 else raw
    return runCatching { Instant.parse(primitive.content).toEpochMilli() }.getOrNull()
}

data class AcquireValidation(
    val sessionId: String?,
    val expiresAtMs: Long?,
    val error: String? = null
) {
    val isSuccess: Boolean get() = error == null && !sessionId.isNullOrBlank() && expiresAtMs != null
}

/** Validates raw acquire response, extracting sessionId even on invalid expiration so caller can safely release. */
fun validateAcquireResponse(response: JsonObject, nowMs: Long): AcquireValidation {
    val rawSession = response["sessionId"]?.let { (it as? JsonPrimitive)?.content }
    if (rawSession.isNullOrBlank()) {
        return AcquireValidation(null, null, "未获得会话标识")
    }
    val isValidUuid = runCatching { UUID.fromString(rawSession) }.isSuccess
    if (!isValidUuid) {
        return AcquireValidation(rawSession, null, "会话标识不是合法 UUID")
    }
    val expiresAtMs = parseExpiresMillis(response["expiresAt"])
        ?: return AcquireValidation(rawSession, null, "无效会话期限格式")
    if (expiresAtMs <= nowMs) {
        return AcquireValidation(rawSession, expiresAtMs, "会话已过期")
    }
    return AcquireValidation(rawSession, expiresAtMs, null)
}

/** Determines if an acquire response should be applied or treated as stale/canceled. */
fun isAcquireApplicable(
    targetDeviceId: String,
    currentDeviceId: String?,
    requestEpoch: Long,
    currentEpoch: Long,
    foreground: Boolean
): Boolean {
    return foreground && requestEpoch == currentEpoch && targetDeviceId == currentDeviceId
}
