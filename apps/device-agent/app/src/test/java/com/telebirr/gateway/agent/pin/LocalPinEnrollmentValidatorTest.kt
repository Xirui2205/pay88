package com.telebirr.gateway.agent.pin

import org.junit.Assert.assertEquals
import org.junit.Test

class LocalPinEnrollmentValidatorTest {
    @Test
    fun `requires ICCID`() {
        assertValidation(
            LocalPinEnrollmentValidation.REQUIRED_FIELD_MISSING,
            iccid = "   ",
            pin = "123456",
            confirmation = "123456",
        )
    }

    @Test
    fun `requires PIN`() {
        assertValidation(
            LocalPinEnrollmentValidation.REQUIRED_FIELD_MISSING,
            pin = "",
            confirmation = "123456",
        )
    }

    @Test
    fun `treats whitespace-only PIN as blank`() {
        assertValidation(
            LocalPinEnrollmentValidation.REQUIRED_FIELD_MISSING,
            pin = "  ",
            confirmation = "  ",
        )
    }

    @Test
    fun `requires PIN confirmation`() {
        assertValidation(
            LocalPinEnrollmentValidation.REQUIRED_FIELD_MISSING,
            pin = "123456",
            confirmation = "",
        )
    }

    @Test
    fun `rejects different PIN confirmation`() {
        assertValidation(
            LocalPinEnrollmentValidation.PIN_MISMATCH,
            pin = "123456",
            confirmation = "123457",
        )
    }

    @Test
    fun `accepts an exact PIN confirmation`() {
        assertValidation(
            LocalPinEnrollmentValidation.VALID,
            pin = "123456",
            confirmation = "123456",
        )
    }

    private fun assertValidation(
        expected: LocalPinEnrollmentValidation,
        iccid: String = "8992511234567890123",
        pin: String,
        confirmation: String,
    ) {
        val pinChars = pin.toCharArray()
        val confirmationChars = confirmation.toCharArray()
        try {
            assertEquals(
                expected,
                LocalPinEnrollmentValidator.validate(iccid, pinChars, confirmationChars),
            )
        } finally {
            pinChars.fill('\u0000')
            confirmationChars.fill('\u0000')
        }
    }
}
