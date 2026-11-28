package dev.pibot.android

import dev.pibot.android.ui.ARMOR_MODELS
import dev.pibot.android.ui.armorIndexFor
import dev.pibot.android.ui.fnv1a32
import org.junit.Assert.assertEquals
import org.junit.Test

class SkinHashTest {
    @Test
    fun fnv1aMatchesDesktopAndCoversAll12Armors() {
        assertEquals(0x811c9dc5L, fnv1a32(""))
        assertEquals(0x4f9f2cabL, fnv1a32("hello"))
        assertEquals(3, armorIndexFor("hello"))
        assertEquals(12, ARMOR_MODELS.size)

        val seen = (0 until 200).map { armorIndexFor("bot-$it") }.toSet()
        assertEquals(12, seen.size)
    }
}
