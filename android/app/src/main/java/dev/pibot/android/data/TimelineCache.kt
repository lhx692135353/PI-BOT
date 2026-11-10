package dev.pibot.android.data

import dev.pibot.android.domain.Timeline
import kotlinx.serialization.Serializable
import java.io.File

/** Recent history per account and bot, so a conversation opens before the network answers. */
interface TimelineStore {
    fun read(userId: String, botId: String): Timeline?
    fun write(userId: String, botId: String, timeline: Timeline)
    fun clear(userId: String)
}

@Serializable
private data class CachedTimeline(val messages: List<Message>, val hasMore: Boolean)

/** Only the newest messages are kept; older pages come from the server on scroll. */
class TimelineCache(private val root: File, private val limit: Int = 60) : TimelineStore {
    private fun file(userId: String, botId: String) = File(File(root, safe(userId)), "${safe(botId)}.json")

    override fun read(userId: String, botId: String): Timeline? = runCatching {
        val f = file(userId, botId)
        if (!f.exists()) return null
        val cached = API_JSON.decodeFromString(CachedTimeline.serializer(), f.readText())
        cached.messages.takeIf { it.isNotEmpty() }?.let { Timeline(it.sortedBy { m -> m.seq }, cached.hasMore) }
    }.getOrNull()

    override fun write(userId: String, botId: String, timeline: Timeline) {
        val messages = timeline.messages.takeLast(limit)
        if (messages.isEmpty()) return
        runCatching {
            val f = file(userId, botId)
            f.parentFile?.mkdirs()
            val tmp = File(f.parentFile, "${f.name}.tmp")
            tmp.writeText(API_JSON.encodeToString(CachedTimeline.serializer(), CachedTimeline(messages, timeline.hasMore || messages.size < timeline.messages.size)))
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
        }
    }

    override fun clear(userId: String) {
        File(root, safe(userId)).deleteRecursively()
    }

    private fun safe(id: String) = id.replace(Regex("[^A-Za-z0-9_-]"), "_")
}
