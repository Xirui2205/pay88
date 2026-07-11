package com.telebirr.gateway.agent.transport

import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException

class FallbackDnsTest {
    @Test
    fun `uses primary result without calling fallback`() {
        val primaryAddress = address(1, 1, 1, 1)
        var fallbackCalled = false
        val dns = FallbackDns(
            primary = dns { listOf(primaryAddress) },
            fallback = dns {
                fallbackCalled = true
                listOf(address(8, 8, 8, 8))
            },
        )

        assertEquals(listOf(primaryAddress), dns.lookup("api.88pay.ai"))
        assertFalse(fallbackCalled)
    }

    @Test
    fun `uses fallback when system DNS cannot resolve hostname`() {
        val fallbackAddress = address(104, 21, 57, 25)
        val dns = FallbackDns(
            primary = dns { throw UnknownHostException("system DNS failed") },
            fallback = dns { listOf(fallbackAddress) },
        )

        assertEquals(listOf(fallbackAddress), dns.lookup("api.88pay.ai"))
    }

    @Test
    fun `uses fallback when primary returns no addresses`() {
        var fallbackCalled = false
        val dns = FallbackDns(
            primary = dns { emptyList() },
            fallback = dns {
                fallbackCalled = true
                listOf(address(172, 67, 158, 188))
            },
        )

        assertTrue(dns.lookup("api.88pay.ai").isNotEmpty())
        assertTrue(fallbackCalled)
    }

    private fun address(a: Int, b: Int, c: Int, d: Int): InetAddress =
        InetAddress.getByAddress(byteArrayOf(a.toByte(), b.toByte(), c.toByte(), d.toByte()))

    private fun dns(block: (String) -> List<InetAddress>): Dns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> = block(hostname)
    }
}
