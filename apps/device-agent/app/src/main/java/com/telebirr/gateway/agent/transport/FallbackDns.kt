package com.telebirr.gateway.agent.transport

import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.dnsoverhttps.DnsOverHttps
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/** Uses Android's resolver normally and only invokes the fallback after a DNS failure. */
internal class FallbackDns(
    private val primary: Dns,
    private val fallback: Dns,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        return try {
            primary.lookup(hostname).ifEmpty { fallback.lookup(hostname) }
        } catch (_: UnknownHostException) {
            fallback.lookup(hostname)
        }
    }
}

internal object PilotDns {
    private val bootstrapClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private val aliDnsOverHttps = DnsOverHttps.Builder()
        .client(bootstrapClient)
        .url("https://dns.alidns.com/dns-query".toHttpUrl())
        .bootstrapDnsHosts(
            InetAddress.getByAddress(byteArrayOf(223.toByte(), 5, 5, 5)),
            InetAddress.getByAddress(byteArrayOf(223.toByte(), 6, 6, 6)),
        )
        .includeIPv6(false)
        .post(true)
        .build()

    val systemThenAliDns: Dns = FallbackDns(Dns.SYSTEM, aliDnsOverHttps)
}
