package com.telebirr.gateway.agent.accessibility

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SensitiveScreenRedactorTest {
    @Test
    fun `pin prompt suggestion digits are removed before any local debounce state`() {
        val scrubbed = SensitiveScreenRedactor.redactPinDigits(
            "Enter PIN\n121212\n120.10\n\uff11\uff12\uff13\uff14\uff15\uff16",
        )

        assertTrue(scrubbed.contains("Enter PIN"))
        assertTrue(scrubbed.contains("[REDACTED PIN]"))
        assertFalse(Regex("[0-9\\uFF10-\\uFF19]").containsMatchIn(scrubbed))
    }
}
