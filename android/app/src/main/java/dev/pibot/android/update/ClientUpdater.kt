package dev.pibot.android.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import dev.pibot.android.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class ClientUpdater(context: Context) {
    private val context = context.applicationContext
    private val http = OkHttpClient.Builder().followSslRedirects(false).connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).callTimeout(10, TimeUnit.MINUTES).build()
    private val directory get() = File(context.cacheDir, "updates").apply { mkdirs() }
    private fun request(url: String) = http.newCall(Request.Builder().url(url).header("Accept", "application/vnd.github+json").header("User-Agent", "Pi-Bot/${BuildConfig.VERSION_NAME}").build()).execute()
    private fun json(url: String, limit: Long): JsonElement = request(url).use { response ->
        check(response.isSuccessful) { "GitHub 请求失败：${response.code}（可能限流或网络不可用）" }
        val body = response.body ?: error("空响应")
        require(body.contentLength() <= limit) { "更新元数据过大" }
        val data = body.byteStream().use { input ->
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) { val n = input.read(buffer); if (n < 0) break; require(output.size().toLong() + n <= limit) { "更新元数据过大" }; output.write(buffer, 0, n) }
            output.toByteArray()
        }
        require(data.size <= limit) { "更新元数据过大" }
        updateJson.parseToJsonElement(data.toString(Charsets.UTF_8))
    }
    suspend fun check(channel: String): UpdateCandidate? = withContext(Dispatchers.IO) {
        require(channel in setOf("stable", "test"))
        var best: UpdateCandidate? = null
        // Paginate: do not let newer prereleases hide the stable channel.
        for (page in 1..5) {
            val releases = json("https://api.github.com/repos/lhx692135353/PI-BOT/releases?per_page=100&page=$page", 8L * 1024 * 1024).jsonArray
            for (element in releases) {
                val release = element.jsonObject
                if (!releaseMatches(release, channel)) continue
                val tag = release.text("tag_name")
                val assets = release["assets"]!!.jsonArray.map { it.jsonObject }
                val manifest = assets.singleOrNull { it.text("name") == "update-manifest.json" } ?: continue
                val url = manifest.text("browser_download_url")
                require(trustedAsset(url, tag, "update-manifest.json"))
                val candidate = parseCandidate(release, json(url, 65536).jsonObject, channel, BuildConfig.VERSION_CODE)
                if (candidate != null && candidate.buildNumber > (best?.buildNumber ?: 0)) best = candidate
            }
            if (releases.size < 100) break
            check(page < 5) { "发布记录过多，请在 GitHub 页面手动核实最新版本" }
        }
        best
    }
    suspend fun download(candidate: UpdateCandidate, onProgress: (Long, Long) -> Unit = { _, _ -> }): File = withContext(Dispatchers.IO) {
        require(trustedAsset(candidate.url, candidate.tag, "Pi-Bot-Android.apk"))
        val partial = File(directory, "update.part")
        val target = File(directory, "update.apk")
        partial.delete(); target.delete()
        try {
            request(candidate.url).use { response ->
                check(response.isSuccessful) { "下载安装包失败：${response.code}" }
                val body = response.body ?: error("安装包为空")
                var total = 0L
                var lastProgress = 0L
                withContext(Dispatchers.Main) { onProgress(0, candidate.size) }
                body.byteStream().use { input -> partial.outputStream().use { output ->
                    val buffer = ByteArray(65536)
                    while (true) {
                        val n = input.read(buffer); if (n < 0) break
                        total += n; require(total <= candidate.size) { "安装包大小不匹配" }; output.write(buffer, 0, n)
                        val now = System.nanoTime()
                        if (now - lastProgress >= 100_000_000L || total == candidate.size) {
                            lastProgress = now
                            withContext(Dispatchers.Main) { onProgress(total, candidate.size) }
                        }
                    }
                } }
                require(total == candidate.size) { "安装包下载不完整" }
            }
            verify(partial, candidate)
            check(partial.renameTo(target)) { "无法保存安装包" }
            target
        } catch (e: Exception) { partial.delete(); target.delete(); throw e }
    }
    @Suppress("DEPRECATION")
    fun verify(file: File, candidate: UpdateCandidate) {
        require(file.length() == candidate.size)
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val b = ByteArray(65536); while (true) { val n = input.read(b); if (n < 0) break; digest.update(b, 0, n) } }
        require(digest.digest().joinToString("") { "%02x".format(it) } == candidate.sha256) { "安装包校验失败，旧版不受影响" }
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = pm.getPackageArchiveInfo(file.absolutePath, flags) ?: error("无法读取安装包")
        val installed = pm.getPackageInfo(context.packageName, flags)
        require(archive.packageName == context.packageName) { "安装包应用标识不匹配" }
        val version = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        require(version == candidate.buildNumber.toLong() && version > BuildConfig.VERSION_CODE) { "安装包版本号不匹配或未递增" }
        fun certificates(info: android.content.pm.PackageInfo): Set<String> {
            val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
            return signatures?.map { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { byte -> "%02x".format(byte) } }?.toSet().orEmpty()
        }
        val current = certificates(installed)
        require(current.isNotEmpty() && current == certificates(archive)) { "签名不兼容，不能覆盖更新；请保留旧版，不要卸载" }
    }
    fun permissionIntent(): Intent? = if (!context.packageManager.canRequestPackageInstalls())
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) else null
    fun installIntent(): Intent {
        val file = File(directory, "update.apk")
        return Intent(Intent.ACTION_VIEW).setDataAndType(FileProvider.getUriForFile(context, "${context.packageName}.updates", file), "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    suspend fun verifyReady(candidate: UpdateCandidate) = withContext(Dispatchers.IO) { verify(File(directory, "update.apk"), candidate) }
}
