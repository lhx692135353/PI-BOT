package dev.pibot.android.ui

import org.junit.Assert.*
import org.junit.Test

class PhonePresentationTest {
    @Test fun typedErrorsDoNotDependOnWording() {
        fun error(code:String) = dev.pibot.android.data.ApiException(400,"arbitrary wording",code)
        assertTrue(phonePreviewHelp(error("unsupported")).contains("检查"))
        assertTrue(phonePreviewHelp(error("unavailable")).contains("离线"))
        assertTrue(phonePreviewHelp(error("timeout")).contains("超时"))
        assertTrue(phonePreviewHelp(error("forbidden")).contains("授权"))
        assertFalse(phonePreviewHelp(Exception("token=secret")).contains("secret"))
        assertEquals(phonePreviewHelp(Exception("会话已失效")),phonePreviewHelp(Exception("random")))
    }
    @Test fun availabilityExplainsEveryDisabledState() {
        assertTrue(phoneAvailabilityHint(false, false, false, false).contains("选择"))
        assertTrue(phoneAvailabilityHint(true, false, false, false).contains("离线"))
        assertTrue(phoneAvailabilityHint(true, true, false, false).contains("管理员"))
        assertTrue(phoneAvailabilityHint(true, true, true, true).contains("对方"))
        assertTrue(phoneAvailabilityHint(true, true, true, false).contains("先接管"))
    }
}
