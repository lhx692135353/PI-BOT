package dev.pibot.android.update

import kotlinx.serialization.json.*

internal val updateJson = Json { ignoreUnknownKeys = true }
internal const val RELEASE_ROOT = "https://github.com/lhx692135353/PI-BOT/releases/download/"

data class UpdateCandidate(val version: String, val buildNumber: Int, val commit: String, val tag: String, val url: String, val sha256: String, val size: Long)

internal fun JsonObject.text(key: String): String = this[key]?.jsonPrimitive?.content ?: error("缺少更新字段 $key")
internal fun trustedAsset(url: String, tag: String, file: String): Boolean =
    tag !in setOf(".", "..") && file !in setOf(".", "..") && tag.matches(Regex("[A-Za-z0-9._-]+")) && file.matches(Regex("[A-Za-z0-9._-]+")) && url == "$RELEASE_ROOT$tag/$file"

internal fun releaseMatches(release: JsonObject, channel: String): Boolean {
    require(channel == "test" || channel == "stable")
    if (release["draft"]?.jsonPrimitive?.booleanOrNull != false) return false
    val pre = release["prerelease"]?.jsonPrimitive?.booleanOrNull ?: return false
    return if (channel == "test") pre && release.text("tag_name").matches(Regex("client-test-[1-9][0-9]*"))
    else !pre && release.text("tag_name").startsWith("client-stable-")
}

internal fun parseCandidate(release: JsonObject, manifest: JsonObject, channel: String, current: Int): UpdateCandidate? {
    require(releaseMatches(release, channel)) { "更新通道不匹配" }
    require(manifest["schemaVersion"]?.jsonPrimitive?.int == 1 && manifest.text("channel") == channel)
    val build = manifest["buildNumber"]!!.jsonPrimitive.int
    require(build > 0 && manifest.text("version") == "0.3.$build")
    require(manifest.text("commit").matches(Regex("[0-9a-f]{40}")))
    // Unknown compatibility requirements must not be silently ignored.
    require(manifest["minimumServerVersion"] == null || manifest["minimumServerVersion"] == JsonNull) { "此更新有服务器版本要求，请先核实兼容性" }
    val tag = release.text("tag_name")
    require(tag == "client-$channel-$build")
    val pkg = manifest["platforms"]!!.jsonObject["android"]!!.jsonObject
    val file = pkg.text("file")
    require(file == "Pi-Bot-Android.apk")
    val asset = release["assets"]!!.jsonArray.map { it.jsonObject }.single { it.text("name") == file }
    val url = asset.text("browser_download_url")
    val hash = pkg.text("sha256"); val size = pkg["size"]!!.jsonPrimitive.long
    require(trustedAsset(url, tag, file) && hash.matches(Regex("[0-9a-f]{64}")) && size in 1..268435456L)
    require(asset["size"]!!.jsonPrimitive.long == size)
    if (build <= current) return null
    return UpdateCandidate(manifest.text("version"), build, manifest.text("commit"), tag, url, hash, size)
}
