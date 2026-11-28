package dev.pibot.android

import android.os.Bundle
import android.content.Intent
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pibot.android.ui.AppRoot
import dev.pibot.android.ui.PiBotTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        if (BuildConfig.DEBUG && intent.getBooleanExtra("math_smoke", false)) {
            val source = org.json.JSONObject(assets.open("a2ui/math-smoke.json").bufferedReader().use { it.readText() }).getString("source")
            setContent { PiBotTheme { dev.pibot.android.ui.MathMarkdown(source, smoke = true) } }
            return
        }
        val app = application as PiBotApp
        val repository = app.repository
        app.push.handleIntent(intent)
        setContent {
            val skin = app.skinStore.skin.collectAsStateWithLifecycle().value
            PiBotTheme(skin = skin) {
                AppRoot(repository)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        (application as PiBotApp).push.handleIntent(intent)
    }
}
