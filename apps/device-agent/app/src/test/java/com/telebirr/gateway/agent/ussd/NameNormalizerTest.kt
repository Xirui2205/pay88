package com.telebirr.gateway.agent.ussd

import org.junit.Assert.assertEquals
import org.junit.Test

class NameNormalizerTest {
    @Test
    fun `accepts word order and configured transliteration variants`() {
        assertEquals(
            DeterministicNameMatch.HIGH_CONFIDENCE,
            NameNormalizer.compare("Ahmed Mohammed", "MUHAMMAD AHMAD"),
        )
    }

    @Test
    fun `partial names are uncertain and unrelated names mismatch`() {
        assertEquals(
            DeterministicNameMatch.UNCERTAIN,
            NameNormalizer.compare("Abebe Kebede", "Abebe Tadesse"),
        )
        assertEquals(
            DeterministicNameMatch.MISMATCH,
            NameNormalizer.compare("Abebe Kebede", "Hana Tadesse"),
        )
    }
}
