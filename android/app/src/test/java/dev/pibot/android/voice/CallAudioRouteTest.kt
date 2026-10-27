package dev.pibot.android.voice

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CallAudioRouteTest {
    @Test
    fun modernCallSelectsSpeakerBeforePlaybackAndClearsItsRequestOnHangup() {
        val audio = FakeAudio(modern = true)
        val route = CallAudioRoute(audio)
        route.start()
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, audio.modeAtSelection)
        assertTrue(audio.speakerSelected)
        assertEquals(0, audio.legacyWrites)
        // Socket reconnection must not overwrite the saved pre-call mode.
        route.start()
        assertEquals(1, audio.selections)
        route.close()
        assertFalse(audio.speakerSelected)
        assertEquals(AudioManager.MODE_NORMAL, audio.mode)
        route.close()
        assertEquals(1, audio.clears)
    }

    @Test
    fun legacyCallUsesSpeakerphoneAndRestoresBothOriginalSettings() {
        val audio = FakeAudio(modern = false, initialMode = AudioManager.MODE_RINGTONE)
        val route = CallAudioRoute(audio)
        route.start()
        assertTrue(audio.speakerphoneOn)
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, audio.mode)
        route.close()
        assertFalse(audio.speakerphoneOn)
        assertEquals(AudioManager.MODE_RINGTONE, audio.mode)
        assertEquals(0, audio.selections)
        assertEquals(0, audio.clears)
    }

    @Test
    fun legacyCallDoesNotDisableAnAlreadyEnabledSpeakerphone() {
        val audio = FakeAudio(modern = false, initialSpeakerphone = true)
        val route = CallAudioRoute(audio)
        route.start()
        route.start()
        route.close()
        assertTrue(audio.speakerphoneOn)
        assertEquals(AudioManager.MODE_NORMAL, audio.mode)
    }

    @Test
    fun rejectedRouteRollsBackAndCanStartANewCall() {
        val audio = FakeAudio(modern = true).apply { acceptSpeaker = false }
        val route = CallAudioRoute(audio)
        assertThrows(IllegalStateException::class.java) { route.start() }
        assertEquals(AudioManager.MODE_NORMAL, audio.mode)
        assertFalse(audio.speakerSelected)
        audio.acceptSpeaker = true
        route.start()
        assertTrue(audio.speakerSelected)
        route.close()
        assertEquals(AudioManager.MODE_NORMAL, audio.mode)
    }

    @Test
    fun cleanupDoesNotOverwriteAnotherCallsModeAndSurvivesDeviceDisappearance() {
        val audio = FakeAudio(modern = true)
        val route = CallAudioRoute(audio)
        route.start()
        audio.mode = AudioManager.MODE_IN_CALL
        route.close()
        assertEquals(AudioManager.MODE_IN_CALL, audio.mode)
        assertFalse(audio.speakerSelected)

        audio.mode = AudioManager.MODE_NORMAL
        route.start()
        audio.failClear = true
        assertThrows(IllegalStateException::class.java) { route.close() }
        assertEquals(AudioManager.MODE_NORMAL, audio.mode)
        route.close() // Service destruction after failure must be safe.
    }
}

private class FakeAudio(
    modern: Boolean,
    initialMode: Int = AudioManager.MODE_NORMAL,
    initialSpeakerphone: Boolean = false,
) : CallAudioSystem {
    override var mode = initialMode
    override val usesCommunicationDevice = modern
    var legacyWrites = 0
    override var speakerphoneOn = initialSpeakerphone
        set(value) { legacyWrites++; field = value }
    var acceptSpeaker = true
    var speakerSelected = false
    var modeAtSelection: Int? = null
    var selections = 0
    var clears = 0
    var failClear = false
    override fun selectBuiltInSpeaker(): Boolean {
        selections++
        modeAtSelection = mode
        speakerSelected = acceptSpeaker
        return acceptSpeaker
    }
    override fun clearCommunicationDevice() {
        clears++
        if (failClear) error("device disconnected")
        speakerSelected = false
    }
}
