package dev.pibot.android.ui

import org.junit.Assert.*
import org.junit.Test

class PhonePresentationTest {
    @Test fun expiredPreviewDoesNotAskForTakeover() {
        val help = phonePreviewHelp("人工控制会话已失效")
        assertTrue(help.contains("版本"))
        assertTrue(help.contains("无需先接管"))
    }
    @Test fun unknownMethodHasUpgradeGuidance() {
        assertTrue(phonePreviewHelp("Unknown method phone.preview").contains("管理员"))
    }
    @Test fun offlineAndTimeoutOfferRecovery() {
        assertTrue(phonePreviewHelp("device offline").contains("正在运行"))
        assertTrue(phonePreviewHelp("request timeout").contains("超时"))
    }
    @Test fun authorizationDoesNotSuggestReinstall() {
        assertTrue(phonePreviewHelp("403 unauthorized").contains("授权"))
        assertFalse(phonePreviewHelp("403 unauthorized").contains("重装"))
    }
    @Test fun rawErrorsAreNeverDisplayed() {
        val raw = "https://private.example/?token=secret device-id=private-id"
        assertFalse(phonePreviewHelp(raw).contains(raw))
        assertFalse(phonePreviewHelp(raw).contains("secret"))
    }
    @Test fun availabilityExplainsEveryDisabledState() {
        assertTrue(phoneAvailabilityHint(false, false, false, false).contains("选择"))
        assertTrue(phoneAvailabilityHint(true, false, false, false).contains("离线"))
        assertTrue(phoneAvailabilityHint(true, true, false, false).contains("管理员"))
        assertTrue(phoneAvailabilityHint(true, true, true, true).contains("对方"))
        assertTrue(phoneAvailabilityHint(true, true, true, false).contains("先接管"))
    }
}
