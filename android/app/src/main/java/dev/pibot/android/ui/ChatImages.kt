package dev.pibot.android.ui

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.ExifInterface
import java.io.ByteArrayInputStream
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
import java.io.ByteArrayOutputStream

const val IMAGE_LIMIT_HINT = "最多 4 张图片，单张原图不超过 20 MB，合计不超过 32 MB；原图保存，模型仅使用压缩副本；支持 JPEG、PNG、WebP、GIF"
private const val MAX_IMAGE_BYTES = 20 * 1024 * 1024
private const val MAX_TOTAL_BYTES = 32L * 1024 * 1024
private val ACCEPTED_TYPES = listOf("image/jpeg", "image/png", "image/webp", "image/gif")

data class ReadImagesResult(
    val images: List<ChatImage>,
    val warnings: List<String>,
)

suspend fun readChatImages(context: Context, uris: List<Uri>, existing: List<ChatImage>): ReadImagesResult = withContext(Dispatchers.IO) {
    val warnings = mutableListOf<String>()
    val added = mutableListOf<ChatImage>()
    val maxCount = 4

    if (existing.size >= maxCount) {
        warnings.add("已有 ${existing.size} 张图片，无法再添加")
        return@withContext ReadImagesResult(existing, warnings)
    }

    val availableSlots = maxCount - existing.size
    val urisToProcess = if (uris.size > availableSlots) {
        warnings.add("最多 $maxCount 张，已有 ${existing.size} 张，本次只取前 $availableSlots 张")
        uris.take(availableSlots)
    } else {
        uris
    }

    // Calculate existing total bytes
    var totalBytes = existing.sumOf { Base64.decode(it.data, Base64.DEFAULT).size.toLong() }

    for (uri in urisToProcess) {
        try {
            val type = context.contentResolver.getType(uri).orEmpty()
            val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }?.take(255)?.takeIf { it.isNotBlank() } ?: "图片"

            if (type !in ACCEPTED_TYPES) {
                warnings.add("$name 类型不支持（$type），已跳过")
                continue
            }

            val rawBytes = context.contentResolver.openInputStream(uri)?.use { input ->
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (out.size() <= MAX_IMAGE_BYTES) {
                    val count = input.read(buffer, 0, minOf(buffer.size, MAX_IMAGE_BYTES + 1 - out.size()))
                    if (count < 0) break
                    out.write(buffer, 0, count)
                }
                out.toByteArray()
            }
            if (rawBytes == null || rawBytes.isEmpty()) {
                warnings.add("$name 无法读取，已跳过")
                continue
            }

            // Keep originals (including orientation, alpha and animation). The trusted
            // server/model boundary creates the only resized representation.
            if (rawBytes.size > MAX_IMAGE_BYTES) {
                warnings.add("$name 超过 20MB 限制，已跳过")
                continue
            }
            val finalBytes = rawBytes
            val finalType = type
            val finalName = name

            // Check total size
            if (totalBytes + finalBytes.size > MAX_TOTAL_BYTES) {
                warnings.add("$name 加入后超过合计 32MB 限制，已跳过")
                continue
            }

            totalBytes += finalBytes.size
            added.add(ChatImage(finalName, finalType, Base64.encodeToString(finalBytes, Base64.NO_WRAP)))
        } catch (e: java.io.IOException) {
            warnings.add("图片读取失败，已跳过")
        } catch (e: SecurityException) {
            warnings.add("没有图片读取权限，已跳过")
        }
    }

    ReadImagesResult(existing + added, warnings)
}

/** Decode a bounded preview off the UI thread, even for high resolution uploads. */
private suspend fun preview(image: ChatImage): ImageBitmap = withContext(Dispatchers.Default) {
    val bytes = Base64.decode(image.data, Base64.DEFAULT)
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true; inSampleSize = 1 }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    while (options.outWidth / options.inSampleSize > 1600 || options.outHeight / options.inSampleSize > 1600) options.inSampleSize *= 2
    options.inJustDecodeBounds = false
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: error("图片无法解码")
    val orientation = runCatching { ByteArrayInputStream(bytes).use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) } }.getOrDefault(1)
    val matrix = Matrix().apply {
        when (orientation) {
            2 -> setScale(-1f, 1f)
            3 -> setRotate(180f)
            4 -> setScale(1f, -1f)
            5 -> { setRotate(90f); postScale(-1f, 1f) }
            6 -> setRotate(90f)
            7 -> { setRotate(270f); postScale(-1f, 1f) }
            8 -> setRotate(270f)
        }
    }
    if (orientation in 2..8) Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).asImageBitmap()
    else bitmap.asImageBitmap()
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
