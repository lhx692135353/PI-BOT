package dev.pibot.android

import android.app.Application
import dev.pibot.android.data.PiBotApi
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.data.SessionStore
import dev.pibot.android.data.TimelineCache
import dev.pibot.android.push.PushController
import dev.pibot.android.push.PushRestartActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

class PiBotApp : Application() {
    val ready = CompletableDeferred<Unit>()
    lateinit var api: PiBotApi
        private set
    lateinit var push: PushController
        private set
    lateinit var repository: PiBotRepository
        private set

    override fun onCreate() {
        super.onCreate()
        if (PushRestartActivity.isRestartProcess(this)) return
        val http = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        api = PiBotApi(http)
        repository = PiBotRepository(
            api = api,
            http = http,
            storage = SessionStore(this),
            scope = scope,
            timelineStore = TimelineCache(File(cacheDir, "timelines")),
        )
        push = PushController(this, repository, api, scope)
        repository.onSessionChanged = push::sessionChanged
        ready.complete(Unit)
        if (repository.session.value == null) push.sessionChanged(null, null) else push.sync()
    }
}
