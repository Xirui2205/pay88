package com.telebirr.gateway.agent.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import com.telebirr.gateway.agent.AgentApplication
import com.telebirr.gateway.agent.crypto.CryptoEncoding
import com.telebirr.gateway.agent.sim.SubscriptionAttribution
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class TelebirrSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isEmpty()) return
        val sender = messages.first().originatingAddress.orEmpty().filter(Char::isDigit)
        if (sender != "127" || messages.any { it.originatingAddress.orEmpty().filter(Char::isDigit) != sender }) return
        val raw = messages.joinToString(separator = "") { it.messageBody.orEmpty() }
        if (raw.isBlank()) return
        // Lease correlation uses OS receipt time, never the sender-controlled SMS timestamp.
        val receivedAt = System.currentTimeMillis()
        val pendingResult = goAsync()
        val app = context.applicationContext as AgentApplication
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                when (val attribution = app.container.subscriptionResolver.resolve(intent)) {
                    is SubscriptionAttribution.Resolved -> process(
                        app,
                        sender,
                        raw,
                        receivedAt,
                        attribution.subscription.subscriptionId,
                        attribution.subscription.slotIndex,
                        attribution.subscription.iccid,
                    )
                    is SubscriptionAttribution.Quarantined -> enqueueAttributionFailure(
                        app,
                        raw,
                        receivedAt,
                        attribution.reason,
                    )
                    is SubscriptionAttribution.Uncertain -> enqueueAttributionFailure(
                        app,
                        raw,
                        receivedAt,
                        attribution.reason,
                    )
                }
            } finally {
                pendingResult.finish()
            }
        }
    }

    private suspend fun process(
        app: AgentApplication,
        sender: String,
        raw: String,
        receivedAt: Long,
        subscriptionId: Int,
        slotIndex: Int,
        iccid: String,
    ) {
        val parsed = app.container.smsParser.parse(raw)
        val attributed = AttributedSms(sender, receivedAt, subscriptionId, slotIndex, iccid, raw, parsed)
        val iccidHash = CryptoEncoding.sha256Hex(iccid)
        val evidence = app.container.smsEvidence.persistWithOutbox(attributed) { digest ->
            buildJsonObject {
                put("message_digest", digest)
                put("sender", sender)
                put("received_at_ms", receivedAt)
                put("subscription_id", subscriptionId)
                put("slot_index", slotIndex)
                put("sim_iccid_hash", iccidHash)
                put("parsed_type", parsed?.javaClass?.simpleName ?: "UNPARSED")
                put("provider_transaction_id", parsed?.providerTransactionId)
                put("parsed", parsedJson(parsed))
                put("raw_message", raw)
            }.toString().toByteArray()
        }
        if (!evidence.inserted) return
        if (parsed is ParsedTelebirrSms.IncomingTransfer || parsed is ParsedTelebirrSms.OutgoingTransfer) {
            app.container.balanceSnapshots.applyTransaction(iccidHash, evidence.digest, parsed)
        }
        if (parsed is ParsedTelebirrSms.BalanceResult) {
            val correlated = app.container.balanceLeases.correlate(iccidHash, receivedAt, evidence.digest)
            if (correlated) {
                app.container.balanceSnapshots.apply(iccidHash, evidence.digest, parsed)
                app.container.sessionsOrNull()?.completeBalanceFromSms(iccidHash, true, null)
            }
        } else if (parsed is ParsedTelebirrSms.OutgoingTransfer) {
            if (parsed.outcome != ParsedTelebirrSms.Outcome.PENDING) {
                app.container.sessionsOrNull()?.completeFromOutgoingSms(
                    iccidHash,
                    parsed,
                    receivedAt,
                )
            }
        }
    }

    private suspend fun enqueueAttributionFailure(
        app: AgentApplication,
        raw: String,
        receivedAt: Long,
        reason: String,
    ) {
        val payload = buildJsonObject {
            put("received_at_ms", receivedAt)
            put("reason", reason)
            put("raw_message", raw)
        }.toString().toByteArray()
        app.container.spool.enqueue("SMS_ATTRIBUTION_FAILURE", payload)
    }

    private fun parsedJson(parsed: ParsedTelebirrSms?) = buildJsonObject {
        when (parsed) {
            is ParsedTelebirrSms.IncomingTransfer -> {
                put("kind", "incoming_transfer")
                put("amount_minor", parsed.amountMinor)
                put("sender_name", parsed.senderName)
                put("sender_phone_pattern", parsed.senderPhonePattern)
                put("sender_phone_prefix", parsed.senderPhonePrefix)
                put("sender_phone_suffix", parsed.senderPhoneSuffix)
                put("resulting_main_balance_minor", parsed.resultingMainBalanceMinor)
            }
            is ParsedTelebirrSms.OutgoingTransfer -> {
                put("kind", "outgoing_transfer")
                put("amount_minor", parsed.amountMinor)
                put("recipient_name", parsed.recipientName)
                put("recipient_phone_pattern", parsed.recipientPhonePattern)
                put("recipient_phone_prefix", parsed.recipientPhonePrefix)
                put("recipient_phone_suffix", parsed.recipientPhoneSuffix)
                put("service_fee_minor", parsed.serviceFeeMinor)
                put("vat_minor", parsed.vatMinor)
                put("resulting_main_balance_minor", parsed.resultingMainBalanceMinor)
                put("outcome", parsed.outcome.name)
            }
            is ParsedTelebirrSms.BalanceResult -> {
                put("kind", "balance_result")
                put("customer_e_money_minor", parsed.customerEMoneyMinor)
                put("incentive_minor", parsed.incentiveMinor)
                put("fuel_payment_minor", parsed.fuelPaymentMinor)
                put("pocket_money_minor", parsed.pocketMoneyMinor)
            }
            null -> put("kind", "unparsed")
        }
    }
}
