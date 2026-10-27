package dev.pibot.android.voice

import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

/** The call owns its route until audio is released, including while the socket reconnects. */
internal class CallAudioRoute(private val audio: CallAudioSystem) : AutoCloseable {
    private data class Previous(val mode: Int, val speakerphone: Boolean?)
    private var previous: Previous? = null

    @Synchronized
    fun start() {
        if (previous != null) return
        previous = Previous(audio.mode, if (audio.usesCommunicationDevice) null else audio.speakerphoneOn)
        try {
            audio.mode = AudioManager.MODE_IN_COMMUNICATION
            if (audio.usesCommunicationDevice) {
                check(audio.selectBuiltInSpeaker()) { "无法切换到扬声器" }
            } else {
                audio.speakerphoneOn = true
            }
        } catch (error: Exception) {
            runCatching { close() }
            throw error
        }
    }

    @Synchronized
    override fun close() {
        val saved = previous ?: return
        previous = null
        try {
            if (audio.usesCommunicationDevice) audio.clearCommunicationDevice()
            else audio.speakerphoneOn = saved.speakerphone ?: false
        } finally {
            // Another call may have taken over the device's mode in the meantime.
            if (audio.mode == AudioManager.MODE_IN_COMMUNICATION) audio.mode = saved.mode
        }
    }
}

internal interface CallAudioSystem {
    var mode: Int
    val usesCommunicationDevice: Boolean
    var speakerphoneOn: Boolean
    fun selectBuiltInSpeaker(): Boolean
    fun clearCommunicationDevice()
}

@Suppress("DEPRECATION")
internal class AndroidCallAudioSystem(private val manager: AudioManager) : CallAudioSystem {
    override var mode: Int
        get() = manager.mode
        set(value) { manager.mode = value }
    override val usesCommunicationDevice get() = Build.VERSION.SDK_INT >= 31
    override var speakerphoneOn: Boolean
        get() = manager.isSpeakerphoneOn
        set(value) { manager.isSpeakerphoneOn = value }

    override fun selectBuiltInSpeaker(): Boolean {
        if (Build.VERSION.SDK_INT < 31) return false
        val speaker = manager.availableCommunicationDevices.firstOrNull {
            it.isSink && it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        } ?: return false
        return manager.setCommunicationDevice(speaker)
    }

    override fun clearCommunicationDevice() {
        if (Build.VERSION.SDK_INT >= 31) manager.clearCommunicationDevice()
    }
}
