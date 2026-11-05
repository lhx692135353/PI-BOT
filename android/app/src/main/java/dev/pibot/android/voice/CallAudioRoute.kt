package dev.pibot.android.voice

import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager

/** Bot speech is media playback: the loudspeaker or connected speakers, never the earpiece call route. */
internal val CALL_PLAYBACK_ATTRIBUTES: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

/** The call owns media focus until audio is released, including while the socket reconnects. */
internal class CallAudioRoute(private val audio: CallAudioSystem) : AutoCloseable {
    private var started = false

    @Synchronized
    fun start() {
        if (started) return
        // Denied focus is not fatal: the call still plays, other apps just keep their audio.
        audio.requestFocus()
        started = true
    }

    @Synchronized
    override fun close() {
        if (!started) return
        started = false
        audio.abandonFocus()
    }
}

internal interface CallAudioSystem {
    fun requestFocus(): Boolean
    fun abandonFocus()
}

internal class AndroidCallAudioSystem(private val manager: AudioManager) : CallAudioSystem {
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(CALL_PLAYBACK_ATTRIBUTES)
        .setOnAudioFocusChangeListener { }
        .build()

    override fun requestFocus() = manager.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED

    override fun abandonFocus() { manager.abandonAudioFocusRequest(focus) }
}
