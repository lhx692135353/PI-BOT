package dev.pibot.android.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import androidx.core.content.ContextCompat
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import dev.pibot.android.PiBotApp
import dev.pibot.android.data.API_JSON
import dev.pibot.android.data.LiveCall
import dev.pibot.android.domain.ServerUrl
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.min
import kotlin.math.sqrt

/** Foreground microphone call. Audio stays on the device; the server relays it to the voice model. */
class VoiceCallService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val running = AtomicBoolean(false)
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    private var socket: WebSocket? = null
    private var recorder: AudioRecord? = null
    private var player: AudioTrack? = null
    private var canceller: AcousticEchoCanceler? = null
    private var audioRoute: CallAudioRoute? = null
    private var botId: String? = null
    private var callId: String? = null
    private var muted = false
    private var hungUp = false
    private var startedAt = 0L
    private var droppedAt = 0L
    private var attempts = 0
    private var writtenSamples = 0
    private var loudSince = 0L
    private var lastBarge = 0L
    private var sawPlayback = false
    private val audioLock = Any()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_HANGUP -> {
                if (botId == null) { stopSelf(); return START_NOT_STICKY }
                hangup()
                return START_NOT_STICKY
            }
            ACTION_MUTE -> {
                setMuted(intent.getBooleanExtra(EXTRA_MUTED, false))
                return START_STICKY
            }
        }
        val incoming = intent?.getStringExtra(EXTRA_BOT)
        if (incoming.isNullOrBlank()) { stopSelf(); return START_NOT_STICKY }
        if (botId != null && botId != incoming) return START_STICKY
        if (botId == incoming && running.get()) return START_STICKY
        botId = incoming
        hungUp = false
        if (!showCallNotification()) { fail("无法显示通话通知"); return START_NOT_STICKY }
        if (startAudio() && !hungUp) connect()
        return START_STICKY
    }

    override fun onDestroy() {
        hungUp = true
        running.set(false)
        handler.removeCallbacksAndMessages(null)
        socket?.cancel()
        socket = null
        releaseAudio()
        val bot = botId
        botId = null
        if (bot != null && repository().liveCall.value?.botId == bot) repository().endLiveCall(bot, null)
        super.onDestroy()
    }

    private fun repository() = (application as PiBotApp).repository

    private fun showCallNotification(): Boolean {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, "语音通话", NotificationManager.IMPORTANCE_LOW))
        val hangup = PendingIntent.getService(this, 1, Intent(this, javaClass).setAction(ACTION_HANGUP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = Notification.Builder(this, CHANNEL)
            .setContentTitle("语音通话")
            .setContentText("正在和 Bot 通话")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "挂断", hangup).build())
            .build()
        return try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else startForeground(NOTIFICATION_ID, notification)
            true
        } catch (_: Exception) { false }
    }

    @Synchronized
    private fun startAudio(): Boolean {
        if (running.get()) return true
        audioRoute = CallAudioRoute(AndroidCallAudioSystem(getSystemService(AudioManager::class.java)))
        try {
            audioRoute?.start()
        } catch (error: Exception) {
            Log.w("PiBotVoice", "Unable to select speakerphone", error)
            fail("无法开启免提，请重试")
            return false
        }
        try {
            val minIn = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val minOut = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            if (minIn <= 0 || minOut <= 0) { fail("这台设备无法以通话音质录音"); return false }
            val record = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minIn, 3200))
            recorder = record
            if (record.state != AudioRecord.STATE_INITIALIZED) { fail("无法打开麦克风"); return false }
            val track = AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(maxOf(minOut, 3200))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setSessionId(record.audioSessionId)
                .build()
            player = track
            if (track.state != AudioTrack.STATE_INITIALIZED) { fail("无法打开扬声器"); return false }
            if (AcousticEchoCanceler.isAvailable()) canceller = runCatching { AcousticEchoCanceler.create(record.audioSessionId)?.also { it.enabled = true } }.getOrNull()
            writtenSamples = 0
            running.set(true)
            record.startRecording()
            track.play()
            thread(name = "pibot-voice-mic", isDaemon = true) { capture(record) }
            handler.post(playbackWatch)
            return true
        } catch (_: SecurityException) {
            fail("需要麦克风权限才能语音通话")
        } catch (error: Exception) {
            Log.w("PiBotVoice", "Unable to start call audio", error)
            fail("无法开启语音通话，请重试")
        }
        return false
    }

    private fun capture(record: AudioRecord) {
        val buffer = ByteArray(3200)
        while (running.get()) {
            val read = record.read(buffer, 0, buffer.size)
            if (read <= 0) continue
            if (!muted) socket?.send(buffer.toByteString(0, read))
            maybeBarge(buffer, read)
        }
    }

    private fun maybeBarge(buffer: ByteArray, length: Int) {
        if (muted || !playing()) { loudSince = 0L; return }
        val now = System.currentTimeMillis()
        if (energy(buffer, length) < 1800) { loudSince = 0L; return }
        if (loudSince == 0L) loudSince = now
        else if (now - loudSince >= 200 && now - lastBarge > 800) {
            lastBarge = now
            loudSince = 0L
            sendJson("""{"type":"barge"}""")
        }
    }

    private fun playing(): Boolean {
        val track = player ?: return false
        return writtenSamples - track.playbackHeadPosition > 800
    }

    private val playbackWatch = object : Runnable {
        override fun run() {
            if (!running.get()) return
            val active = playing()
            if (sawPlayback && !active) sendJson("""{"type":"playback_idle"}""")
            sawPlayback = active
            handler.postDelayed(this, 120)
        }
    }

    private fun play(bytes: ByteString) {
        synchronized(audioLock) {
            val track = player ?: return
            val data = bytes.toByteArray()
            val wrote = track.write(data, 0, data.size)
            if (wrote > 0) writtenSamples += wrote / 2
            sawPlayback = true
        }
    }

    private fun clearPlayback() {
        synchronized(audioLock) {
            val track = player ?: return
            track.pause()
            track.flush()
            track.play()
            writtenSamples = track.playbackHeadPosition
            sawPlayback = false
            loudSince = 0L
        }
        sendJson("""{"type":"playback_idle"}""")
    }

    private fun connect() {
        val session = repository().session.value ?: return fail("请先登录")
        val bot = botId ?: return
        val url = ServerUrl(session.serverUrl).voiceSocket(session.token, bot, callId)
        publish(phase = "connecting")
        val request = Request.Builder().url(url).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) = onControl(webSocket, text)
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { if (webSocket === socket) play(bytes) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                if (code == 4401 || code == 4403 || code == 4404 || code == 4409) fail(reason.ifBlank { "通话已结束" })
                else detach(webSocket)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { detach(webSocket) }
        })
    }

    private fun onControl(webSocket: WebSocket, text: String) {
        if (webSocket !== socket) return
        val message = runCatching { API_JSON.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (message["type"]?.jsonPrimitive?.contentOrNull) {
            "hello" -> {
                callId = message["call_id"]?.jsonPrimitive?.contentOrNull ?: callId
                attempts = 0
                droppedAt = 0L
                if (startedAt == 0L) startedAt = System.currentTimeMillis()
                publish(phase = message["phase"]?.jsonPrimitive?.contentOrNull ?: "listening", callId = callId)
            }
            "state" -> publish(phase = message["phase"]?.jsonPrimitive?.contentOrNull ?: return)
            "clear" -> clearPlayback()
            "ended" -> finish(if (message["reason"]?.jsonPrimitive?.contentOrNull == "hangup") "hangup" else "通话已结束")
            "error" -> publish(error = message["detail"]?.jsonPrimitive?.contentOrNull ?: "通话失败")
        }
    }

    private fun detach(webSocket: WebSocket) {
        synchronized(this) { if (socket !== webSocket) return; socket = null }
        if (hungUp) return
        if (callId == null) {
            val detail = botId?.let { id -> repository().liveCall.value?.takeIf { it.botId == id }?.error }
            fail(detail ?: "没有接通")
            return
        }
        if (droppedAt == 0L) droppedAt = System.currentTimeMillis()
        if (System.currentTimeMillis() - droppedAt > GRACE_MS) { fail("通话已结束"); return }
        val wait = min(4000L, 400L shl attempts.coerceAtMost(4))
        attempts += 1
        publish(phase = "connecting")
        handler.postDelayed({ if (!hungUp) connect() }, wait)
    }

    private fun setMuted(next: Boolean) {
        muted = next
        sendJson("""{"type":"mute","on":$next}""")
        publish(muted = next)
    }

    private fun hangup() {
        if (hungUp) return
        hungUp = true
        sendJson("""{"type":"hangup"}""")
        finish("hangup")
    }

    private fun fail(detail: String) {
        publish(error = detail, phase = "ended")
        finish(detail)
    }

    private fun finish(reason: String) {
        if (!hungUp) hungUp = true
        running.set(false)
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, reason)
        socket = null
        releaseAudio()
        val bot = botId
        botId = null
        if (bot != null) repository().endLiveCall(bot, reason)
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
    }

    @Synchronized
    private fun releaseAudio() {
        running.set(false)
        canceller?.runCatching { release() }
        canceller = null
        recorder?.runCatching { stop() }
        recorder?.runCatching { release() }
        recorder = null
        player?.runCatching { pause(); flush(); stop() }
        player?.runCatching { release() }
        player = null
        audioRoute?.runCatching { close() }?.onFailure { Log.w("PiBotVoice", "Unable to release call audio route", it) }
        audioRoute = null
    }

    private fun publish(phase: String? = null, callId: String? = null, muted: Boolean? = null, error: String? = null) {
        val bot = botId ?: return
        val current = repository().liveCall.value?.takeIf { it.botId == bot }
        repository().updateLiveCall(LiveCall(
            botId = bot,
            callId = callId ?: current?.callId,
            phase = phase ?: current?.phase ?: "connecting",
            muted = muted ?: this.muted,
            startedAt = if (startedAt > 0) startedAt else current?.startedAt ?: 0L,
            error = error ?: current?.error,
            local = true,
        ))
    }

    private fun sendJson(json: String) { socket?.send(json) }

    companion object {
        const val ACTION_HANGUP = "dev.pibot.android.voice.HANGUP"
        const val ACTION_MUTE = "dev.pibot.android.voice.MUTE"
        const val EXTRA_BOT = "bot"
        const val EXTRA_MUTED = "muted"

        fun start(context: Context, botId: String) {
            val intent = Intent(context, VoiceCallService::class.java).putExtra(EXTRA_BOT, botId)
            ContextCompat.startForegroundService(context, intent)
        }

        fun hangup(context: Context) {
            context.startService(Intent(context, VoiceCallService::class.java).setAction(ACTION_HANGUP))
        }

        fun setMuted(context: Context, muted: Boolean) {
            context.startService(Intent(context, VoiceCallService::class.java).setAction(ACTION_MUTE).putExtra(EXTRA_MUTED, muted))
        }
        private const val CHANNEL = "voice"
        private const val NOTIFICATION_ID = 42
        private const val RATE = 16000
        private const val GRACE_MS = 15_000L
    }
}

private fun energy(buffer: ByteArray, length: Int): Int {
    var sum = 0.0
    var count = 0
    var index = 0
    while (index + 1 < length) {
        val sample = ((buffer[index].toInt() and 0xff) or (buffer[index + 1].toInt() shl 8)).toShort().toInt()
        sum += sample * sample
        count += 1
        index += 2
    }
    return if (count == 0) 0 else sqrt(sum / count).toInt()
}
