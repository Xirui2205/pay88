package com.telebirr.gateway.agent.transport

import android.content.Context
import android.security.KeyChain
import okhttp3.OkHttpClient
import java.net.Socket
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManager
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509KeyManager
import javax.net.ssl.X509TrustManager

object MtlsOkHttpClientFactory {
    fun create(context: Context, certificateAlias: String): OkHttpClient {
        val privateKey = KeyChain.getPrivateKey(context, certificateAlias)
            ?: throw IllegalStateException("MDM client private key is unavailable")
        val chain = KeyChain.getCertificateChain(context, certificateAlias)
            ?: throw IllegalStateException("MDM client certificate is unavailable")
        require(chain.isNotEmpty())
        chain.first().checkValidity()

        val keyManager = FixedAliasKeyManager(certificateAlias, privateKey, chain)
        val trustManagerFactory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        trustManagerFactory.init(null as KeyStore?)
        val trustManager = trustManagerFactory.trustManagers.single { it is X509TrustManager } as X509TrustManager
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(arrayOf<KeyManager>(keyManager), arrayOf(trustManager), SecureRandom())
        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}

private class FixedAliasKeyManager(
    private val alias: String,
    private val privateKey: PrivateKey,
    private val chain: Array<X509Certificate>,
) : X509KeyManager {
    override fun chooseClientAlias(
        keyType: Array<out String>?,
        issuers: Array<out Principal>?,
        socket: Socket?,
    ): String? = alias.takeIf {
        keyType.isNullOrEmpty() || keyType.any { requested ->
            requested.equals(chain.first().publicKey.algorithm, ignoreCase = true)
        }
    }

    override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? =
        arrayOf(alias).takeIf {
            keyType == null || keyType.equals(chain.first().publicKey.algorithm, ignoreCase = true)
        }
    override fun getCertificateChain(alias: String?): Array<X509Certificate> = chain.copyOf()
    override fun getPrivateKey(alias: String?): PrivateKey = privateKey
    override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
    override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null
}
