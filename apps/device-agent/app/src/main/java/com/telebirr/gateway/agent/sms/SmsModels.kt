package com.telebirr.gateway.agent.sms

sealed interface ParsedTelebirrSms {
    val providerTransactionId: String?

    data class IncomingTransfer(
        override val providerTransactionId: String,
        val amountMinor: Long,
        val senderName: String,
        val senderPhonePattern: String = "",
        val senderPhonePrefix: String = "",
        val senderPhoneSuffix: String,
        val resultingMainBalanceMinor: Long?,
    ) : ParsedTelebirrSms

    data class OutgoingTransfer(
        override val providerTransactionId: String,
        val amountMinor: Long,
        val recipientName: String,
        val recipientPhonePattern: String = "",
        val recipientPhonePrefix: String = "",
        val recipientPhoneSuffix: String,
        val serviceFeeMinor: Long?,
        val vatMinor: Long?,
        val resultingMainBalanceMinor: Long?,
        val outcome: Outcome,
    ) : ParsedTelebirrSms

    data class BalanceResult(
        override val providerTransactionId: String? = null,
        val customerEMoneyMinor: Long?,
        val incentiveMinor: Long?,
        val fuelPaymentMinor: Long?,
        val pocketMoneyMinor: Long?,
    ) : ParsedTelebirrSms

    enum class Outcome { SUCCESS, FAILED, PENDING }
}

data class AttributedSms(
    val sender: String,
    val receivedAtMs: Long,
    val subscriptionId: Int,
    val slotIndex: Int,
    val iccid: String,
    val rawMessage: String,
    val parsed: ParsedTelebirrSms?,
)
