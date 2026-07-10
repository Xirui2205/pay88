package com.telebirr.gateway.agent.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class SmsEvidenceOutboxIdentityTest {
    @Test
    fun `duplicate provider transaction has one durable outbox identity`() {
        val parsed = ParsedTelebirrSms.OutgoingTransfer(
            providerTransactionId = "DG80NDBZ9Y",
            amountMinor = 2_000,
            recipientName = "ABAYINE FUCHA",
            recipientPhoneSuffix = "4697",
            serviceFeeMinor = 87,
            vatMinor = 13,
            resultingMainBalanceMinor = 25_317,
            outcome = ParsedTelebirrSms.Outcome.SUCCESS,
        )
        val first = AttributedSms("127", 1_000, 1, 0, "8901000000000000001", "first delivery", parsed)
        val duplicate = first.copy(receivedAtMs = 9_000, rawMessage = "multipart duplicate delivery")

        val firstDigest = SmsEvidenceOutboxIdentity.digest(first)
        val duplicateDigest = SmsEvidenceOutboxIdentity.digest(duplicate)
        assertEquals(firstDigest, duplicateDigest)
        assertEquals(
            SmsEvidenceOutboxIdentity.eventId(firstDigest),
            SmsEvidenceOutboxIdentity.eventId(duplicateDigest),
        )
        assertTrue(runCatching { UUID.fromString(SmsEvidenceOutboxIdentity.eventId(firstDigest)) }.isSuccess)
    }

    @Test
    fun `separate balance responses keep separate evidence identities`() {
        val parsed = ParsedTelebirrSms.BalanceResult(
            customerEMoneyMinor = 84_435,
            incentiveMinor = 1_000,
            fuelPaymentMinor = 0,
            pocketMoneyMinor = 0,
        )
        val first = AttributedSms("127", 1_000, 1, 0, "8901000000000000001", "same balance body", parsed)
        val laterQueryResponse = first.copy(receivedAtMs = 61_000)

        assertNotEquals(
            SmsEvidenceOutboxIdentity.digest(first),
            SmsEvidenceOutboxIdentity.digest(laterQueryResponse),
        )
    }
}
