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

fun parseServerUrl(raw: String, allowCleartextLan: Boolean): ServerUrl {
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
    if (scheme == "http" && !(isLocalCleartextHost(host) || (allowCleartextLan && isPrivateCleartextHost(host)))) {
        throw IllegalArgumentException(if (allowCleartextLan) "明文 http 只能连本机、模拟器或局域网" else "请使用 https 地址")
    }
    return ServerUrl(trimmed)
}

private fun isPrivateCleartextHost(host: String): Boolean {
    if (host == "localhost" || host == "10.0.2.2") return true
    val parts = host.split('.')
    if (parts.size != 4) return false
    val numbers = parts.map { it.toIntOrNull() ?: return false }
    if (numbers.any { it !in 0..255 }) return false
    val first = numbers[0]
    val second = numbers[1]
    return first == 127 || first == 10 || (first == 192 && second == 168) || (first == 172 && second in 16..31)
}

private fun isLocalCleartextHost(host: String): Boolean =
    host in setOf("localhost", "127.0.0.1", "10.0.2.2")
