package dev.pibot.android

import dev.pibot.android.update.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class UpdatePolicyTest {
    private val hash = "a".repeat(64)
    private fun release(pre: Boolean = true, tag: String = "client-test-1001", url: String = "${RELEASE_ROOT}$tag/Pi-Bot-Android.apk") = updateJson.parseToJsonElement("""{"draft":false,"prerelease":$pre,"tag_name":"$tag","assets":[{"name":"Pi-Bot-Android.apk","size":123,"browser_download_url":"$url"}]}""").jsonObject
    private fun manifest(channel: String = "test", build: Int = 1001) = updateJson.parseToJsonElement("""{"schemaVersion":1,"channel":"$channel","buildNumber":$build,"version":"0.3.$build","commit":"${"a".repeat(40)}","minimumServerVersion":null,"platforms":{"android":{"file":"Pi-Bot-Android.apk","size":123,"sha256":"$hash"}}}""").jsonObject
    @Test fun separatesChannels() {
        assertTrue(releaseMatches(release(), "test")); assertFalse(releaseMatches(release(), "stable"))
        assertFalse(releaseMatches(release(false), "test"))
        assertTrue(releaseMatches(release(false, "client-stable-1001"), "stable"))
    }
    @Test fun numericVersionNotHash() {
        assertNotNull(parseCandidate(release(), manifest(), "test", 1000))
        assertNull(parseCandidate(release(), manifest(), "test", 1001))
        assertNull(parseCandidate(release(), manifest(), "test", 2000))
    }
    @Test fun restrictsRepositoryAndAsset() {
        assertFalse(trustedAsset("https://evil.test/file", "client-test-1", "file"))
        assertFalse(trustedAsset("${RELEASE_ROOT}../file", "..", "file"))
        assertFalse(trustedAsset("${RELEASE_ROOT}client-test-1/a.apk?x=1", "client-test-1", "a.apk"))
        try { parseCandidate(release(url = "https://evil.test/a.apk"), manifest(), "test", 1); fail() } catch (_: IllegalArgumentException) { }
    }
    @Test fun rejectsTampering() {
        for (bad in listOf(manifest("stable"), manifest(build = 1002), JsonObject(manifest() + ("minimumServerVersion" to JsonPrimitive("99"))), JsonObject(manifest() + ("commit" to JsonPrimitive("bad"))))) {
            try { parseCandidate(release(), bad, "test", 1); fail() } catch (_: IllegalArgumentException) { }
        }
    }
}
