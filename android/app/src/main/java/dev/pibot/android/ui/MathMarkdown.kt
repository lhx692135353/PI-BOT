package dev.pibot.android.ui

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URI
import dev.pibot.android.BuildConfig

private class MathBridge(private val send: (String) -> Unit) {
    @JavascriptInterface fun postMessage(value: String) { if (value.length <= 500_000) send(value) }
}

/** Uses the bundled renderer, with only height, selection, copy and HTTP(S) link messages. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun MathMarkdown(source: String, modifier: Modifier = Modifier, color: Color = Ink, fontSize: Float = 14f, smoke: Boolean = false) {
    val scope = rememberCoroutineScope()
    val selection = LocalMessageSelection.current
    val current by rememberUpdatedState(source)
    val currentColor by rememberUpdatedState(color)
    val currentSize by rememberUpdatedState(fontSize)
    var height by remember { mutableStateOf(24f) }
    var ready by remember { mutableStateOf(false) }
    var web by remember { mutableStateOf<UiScrollWebView?>(null) }
    var smokeStarted by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf("") }
    fun update(view: WebView) {
        val value = JSONObject().put("markdown", JSONObject().put("source", current)
            .put("fontSize", currentSize * view.resources.configuration.fontScale)
            .put("color", "#%06X".format(currentColor.toArgb() and 0xffffff))).toString()
        if (value == sent) return
        sent = value
        view.evaluateJavascript("window.piBotUi?.receive(JSON.parse(${JSONObject.quote(value)}));", null)
        if(BuildConfig.DEBUG && smoke && !smokeStarted) {
            smokeStarted = true
            val script = view.context.assets.open("a2ui/math-smoke.js").bufferedReader().use { it.readText() }
            view.evaluateJavascript(script + ";window.piBotMathSmoke(JSON.parse(${JSONObject.quote(value)}));", null)
        }
    }
    DisposableEffect(Unit) {
        onDispose { web?.let { selection?.endWeb(it); it.removeJavascriptInterface("PiBotUiHost"); it.stopLoading(); it.destroy() }; web = null }
    }
    AndroidView(modifier = modifier.fillMaxWidth().height(height.dp), factory = { context ->
        UiScrollWebView(context).apply {
            web = this
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false; settings.allowContentAccess = false
            settings.domStorageEnabled = false; settings.javaScriptCanOpenWindowsAutomatically = false
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?) = localUiAssetResponse(context, request?.url?.toString().orEmpty())
            }
            addJavascriptInterface(MathBridge { raw -> scope.launch {
                val packet = runCatching { JSONObject(raw) }.getOrNull() ?: return@launch
                when (packet.optString("type")) {
                    "ready" -> { ready = true; sent = ""; web?.let(::update) }
                    "height" -> height = packet.optDouble("height", 24.0).toFloat().coerceIn(1f, 1_000_000f)
                    "selection" -> web?.let { if (packet.optBoolean("active")) selection?.startWeb(it) else selection?.endWeb(it) }
                    "math_smoke" -> if(BuildConfig.DEBUG && smoke) {
                        val result = packet.optJSONObject("result") ?: JSONObject().put("ok",false)
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        result.put("clipboard_text", clipboard.primaryClip?.getItemAt(0)?.text?.toString().orEmpty())
                        result.put("clipboard_ok", clipboard.primaryClip?.getItemAt(0)?.text?.toString() == result.optString("expectedCopy"))
                        context.filesDir.resolve("math-smoke.json").writeText(result.toString())
                    }
                    "copy", "external" -> {
                        val id = packet.optString("id")
                        val result = runCatching {
                            val payload = packet.getJSONObject("payload")
                            if (packet.optString("type") == "copy") {
                                val text = payload.getString("text"); require(text.length <= 400_000)
                                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("公式", text))
                            } else {
                                val uri = URI(payload.getString("url"))
                                require(uri.scheme in listOf("https", "http") && uri.host != null && uri.userInfo == null)
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri.toString())))
                            }
                        }
                        val response = JSONObject().put("id", id)
                        result.onSuccess { response.put("result", JSONObject.NULL) }.onFailure { response.put("error", errorText(it)) }
                        web?.evaluateJavascript("window.piBotUi?.respond(JSON.parse(${JSONObject.quote(response.toString())}));", null)
                    }
                }
            } }, "PiBotUiHost")
            loadUrl("https://pibot-ui.invalid/a2ui/index.html")
        }
    }, update = { if (ready) update(it) })
}
