package com.telebirr.gateway.agent.sms

import com.telebirr.gateway.agent.ussd.NameNormalizer
import com.telebirr.gateway.agent.sim.EthiopianPhoneNumber
import java.math.BigDecimal
import java.math.RoundingMode
import java.text.Normalizer

/** Strict parser: incomplete financial messages remain encrypted evidence, never money events. */
class TelebirrSmsParser {
    private val money = "([0-9]{1,3}(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?|[0-9]+(?:\\.[0-9]{1,2})?)(?![0-9,]|\\.[0-9])"
    private val transactionIdPatterns = listOf(
        Regex("(?iu)(?:TRANSACTION|TXN|REFERENCE)(?:\\s+(?:ID|NO|NUMBER))?\\s*(?:IS|[:#=-])\\s*([A-Z0-9][A-Z0-9_-]{4,63})"),
        Regex("(?iu)የግብይት\\s+መለያ\\s*[:#=-]\\s*([A-Z0-9][A-Z0-9_-]{4,63})"),
    )

    fun parse(raw: String): ParsedTelebirrSms? {
        val normalized = normalize(raw)
        parseBalance(normalized)?.let { return it }
        val transactionId = transactionIdPatterns.firstNotNullOfOrNull { regex ->
            regex.find(normalized)?.groupValues?.get(1)?.uppercase()
        } ?: return null
        parseIncoming(normalized, transactionId)?.let { return it }
        return parseOutgoing(normalized, transactionId)
    }

    private fun parseIncoming(text: String, transactionId: String): ParsedTelebirrSms.IncomingTransfer? {
        if (!Regex("(?iu)\\b(RECEIVED|CREDITED)\\b").containsMatchIn(text)) return null
        val amount = firstAmountAfter(text, listOf("RECEIVED", "CREDITED")) ?: return null
        val sender = Regex(
            "(?isu)\\bFROM\\s+(.+?)\\s*\\(([^)]+)\\)(?:\\s+[0-9]+)?(?=\\s+ON\\b|\\s*[.;]?\\s*(?:TRANSACTION|TXN|REFERENCE)\\b)",
        ).find(text) ?: return null
        val phone = phoneFrom(sender.groupValues[2]) ?: return null
        val name = cleanPartyName(sender.groupValues[1])
        if (name.isBlank()) return null
        return ParsedTelebirrSms.IncomingTransfer(
            providerTransactionId = transactionId,
            amountMinor = amount,
            senderName = name,
            senderPhonePattern = phone,
            senderPhonePrefix = EthiopianPhoneNumber.visiblePrefix(phone),
            senderPhoneSuffix = EthiopianPhoneNumber.visibleSuffix(phone),
            resultingMainBalanceMinor = labeledAmount(
                text,
                listOf("CURRENT E-MONEY ACCOUNT BALANCE", "CURRENT E MONEY ACCOUNT BALANCE", "CURRENT BALANCE", "NEW BALANCE"),
            ),
        )
    }

    private fun parseOutgoing(text: String, transactionId: String): ParsedTelebirrSms.OutgoingTransfer? {
        if (!Regex("(?iu)\\b(SENT|TRANSFERRED|PAID)\\b").containsMatchIn(text)) return null
        val amount = firstAmountAfter(text, listOf("SENT", "TRANSFERRED", "PAID")) ?: return null
        val recipient = Regex(
            "(?isu)\\bTO\\s+(.+?)\\s*\\(([^)]+)\\)(?=\\s+ON\\b|\\s*[.;]?\\s*(?:TRANSACTION|TXN|REFERENCE)\\b)",
        ).find(text) ?: return null
        val phone = phoneFrom(recipient.groupValues[2]) ?: return null
        val name = cleanPartyName(recipient.groupValues[1])
        if (name.isBlank()) return null
        val serviceFee = labeledAmount(text, listOf("SERVICE FEE", "SERVICE CHARGE", "FEE"))
        val vat = labeledAmount(text, listOf("VAT ON THE SERVICE FEE", "VAT", "VALUE ADDED TAX"))
        val outcome = when {
            Regex("(?iu)\\b(FAILED|DECLINED|REVERSED)\\b").containsMatchIn(text) ->
                ParsedTelebirrSms.Outcome.FAILED
            Regex("(?iu)\\b(PENDING|PROCESSING)\\b").containsMatchIn(text) ->
                ParsedTelebirrSms.Outcome.PENDING
            else -> ParsedTelebirrSms.Outcome.SUCCESS
        }
        return ParsedTelebirrSms.OutgoingTransfer(
            providerTransactionId = transactionId,
            amountMinor = amount,
            recipientName = name,
            recipientPhonePattern = phone,
            recipientPhonePrefix = EthiopianPhoneNumber.visiblePrefix(phone),
            recipientPhoneSuffix = EthiopianPhoneNumber.visibleSuffix(phone),
            serviceFeeMinor = serviceFee,
            vatMinor = vat,
            resultingMainBalanceMinor = labeledAmount(
                text,
                listOf("CURRENT E-MONEY ACCOUNT BALANCE", "CURRENT E MONEY ACCOUNT BALANCE", "CURRENT BALANCE", "NEW BALANCE"),
            ),
            outcome = outcome,
        )
    }

    private fun parseBalance(text: String): ParsedTelebirrSms.BalanceResult? {
        val customer = labeledAmount(text, listOf("CUSTOMER E-MONEY ACCOUNT", "CUSTOMER E MONEY ACCOUNT"))
        val incentive = labeledAmount(text, listOf("INCENTIVE ACCOUNT"))
        val fuel = labeledAmount(
            text,
            listOf("CUSTOMER E-MONEY ACCOUNT FOR FUEL PAYMENT", "CUSTOMER E MONEY ACCOUNT FOR FUEL PAYMENT", "FUEL-PAYMENT ACCOUNT", "FUEL PAYMENT ACCOUNT"),
        )
        val pocket = labeledAmount(text, listOf("POCKETMONEYACCOUNT", "POCKETMONEY ACCOUNT", "POCKET MONEY ACCOUNT"))
        if (listOf(customer, incentive, fuel, pocket).all { it == null }) return null
        return ParsedTelebirrSms.BalanceResult(
            customerEMoneyMinor = customer,
            incentiveMinor = incentive,
            fuelPaymentMinor = fuel,
            pocketMoneyMinor = pocket,
        )
    }

    private fun firstAmountAfter(text: String, verbs: List<String>): Long? {
        for (verb in verbs) {
            val patterns = listOf(
                Regex("(?iu)\\b$verb\\b\\s*(?:ETB|BIRR)?\\s*$money\\s*(?:ETB|BIRR)?"),
                Regex("(?iu)\\b$verb\\b\\s+(?:AN?\\s+)?(?:AMOUNT\\s+OF\\s+)?(?:ETB|BIRR)\\s*$money"),
            )
            patterns.forEach { regex ->
                regex.find(text)?.groupValues?.get(1)?.let { return toMinor(it) }
            }
        }
        return null
    }

    private fun labeledAmount(text: String, labels: List<String>): Long? {
        labels.forEach { label ->
            val regexes = listOf(
                Regex("(?iu)${Regex.escape(label)}(?:\\s+BALANCE)?\\s*(?:IS)?\\s*[:=-]?\\s*(?:ETB|BIRR)?\\s*$money\\s*(?:ETB|BIRR)?"),
                Regex("(?iu)${Regex.escape(label)}(?:\\s+BALANCE)?\\s*(?:IS)?\\s*[:=-]?\\s*$money\\s*(?:ETB|BIRR)"),
            )
            regexes.forEach { regex ->
                regex.find(text)?.groupValues?.get(1)?.let { return toMinor(it) }
            }
        }
        return null
    }

    private fun toMinor(value: String): Long? = runCatching {
        val decimal = BigDecimal(value.replace(",", ""))
        require(decimal.signum() >= 0 && decimal.scale() <= 2)
        decimal.setScale(2, RoundingMode.UNNECESSARY).movePointRight(2).longValueExact()
    }.getOrNull()

    private fun phoneFrom(value: String): String? = EthiopianPhoneNumber.providerPattern(value)

    private fun cleanPartyName(block: String): String {
        val withoutPhone = block
            .replace(Regex("[+0-9*() -]{4,}"), " ")
            .replace(Regex("(?iu)\\b(NAME|MOBILE|PHONE)\\b\\s*[:=-]?"), " ")
            .trim(' ', '-', '(', ')', ',', '.')
        return NameNormalizer.normalize(withoutPhone).joinToString(" ")
    }

    private fun normalize(raw: String): String = normalizeDigits(
        Normalizer.normalize(raw, Normalizer.Form.NFKC),
    )
        .replace('\u00a0', ' ')
        .replace("\r\n", "\n")
        .replace('\r', '\n')
        .replace(Regex("[\\t ]+"), " ")
        .replace(Regex(" *\\n *"), "\n")
        .trim()

    private fun normalizeDigits(value: String): String = buildString(value.length) {
        value.forEach { char ->
            append(
                when (char) {
                    in '٠'..'٩' -> '0' + (char - '٠')
                    in '۰'..'۹' -> '0' + (char - '۰')
                    in '０'..'９' -> '0' + (char - '０')
                    else -> char
                },
            )
        }
    }
}
