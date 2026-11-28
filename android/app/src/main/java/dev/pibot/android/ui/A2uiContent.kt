package dev.pibot.android.ui

import android.annotation.SuppressLint
import java.net.URI
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import dev.pibot.android.data.API_JSON
import dev.pibot.android.data.Message
import dev.pibot.android.data.PiBotRepository
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayInputStream
import org.json.JSONObject

private const val UI_ORIGIN = "https://pibot-ui.invalid"
/** Renderer assets only. No account tokens, filesystem or general native API are exposed to the page. */
internal fun a2uiAssetPath(url: String): String? {
    val uri = runCatching { URI(url) }.getOrNull() ?: return null
    if (uri.scheme != "https" || uri.host != "pibot-ui.invalid" || uri.port != -1 || uri.userInfo != null) return null
    val path = uri.path ?: return null
    return when (path) {
        "/a2ui/index.html" -> "a2ui/index.html"
        "/a2ui/renderer.js" -> "a2ui/renderer.js"
        "/a2ui/style.css" -> "a2ui/style.css"
        else -> if (Regex("^/a2ui/KaTeX_[A-Za-z0-9_-]+\\.(woff2?|ttf)$").matches(path)) path.removePrefix("/") else null
    }
}
internal fun localUiAssetResponse(context: android.content.Context, url: String): WebResourceResponse {
    val path = a2uiAssetPath(url)
    if (path != null) {
        val mime = when { path.endsWith(".js") -> "text/javascript"; path.endsWith(".css") -> "text/css"; path.endsWith(".woff2") -> "font/woff2"; path.endsWith(".woff") -> "font/woff"; path.endsWith(".ttf") -> "font/ttf"; else -> "text/html" }
        return runCatching { WebResourceResponse(mime, if(mime.startsWith("font/")) null else "UTF-8", context.assets.open(path)) }.getOrElse { WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0))) }
    }
    return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}
private class UiBridge(private val post: (String) -> Unit) {
    @JavascriptInterface fun postMessage(value: String) { if (value.length <= 240_000) post(value) }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun A2uiContent(message: Message, repository: PiBotRepository, disabled: Boolean, viewportHeight: Float, onDisplayed: (Set<String>, Boolean) -> Unit = { _, _ -> }) {
    val scope = rememberCoroutineScope()
    var contentHeight by remember(message.id) { mutableStateOf(180f) }
    var pageWidth by remember(message.id) { mutableStateOf(0f) }
    var widthDp by remember(message.id) { mutableStateOf(0f) }
    val density = LocalDensity.current.density
    val naturalHeight = contentHeight * if (pageWidth > 0 && widthDp > 0) widthDp / pageWidth else 1f
    val height = uiDisplayHeight(naturalHeight, viewportHeight)
    var ready by remember(message.id) { mutableStateOf(false) }
    val latest by rememberUpdatedState(message)
    val locked by rememberUpdatedState(disabled)
    val displayed by rememberUpdatedState(onDisplayed)
    var web by remember(message.id) { mutableStateOf<WebView?>(null) }
    fun sendDocument(view: WebView) {
        val payload = buildJsonObject { put("document", latest.ui ?: JsonNull); put("disabled", JsonPrimitive(locked)) }
        view.evaluateJavascript("window.piBotUi?.receive(JSON.parse(${JSONObject.quote(payload.toString())}));", null)
    }
    DisposableEffect(message.id) {
        onDispose { web?.let { it.removeJavascriptInterface("PiBotUiHost"); it.stopLoading(); it.destroy() }; web = null }
    }
    AndroidView(
        modifier = Modifier.fillMaxWidth().height(height.dp).onSizeChanged { widthDp = it.width / density },
        factory = { context ->
            UiScrollWebView(context).apply {
                verticalScrollingEnabled = naturalHeight > height + 1
                web = this
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.setSupportMultipleWindows(false)
                settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                        if (request?.url?.toString()?.matches(Regex("https://tile\\.openstreetmap\\.org/[0-9]+/[0-9]+/[0-9]+\\.png")) == true) return null
                        return localUiAssetResponse(context, request?.url?.toString().orEmpty())
                    }
                    private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                    override fun onPageFinished(view: WebView, url: String) { if (url == "$UI_ORIGIN/a2ui/index.html") sendDocument(view) }
                }
                addJavascriptInterface(UiBridge { raw ->
                    scope.launch {
                        val packet = runCatching { API_JSON.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return@launch
                        when (packet["type"]?.jsonPrimitive?.contentOrNull) {
                            "ready" -> { ready = true; web?.let(::sendDocument) }
                            "height" -> packet["height"]?.jsonPrimitive?.intOrNull?.takeIf { it >= 0 }?.let {
                                contentHeight = it.toFloat()
                                pageWidth = packet["width"]?.jsonPrimitive?.intOrNull?.takeIf { value -> value > 0 }?.toFloat() ?: 0f
                            }
                            "copy" -> {
                                val id = packet["id"]?.jsonPrimitive?.contentOrNull ?: return@launch
                                val text = packet["payload"]?.jsonObject?.get("text")?.jsonPrimitive?.contentOrNull ?: return@launch
                                if(text.length <= 200_000) (context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("公式",text))
                                val response = buildJsonObject { put("id",JsonPrimitive(id));put("result",JsonNull) }
                                web?.evaluateJavascript("window.piBotUi?.respond(JSON.parse(${JSONObject.quote(response.toString())}));",null)
                            }
                            "displayed" -> {
                                val ids = packet["ids"] as? kotlinx.serialization.json.JsonArray ?: return@launch
                                displayed(ids.mapNotNull { it.jsonPrimitive.contentOrNull }.filter { id -> latest.attachments.any { it.id == id } }.toSet(), packet["remove"]?.jsonPrimitive?.contentOrNull == "true")
                            }
                            "state", "action", "image", "open", "external" -> {
                                val id = packet["id"]?.jsonPrimitive?.contentOrNull ?: return@launch
                                val payload = packet["payload"] as? JsonObject ?: return@launch
                                val result = runCatching {
                                    val type = packet["type"]?.jsonPrimitive?.contentOrNull
                                    if ((type == "state" || type == "action") && locked) throw IllegalStateException("请等待 Bot 完成当前任务后再操作")
                                    when (type) {
                                        "image", "open" -> {
                                            val artifactId = payload["id"]?.jsonPrimitive?.contentOrNull ?: error("图片无效")
                                            require(latest.attachments.any { it.id == artifactId }) { "附件不属于当前消息" }
                                            if (type == "image") {
                                                val variant = if (payload["variant"]?.jsonPrimitive?.contentOrNull == "original") "original" else "thumbnail"
                                                val image = repository.artifactImage(latest.botId, latest.id, artifactId, variant)
                                                JsonPrimitive("data:${image.mimeType};base64,${image.data}")
                                            } else {
                                                context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(repository.reportOpen(artifactId))))
                                                JsonNull
                                            }
                                        }
                                        "external" -> {
                                            val uri = URI(payload["url"]?.jsonPrimitive?.contentOrNull ?: error("链接无效"))
                                            require(uri.scheme in listOf("https", "http") && uri.host != null && uri.userInfo == null)
                                            context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(uri.toString())))
                                            JsonNull
                                        }
                                        "state" -> repository.saveUiState(latest.botId, latest.id, payload)
                                        else -> { repository.submitUiAction(latest.botId, latest.id, payload); JsonNull }
                                    }
                                }
                                val response = buildJsonObject {
                                    put("id", JsonPrimitive(id))
                                    result.onSuccess { put("result", it) }.onFailure { put("error", JsonPrimitive(errorText(it))) }
                                }
                                web?.evaluateJavascript("window.piBotUi?.respond(JSON.parse(${JSONObject.quote(response.toString())}));", null)
                            }
                        }
                    }
                }, "PiBotUiHost")
                loadUrl("$UI_ORIGIN/a2ui/index.html")
            }
        },
        update = { view ->
            view.verticalScrollingEnabled = naturalHeight > height + 1
            if (view.scrollY > 0 && !view.verticalScrollingEnabled) view.scrollTo(0, 0)
            if (ready) sendDocument(view)
        },
    )
}
