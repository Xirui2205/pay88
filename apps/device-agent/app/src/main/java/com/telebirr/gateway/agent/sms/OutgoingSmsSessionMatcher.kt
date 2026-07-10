package com.telebirr.gateway.agent.sms

import com.telebirr.gateway.agent.protocol.DeviceJobPayload
import com.telebirr.gateway.agent.protocol.DeviceJobType
import com.telebirr.gateway.agent.sim.EthiopianPhoneNumber
import com.telebirr.gateway.agent.ussd.DeterministicNameMatch
import com.telebirr.gateway.agent.ussd.NameNormalizer
import java.math.BigDecimal
import java.math.RoundingMode

/** Conservative, pure correlation gate for releasing the handset USSD mutex. */
object OutgoingSmsSessionMatcher {
    private const val EARLY_TOLERANCE_MS = 30_000L
    private const val MAX_PROVIDER_DELAY_MS = 30 * 60_000L

    fun stronglyMatches(
        job: DeviceJobPayload,
        committedAtMs: Long,
        receivedAtMs: Long,
        parsed: ParsedTelebirrSms.OutgoingTransfer,
    ): Boolean {
        if (job.type == DeviceJobType.BALANCE_QUERY || job.type == DeviceJobType.UNKNOWN_RECONCILIATION) {
            return false
        }
        if (receivedAtMs < committedAtMs - EARLY_TOLERANCE_MS) return false
        if (receivedAtMs > committedAtMs + MAX_PROVIDER_DELAY_MS) return false
        if (parsed.outcome == ParsedTelebirrSms.Outcome.PENDING) return false

        val expectedMinor = runCatching {
            BigDecimal(requireNotNull(job.amountEtb))
                .setScale(2, RoundingMode.UNNECESSARY)
                .movePointRight(2)
                .longValueExact()
        }.getOrNull() ?: return false
        if (parsed.amountMinor != expectedMinor) return false

        val destination = job.destinationPhone ?: return false
        if (parsed.recipientPhonePattern.isBlank() || !EthiopianPhoneNumber.matchesProviderDisplay(
                destination,
                parsed.recipientPhonePattern,
            )
        ) return false

        val authoritativeName = job.approvedProviderName ?: job.expectedReceiverName ?: return false
        return NameNormalizer.compare(authoritativeName, parsed.recipientName) ==
            DeterministicNameMatch.HIGH_CONFIDENCE
    }
}
