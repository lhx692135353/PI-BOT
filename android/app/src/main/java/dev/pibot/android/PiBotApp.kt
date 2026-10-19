package dev.pibot.android

import android.app.Application
import dev.pibot.android.data.PiBotApi
import dev.pibot.android.data.PiBotRepository
import dev.pibot.android.data.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class PiBotApp : Application() {
    lateinit var repository: PiBotRepository
        private set

    override fun onCreate() {
        super.onCreate()
        val http = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
        repository = PiBotRepository(
            api = PiBotApi(http),
            http = http,
            storage = SessionStore(this),
            scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
        )
    }
}
