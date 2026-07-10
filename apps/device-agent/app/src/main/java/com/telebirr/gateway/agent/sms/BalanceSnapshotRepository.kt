package com.telebirr.gateway.agent.sms

import com.telebirr.gateway.agent.db.AgentDao
import com.telebirr.gateway.agent.db.BalanceSnapshotEntity
import java.time.Clock

/** Missing account fields preserve the prior value; a missing response never writes zero. */
class BalanceSnapshotRepository(
    private val dao: AgentDao,
    private val clock: Clock = Clock.systemUTC(),
) {
    suspend fun apply(
        simIccidHash: String,
        sourceMessageDigest: String,
        result: ParsedTelebirrSms.BalanceResult,
    ): BalanceSnapshotEntity {
        val previous = dao.balance(simIccidHash)
        val snapshot = BalanceSnapshotEntity(
            simIccidHash = simIccidHash,
            customerMinor = result.customerEMoneyMinor ?: previous?.customerMinor,
            incentiveMinor = result.incentiveMinor ?: previous?.incentiveMinor,
            fuelMinor = result.fuelPaymentMinor ?: previous?.fuelMinor,
            pocketMoneyMinor = result.pocketMoneyMinor ?: previous?.pocketMoneyMinor,
            capturedAtMs = clock.millis(),
            sourceMessageDigest = sourceMessageDigest,
            sourceKind = "BALANCE_QUERY_SMS",
        )
        dao.upsertBalance(snapshot)
        return snapshot
    }

    suspend fun applyTransaction(
        simIccidHash: String,
        sourceMessageDigest: String,
        result: ParsedTelebirrSms,
    ): BalanceSnapshotEntity? {
        val previous = dao.balance(simIccidHash)
        val reported = when (result) {
            is ParsedTelebirrSms.IncomingTransfer -> result.resultingMainBalanceMinor
            is ParsedTelebirrSms.OutgoingTransfer -> result.resultingMainBalanceMinor
            is ParsedTelebirrSms.BalanceResult -> null
        }
        val predicted = reported ?: previous?.customerMinor?.let { prior ->
            when (result) {
                is ParsedTelebirrSms.IncomingTransfer -> prior + result.amountMinor
                is ParsedTelebirrSms.OutgoingTransfer -> when (result.outcome) {
                    ParsedTelebirrSms.Outcome.SUCCESS -> if (
                        result.serviceFeeMinor != null && result.vatMinor != null
                    ) {
                        prior - result.amountMinor - result.serviceFeeMinor - result.vatMinor
                    } else {
                        prior
                    }
                    ParsedTelebirrSms.Outcome.FAILED,
                    ParsedTelebirrSms.Outcome.PENDING,
                    -> prior
                }
                is ParsedTelebirrSms.BalanceResult -> prior
            }
        } ?: return null
        val snapshot = BalanceSnapshotEntity(
            simIccidHash = simIccidHash,
            customerMinor = predicted,
            incentiveMinor = previous?.incentiveMinor,
            fuelMinor = previous?.fuelMinor,
            pocketMoneyMinor = previous?.pocketMoneyMinor,
            capturedAtMs = clock.millis(),
            sourceMessageDigest = sourceMessageDigest,
            sourceKind = "TRANSACTION_SMS",
        )
        dao.upsertBalance(snapshot)
        return snapshot
    }
}
