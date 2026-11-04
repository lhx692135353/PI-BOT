package dev.pibot.android.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallAudioRouteTest {
    @Test
    fun callHoldsMediaFocusOnceAndReleasesItOnHangup() {
        val audio = FakeAudio()
        val route = CallAudioRoute(audio)
        route.start()
        assertTrue(audio.focused)
        // Socket reconnection must not request focus again.
        route.start()
        assertEquals(1, audio.requests)
        route.close()
        assertFalse(audio.focused)
        route.close()
        assertEquals(1, audio.abandons)
    }

    @Test
    fun deniedFocusStillStartsTheCallAndCanStartAgain() {
        val audio = FakeAudio().apply { grant = false }
        val route = CallAudioRoute(audio)
        route.start()
        assertFalse(audio.focused)
        route.close()
        audio.grant = true
        route.start()
        assertTrue(audio.focused)
        route.close()
        assertEquals(2, audio.abandons)
    }
}

private class FakeAudio : CallAudioSystem {
    var grant = true
    var focused = false
    var requests = 0
    var abandons = 0
    override fun requestFocus(): Boolean {
        requests++
        focused = grant
        return grant
    }
    override fun abandonFocus() {
        abandons++
        focused = false
    }
}
