package com.telebirr.gateway.agent.ussd

import org.junit.Assert.assertEquals
import org.junit.Test

class UssdScreenParserTest {
    private val parser = UssdScreenParser()

    @Test
    fun `parses menu number and label pairs`() {
        val screen = parser.parse("Welcome\n1. Send Money\n2) Buy Airtime\n 3 - Next ")
        assertEquals(listOf("1", "2", "3"), screen.options.map(MenuOption::number))
        assertEquals(listOf("SEND MONEY", "BUY AIRTIME", "NEXT"), screen.options.map(MenuOption::normalizedLabel))
    }

    @Test
    fun `normalizes arabic indic and fullwidth menu digits`() {
        val screen = parser.parse("١. Next\n２) My Account\n፫: Balance")
        assertEquals(listOf("1", "2", "3"), screen.options.map(MenuOption::number))
    }
}
