package dev.pibot.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class A2uiAssetsTest {
    @Test fun onlyBundledRendererFilesAreAvailable() {
        assertEquals("a2ui/index.html", a2uiAssetPath("https://pibot-ui.invalid/a2ui/index.html"))
        assertEquals("a2ui/renderer.js", a2uiAssetPath("https://pibot-ui.invalid/a2ui/renderer.js"))
        assertEquals("a2ui/style.css", a2uiAssetPath("https://pibot-ui.invalid/a2ui/style.css"))
        assertEquals("a2ui/KaTeX_Main-Regular.woff2", a2uiAssetPath("https://pibot-ui.invalid/a2ui/KaTeX_Main-Regular.woff2"))
        for (url in listOf("https://pibot-ui.invalid/a2ui/evil.woff2", "https://pibot-ui.invalid/a2ui/KaTeX_Main-Regular.woff2/../index.html","https://evil.example/a2ui/index.html", "file:///etc/passwd", "javascript:alert(1)", "https://pibot-ui.invalid/a2ui/../index.html", "https://pibot-ui.invalid/a2ui/%2e%2e/renderer.js", "https://pibot-ui.invalid:443/a2ui/index.html", "https://user@pibot-ui.invalid/a2ui/index.html")) {
            assertNull(url, a2uiAssetPath(url))
        }
    }
}
