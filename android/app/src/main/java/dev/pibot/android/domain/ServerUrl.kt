package dev.pibot.android.domain

import java.net.URI
import java.net.URLEncoder

/** Server root, possibly under a path prefix such as `https://host/pibot`. */
data class ServerUrl(val base: String) {
    fun eventsSocket(token: String): String {
        val socket = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> error("服务器地址无效")
        }
        return "$socket/ws/events?token=${URLEncoder.encode(token, "UTF-8")}"
    }
}

fun parseServerUrl(raw: String): ServerUrl {
    val trimmed = raw.trim().trimEnd('/')
    if (trimmed.isEmpty()) throw IllegalArgumentException("请填写服务器地址")
    val uri = try {
        URI(trimmed)
    } catch (_: Exception) {
        throw IllegalArgumentException("服务器地址无效")
    }
    val scheme = uri.scheme?.lowercase()
    val host = uri.host?.lowercase()
    if (scheme != "https" && scheme != "http") throw IllegalArgumentException("服务器地址需要以 http 或 https 开头")
    if (host.isNullOrBlank() || uri.userInfo != null) throw IllegalArgumentException("服务器地址无效")
    if (!uri.rawQuery.isNullOrEmpty() || uri.rawFragment != null) throw IllegalArgumentException("服务器地址不能带查询参数")
    return ServerUrl(scheme + trimmed.substring(trimmed.indexOf(':')))
}
