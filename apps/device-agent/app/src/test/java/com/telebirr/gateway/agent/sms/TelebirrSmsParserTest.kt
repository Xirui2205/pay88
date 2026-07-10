package com.telebirr.gateway.agent.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TelebirrSmsParserTest {
    private val parser = TelebirrSmsParser()

    @Test
    fun `parses incoming receipt with amount sender suffix and balance`() {
        val parsed = parser.parse(
            "You have received ETB 1,250.50 from John Doe (0912341234). " +
                "Transaction ID: ABCD12345. Current balance: ETB 2,000.00",
        ) as ParsedTelebirrSms.IncomingTransfer

        assertEquals("ABCD12345", parsed.providerTransactionId)
        assertEquals(125_050L, parsed.amountMinor)
        assertEquals("JOHN DOE", parsed.senderName)
        assertEquals("1234", parsed.senderPhoneSuffix)
        assertEquals(200_000L, parsed.resultingMainBalanceMinor)
    }

    @Test
    fun `parses observed incoming Telebirr message`() {
        val parsed = parser.parse(
            "Dear wang\nYou have received ETB 50.00 from Ji Da(2519****8988) 100305 on " +
                "08/07/2026 14:30:35. Your transaction number is DG87NGWM1D. " +
                "Your current E-Money Account balance is ETB 47,697.08.",
        ) as ParsedTelebirrSms.IncomingTransfer

        assertEquals("DG87NGWM1D", parsed.providerTransactionId)
        assertEquals(5_000L, parsed.amountMinor)
        assertEquals("JI DA", parsed.senderName)
        assertEquals("8988", parsed.senderPhoneSuffix)
        assertEquals(4_769_708L, parsed.resultingMainBalanceMinor)
    }

    @Test
    fun `parses outgoing principal service fee and vat independently`() {
        val parsed = parser.parse(
            "You transferred ETB 100.00 to Jane Smith (0911223344). " +
                "Transaction No: TX987654. Service fee: ETB 2.00. VAT: ETB 0.30. " +
                "New balance: ETB 897.70. Successful",
        ) as ParsedTelebirrSms.OutgoingTransfer

        assertEquals(10_000L, parsed.amountMinor)
        assertEquals(200L, parsed.serviceFeeMinor)
        assertEquals(30L, parsed.vatMinor)
        assertEquals(89_770L, parsed.resultingMainBalanceMinor)
        assertEquals("3344", parsed.recipientPhoneSuffix)
        assertEquals(ParsedTelebirrSms.Outcome.SUCCESS, parsed.outcome)
    }

    @Test
    fun `parses observed outgoing Telebirr confirmation`() {
        val parsed = parser.parse(
            "Dear Bekalu\nYou have transferred ETB 20.00 to Abayine Fucha (2519****4697) on " +
                "08/07/2026 12:56:35. Your transaction number is DG80NDBZ9Y. " +
                "The service fee is ETB 0.87 and 15% VAT on the service fee is ETB 0.13. " +
                "Your current E-Money Account balance is ETB 253.17.",
        ) as ParsedTelebirrSms.OutgoingTransfer

        assertEquals("DG80NDBZ9Y", parsed.providerTransactionId)
        assertEquals(2_000L, parsed.amountMinor)
        assertEquals("ABAYINE FUCHA", parsed.recipientName)
        assertEquals("9", parsed.recipientPhonePrefix)
        assertEquals("4697", parsed.recipientPhoneSuffix)
        assertEquals(87L, parsed.serviceFeeMinor)
        assertEquals(13L, parsed.vatMinor)
        assertEquals(25_317L, parsed.resultingMainBalanceMinor)
    }

    @Test
    fun `preserves asymmetric visible phone prefix and suffix`() {
        val parsed = parser.parse(
            "You transferred ETB 20.00 to Abayine (9928****7) on 08/07/2026 12:59:30. " +
                "Your transaction number is DG87NDFU4H. Service fee is ETB 0.87. " +
                "VAT is ETB 0.13.",
        ) as ParsedTelebirrSms.OutgoingTransfer

        assertEquals("9928****7", parsed.recipientPhonePattern)
        assertEquals("9928", parsed.recipientPhonePrefix)
        assertEquals("7", parsed.recipientPhoneSuffix)
    }

    @Test
    fun `parses four account balances without combining restricted funds`() {
        val parsed = parser.parse(
            "Customer E-Money Account: 10,000.00 ETB\n" +
                "Incentive Account: 15.25 ETB\n" +
                "Fuel-payment Account: 50.00 ETB\n" +
                "PocketMoney Account: 7.50 ETB",
        ) as ParsedTelebirrSms.BalanceResult

        assertEquals(1_000_000L, parsed.customerEMoneyMinor)
        assertEquals(1_525L, parsed.incentiveMinor)
        assertEquals(5_000L, parsed.fuelPaymentMinor)
        assertEquals(750L, parsed.pocketMoneyMinor)
    }

    @Test
    fun `parses observed balance SMS buckets independently`() {
        val parsed = parser.parse(
            "Dear\nYour telebirr Customer Incentive Account Balance is : ETB 10.00\n" +
                "Customer E-Money Account Balance is : ETB 844.35\n" +
                "Customer E-Money Account for fuel payment Balance is : ETB 0.00\n" +
                "PocketMoneyAccount Balance is : ETB 0.00",
        ) as ParsedTelebirrSms.BalanceResult

        assertEquals(1_000L, parsed.incentiveMinor)
        assertEquals(84_435L, parsed.customerEMoneyMinor)
        assertEquals(0L, parsed.fuelPaymentMinor)
        assertEquals(0L, parsed.pocketMoneyMinor)
    }

    @Test
    fun `missing balance fields remain null rather than zero`() {
        val parsed = parser.parse("Customer E-Money Account: ETB 42.00") as ParsedTelebirrSms.BalanceResult
        assertEquals(4_200L, parsed.customerEMoneyMinor)
        assertNull(parsed.incentiveMinor)
        assertNull(parsed.fuelPaymentMinor)
        assertNull(parsed.pocketMoneyMinor)
    }

    @Test
    fun `malformed precision and missing transaction id do not create receipts`() {
        assertNull(parser.parse("You received ETB 12.345 from Person (0912345678). Transaction ID: ABCDE123"))
        assertNull(parser.parse("You received ETB 12.34 from Person (0912345678)."))
    }

    @Test
    fun `whitespace variants remain deterministic`() {
        val base = "You received ETB 20.00 from Abebe Kebede (0912009876). Transaction ID: SAME12345"
        val variants = listOf(base, base.replace(" ", "  "), base.replace(". ", ".\n"))
        val results = variants.map { parser.parse(it) as ParsedTelebirrSms.IncomingTransfer }
        assertTrue(results.all { it.providerTransactionId == "SAME12345" && it.amountMinor == 2_000L })
    }

    @Test
    fun `normalizes unicode digits before strict parsing`() {
        val parsed = parser.parse(
            "You received ETB ٢٠.٠٠ from Abebe Kebede (٠٩١٢٠٠٩٨٧٦). Transaction ID: UNI12345",
        ) as ParsedTelebirrSms.IncomingTransfer
        assertEquals(2_000L, parsed.amountMinor)
        assertEquals("9876", parsed.senderPhoneSuffix)
    }
}
