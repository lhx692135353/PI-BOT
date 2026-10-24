package dev.pibot.android

import dev.pibot.android.data.Device
import dev.pibot.android.data.encodePhoneMap
import dev.pibot.android.data.isAcquireApplicable
import dev.pibot.android.data.parseExpiresMillis
import dev.pibot.android.data.phoneAssociationKey
import dev.pibot.android.data.readPhoneMap
import dev.pibot.android.data.resolvePhoneDevice
import dev.pibot.android.data.validateAcquireResponse
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class PhoneAssociationTest {
    private val first = Device(id = "00000000-0000-4000-8000-000000000001", label = "工作电脑")
    private val second = Device(id = "00000000-0000-4000-8000-000000000002", label = "另一台")

    @Test
    fun choosesARealAuthorizedComputerAndDoesNotInventOne() {
        val both = listOf(first, second)
        assertEquals(second.id, resolvePhoneDevice(second.id, first.id, both).deviceId)
        assertNull(resolvePhoneDevice("missing", first.id, both).deviceId)
        assertEquals("execution", resolvePhoneDevice(null, first.id, both).source)
        assertNull(resolvePhoneDevice(first.id, null, listOf(first.copy(revokedAt = "2026-10-23T00:00:00Z"), second)).deviceId)
        assertNull(resolvePhoneDevice(null, "missing", listOf(first)).deviceId)
        assertEquals("none", resolvePhoneDevice(null, null, both).source)
        assertNull(resolvePhoneDevice(null, null, emptyList()).deviceId)
        assertNull(resolvePhoneDevice(null, null, listOf(first)).deviceId)
    }

    @Test
    fun mapRoundTripDropsInvalidEntries() {
        val parsed = readPhoneMap("""{"bot":"device","bad":1}""")
        assertNull(parsed["bad"])
        assertEquals("device", readPhoneMap(encodePhoneMap(parsed))["bot"])
    }

    @Test
    fun namespacedAccountKeySeparatesUsersAndProvidesSafeDefault() {
        assertEquals(phoneAssociationKey(null), phoneAssociationKey("   "))
        assertFalse(phoneAssociationKey("alice") == phoneAssociationKey("bob"))
        assertEquals(phoneAssociationKey("bob"), phoneAssociationKey(" bob  "))
        assertFalse(phoneAssociationKey("alice", "https://a.example") == phoneAssociationKey("alice", "https://b.example"))
        assertEquals(phoneAssociationKey("alice", "https://a.example"), phoneAssociationKey("alice", "https://a.example/"))
    }

    @Test
    fun parseExpiresMillisHandlesNumericAndIsoStrings() {
        val epochSeconds = 1700000000L
        assertEquals(1700000000000L, parseExpiresMillis(JsonPrimitive(epochSeconds)))
        val epochMillis = 1700000000123L
        assertEquals(1700000000123L, parseExpiresMillis(JsonPrimitive(epochMillis)))
        assertEquals(1700000000000L, parseExpiresMillis(JsonPrimitive("2023-11-14T22:13:20Z")))
        assertNull(parseExpiresMillis(JsonPrimitive("invalid-date")))
        assertNull(parseExpiresMillis(null))
    }

    @Test
    fun validateAcquireResponseExtractsSessionAndProtectsAgainstInvalidPayloads() {
        val now = 1_770_000_000_000L
        val validUuid = UUID.randomUUID().toString()

        // 正常成功
        val okResp = buildJsonObject {
            put("sessionId", JsonPrimitive(validUuid))
            put("expiresAt", JsonPrimitive(now + 60_000L))
        }
        val okVal = validateAcquireResponse(okResp, now)
        assertTrue(okVal.isSuccess)
        assertEquals(validUuid, okVal.sessionId)
        assertEquals(now + 60_000L, okVal.expiresAtMs)
        assertNull(okVal.error)

        // 过期会话：保留 sessionId 供客户端释放，但校验失败
        val expiredResp = buildJsonObject {
            put("sessionId", JsonPrimitive(validUuid))
            put("expiresAt", JsonPrimitive(now - 1000L))
        }
        val expiredVal = validateAcquireResponse(expiredResp, now)
        assertFalse(expiredVal.isSuccess)
        assertEquals(validUuid, expiredVal.sessionId)
        assertEquals("会话已过期", expiredVal.error)

        // 非法 UUID 会话：保留 sessionId 供客户端释放，但校验失败
        val badUuidResp = buildJsonObject {
            put("sessionId", JsonPrimitive("not-a-uuid"))
            put("expiresAt", JsonPrimitive(now + 60_000L))
        }
        val badUuidVal = validateAcquireResponse(badUuidResp, now)
        assertFalse(badUuidVal.isSuccess)
        assertEquals("not-a-uuid", badUuidVal.sessionId)
        assertEquals("会话标识不是合法 UUID", badUuidVal.error)

        // 缺少 sessionId
        val emptyResp = buildJsonObject {
            put("expiresAt", JsonPrimitive(now + 60_000L))
        }
        val emptyVal = validateAcquireResponse(emptyResp, now)
        assertFalse(emptyVal.isSuccess)
        assertNull(emptyVal.sessionId)
        assertNotNull(emptyVal.error)
    }

    @Test
    fun isAcquireApplicableGuardsAgainstStaleTokensAndDeviceSwitching() {
        val target = "00000000-0000-4000-8000-000000000001"
        val other = "00000000-0000-4000-8000-000000000002"

        // 正常前台且条件一致
        assertTrue(isAcquireApplicable(target, target, 5L, 5L, foreground = true))

        // 切后台
        assertFalse(isAcquireApplicable(target, target, 5L, 5L, foreground = false))

        // 切了设备
        assertFalse(isAcquireApplicable(target, other, 5L, 5L, foreground = true))
        assertFalse(isAcquireApplicable(target, null, 5L, 5L, foreground = true))

        // 迟到的 token (epoch 已自增)
        assertFalse(isAcquireApplicable(target, target, 4L, 5L, foreground = true))
    }
}
