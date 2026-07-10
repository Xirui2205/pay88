package com.telebirr.gateway.agent.sim

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EthiopianPhoneNumberTest {
    @Test
    fun `normalizes local and international forms`() {
        assertEquals("0911223344", EthiopianPhoneNumber.normalize("0911223344"))
        assertEquals("0911223344", EthiopianPhoneNumber.normalize("+251 911 223 344"))
        assertEquals("0911223344", EthiopianPhoneNumber.normalize("911223344"))
    }

    @Test
    fun `rejects non mobile number`() {
        assertThrows(IllegalArgumentException::class.java) {
            EthiopianPhoneNumber.normalize("+251 11 123 4567")
        }
    }

    @Test
    fun `keeps canonical identity while formatting nine digit Telebirr input`() {
        assertEquals("+251992844697", EthiopianPhoneNumber.canonical("+251 992 844 697"))
        assertEquals("992844697", EthiopianPhoneNumber.toTelebirrInput("+251992844697"))
    }

    @Test
    fun `matches asymmetric provider masks without suffix guessing`() {
        assertTrue(EthiopianPhoneNumber.matchesProviderDisplay("+251992844697", "(9928****7)"))
        assertTrue(EthiopianPhoneNumber.matchesProviderDisplay("+251992844697", "2519****4697"))
        assertFalse(EthiopianPhoneNumber.matchesProviderDisplay("+251992844697", "9928****8"))
        assertFalse(EthiopianPhoneNumber.matchesProviderDisplay("+251992844697", "****44697"))
    }
}
