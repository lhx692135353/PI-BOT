package dev.pibot.android.ui

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import dev.pibot.android.data.ChatImage
import dev.pibot.android.data.MessageImage
import dev.pibot.android.data.PiBotRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

const val IMAGE_LIMIT_HINT = "最多 4 张图片，单张不超过 2 MB，合计不超过 4 MB；支持 JPEG、PNG、WebP、GIF"
private const val MAX_IMAGE_BYTES = 2 * 1024 * 1024

suspend fun readChatImages(context: Context, uris: List<Uri>, existing: List<ChatImage>): List<ChatImage> = withContext(Dispatchers.IO) {
    require(existing.size + uris.size <= 4) { IMAGE_LIMIT_HINT }
    val added = uris.map { uri ->
        val type = context.contentResolver.getType(uri).orEmpty()
        require(type in listOf("image/jpeg", "image/png", "image/webp", "image/gif")) { IMAGE_LIMIT_HINT }
        val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
            val out = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (out.size() <= MAX_IMAGE_BYTES) {
                val count = input.read(buffer, 0, minOf(buffer.size, MAX_IMAGE_BYTES + 1 - out.size()))
                if (count < 0) break
                out.write(buffer, 0, count)
            }
            out.toByteArray()
        }
            ?: error("无法读取图片")
        require(bytes.isNotEmpty() && bytes.size <= MAX_IMAGE_BYTES) { IMAGE_LIMIT_HINT }
        val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        }?.take(255)?.takeIf { it.isNotBlank() } ?: "图片"
        ChatImage(name, type, Base64.encodeToString(bytes, Base64.NO_WRAP))
    }
    val all = existing + added
    require(all.sumOf { it.data.length * 3L / 4 - if (it.data.endsWith("==")) 2 else if (it.data.endsWith("=")) 1 else 0 } <= 4 * 1024 * 1024) { IMAGE_LIMIT_HINT }
    all
}

/** Decode a bounded preview off the UI thread, even for high resolution uploads. */
private suspend fun preview(image: ChatImage): ImageBitmap = withContext(Dispatchers.Default) {
    val bytes = Base64.decode(image.data, Base64.DEFAULT)
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true; inSampleSize = 1 }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    while (options.outWidth / options.inSampleSize > 1600 || options.outHeight / options.inSampleSize > 1600) options.inSampleSize *= 2
    options.inJustDecodeBounds = false
    (BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: error("图片无法解码")).asImageBitmap()
}

@Composable
fun ChatPicture(image: ChatImage? = null, remote: MessageImage? = null, botId: String = "", messageId: String = "", repository: PiBotRepository? = null, modifier: Modifier = Modifier) {
    var bitmap by remember(image, remote?.id) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(image, remote?.id) { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(image, remote?.id, attempt) {
        failed = false
        runCatching { preview(image ?: repository!!.image(botId, messageId, remote!!.id)) }
            .onSuccess { bitmap = it }.onFailure { failed = true }
    }
    val current = bitmap
    Box(modifier.clickable { if (current != null) expanded = true else if (failed) attempt++ }) {
        if (current != null) Image(current, image?.name ?: remote?.name, Modifier.fillMaxWidth().heightIn(max = 220.dp), contentScale = ContentScale.Fit)
        else Text(if (failed) "图片加载失败，点击重试" else "图片加载中…", color = Muted, modifier = Modifier.padding(8.dp))
    }
    if (expanded && current != null) Dialog(onDismissRequest = { expanded = false }) {
        Image(current, image?.name ?: remote?.name, Modifier.fillMaxWidth().clickable { expanded = false }, contentScale = ContentScale.Fit)
    }
}
