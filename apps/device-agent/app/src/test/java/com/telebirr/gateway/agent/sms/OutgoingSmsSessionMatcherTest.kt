package com.telebirr.gateway.agent.sms

import com.telebirr.gateway.agent.protocol.DeviceJobPayload
import com.telebirr.gateway.agent.protocol.DeviceJobType
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutgoingSmsSessionMatcherTest {
    private val committedAt = 1_000_000L

    @Test
    fun `strong supplied asymmetric confirmation matches signed job`() {
        assertTrue(
            OutgoingSmsSessionMatcher.stronglyMatches(
                job(),
                committedAt,
                committedAt + 25_000,
                confirmation(),
            ),
        )
    }

    @Test
    fun `amount phone name time and outcome must all strongly match`() {
        assertFalse(matches(confirmation().copy(amountMinor = 2_100)))
        assertFalse(matches(confirmation().copy(recipientPhonePattern = "9928****8")))
        assertFalse(matches(confirmation().copy(recipientName = "Abebe Kebede")))
        assertFalse(matches(confirmation().copy(outcome = ParsedTelebirrSms.Outcome.PENDING)))
        assertFalse(
            OutgoingSmsSessionMatcher.stronglyMatches(
                job(),
                committedAt,
                committedAt + 30 * 60_000L + 1,
                confirmation(),
            ),
        )
    }

    @Test
    fun `approved provider name is authoritative for resumed attempt`() {
        val job = job().copy(expectedReceiverName = "Abayine", approvedProviderName = "Abayine Fucha")
        assertTrue(
            OutgoingSmsSessionMatcher.stronglyMatches(
                job,
                committedAt,
                committedAt + 10_000,
                confirmation().copy(recipientName = "Fucha Abayine"),
            ),
        )
        assertFalse(
            OutgoingSmsSessionMatcher.stronglyMatches(
                job,
                committedAt,
                committedAt + 10_000,
                confirmation(),
            ),
        )
    }

    private fun matches(parsed: ParsedTelebirrSms.OutgoingTransfer) =
        OutgoingSmsSessionMatcher.stronglyMatches(job(), committedAt, committedAt + 10_000, parsed)

    private fun confirmation() = ParsedTelebirrSms.OutgoingTransfer(
        providerTransactionId = "DG87NDFU4H",
        amountMinor = 2_000,
        recipientName = "ABAYINE",
        recipientPhonePattern = "9928****7",
        recipientPhonePrefix = "9928",
        recipientPhoneSuffix = "7",
        serviceFeeMinor = 87,
        vatMinor = 13,
        resultingMainBalanceMinor = 23_217,
        outcome = ParsedTelebirrSms.Outcome.SUCCESS,
    )

    private fun job() = DeviceJobPayload(
        jobId = "job:withdrawal:0001",
        deviceId = "device:pilot:0001",
        financialOperationId = "withdrawal:0001",
        type = DeviceJobType.CUSTOMER_WITHDRAWAL,
        simIccid = "8901000000000000001",
        profileId = "telebirr.send-money.v1",
        profileVersion = 1,
        attempt = 1,
        fencingToken = 1,
        issuedAtMs = 900_000,
        leaseExpiresAtMs = 1_200_000,
        jobExpiresAtMs = 1_800_000,
        destinationPhone = "+251992844697",
        amountEtb = "20.00",
        expectedReceiverName = "Abayine",
    ).validated()
}
