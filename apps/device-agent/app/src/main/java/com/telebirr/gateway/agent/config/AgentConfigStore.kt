package com.telebirr.gateway.agent.config

import android.content.Context
import androidx.core.content.edit
import com.telebirr.gateway.agent.crypto.CryptoEncoding
import com.telebirr.gateway.agent.crypto.EncryptedPayload
import com.telebirr.gateway.agent.crypto.LocalPayloadCipher
import java.net.URI

data class AgentConfig(
    val gatewayBaseUrl: String,
    val websocketUrl: String,
    val deviceId: String,
    val deviceToken: String,
    val clientCertificateAlias: String,
    val signingKeyId: String,
    val signingPublicKeyX509: String,
    val heartbeatIntervalSeconds: Int,
    val openClawPaired: Boolean,
)

class AgentConfigStore(context: Context) {
    private val preferences = context.getSharedPreferences("agent-config-v1", Context.MODE_PRIVATE)
    private val tokenCipher = LocalPayloadCipher("telebirr-agent-device-token-v1")

    fun current(): AgentConfig? {
        val baseUrl = preferences.getString(BASE_URL, null) ?: return null
        val websocketUrl = preferences.getString(WEBSOCKET_URL, null) ?: return null
        val deviceId = preferences.getString(DEVICE_ID, null) ?: return null
        val certificateAlias = preferences.getString(CERT_ALIAS, "") ?: ""
        val keyId = preferences.getString(SIGNING_KEY_ID, null) ?: return null
        val signingKey = preferences.getString(SIGNING_KEY, null) ?: return null
        val tokenIv = preferences.getString(DEVICE_TOKEN_IV, null) ?: return null
        val encryptedToken = preferences.getString(DEVICE_TOKEN_CIPHERTEXT, null) ?: return null
        val deviceToken = runCatching {
            tokenCipher.decrypt(
                EncryptedPayload(
                    CryptoEncoding.base64Decode(tokenIv),
                    CryptoEncoding.base64Decode(encryptedToken),
                ),
                "device-token:$deviceId".toByteArray(),
            ).let { plaintext ->
                try {
                    plaintext.decodeToString()
                } finally {
                    plaintext.fill(0)
                }
            }
        }.getOrNull() ?: return null
        return AgentConfig(
            baseUrl,
            websocketUrl,
            deviceId,
            deviceToken,
            certificateAlias,
            keyId,
            signingKey,
            preferences.getInt(HEARTBEAT_INTERVAL_SECONDS, 30),
            preferences.getBoolean(OPENCLAW_PAIRED, false),
        )
    }

    fun saveActivation(config: AgentConfig) {
        validateGatewayUrl(config.gatewayBaseUrl)
        validateWebsocketUrl(config.websocketUrl)
        require(config.deviceId.isNotBlank())
        require(config.deviceToken.matches(Regex("[A-Za-z0-9_-]{32,512}")))
        require(config.signingKeyId.matches(Regex("[a-zA-Z0-9._:-]{1,64}")))
        require(config.signingPublicKeyX509.isNotBlank())
        require(config.heartbeatIntervalSeconds in 15..60)
        val tokenBytes = config.deviceToken.toByteArray()
        val encryptedToken = try {
            tokenCipher.encrypt(tokenBytes, "device-token:${config.deviceId}".toByteArray())
        } finally {
            tokenBytes.fill(0)
        }
        preferences.edit(commit = true) {
            putString(BASE_URL, config.gatewayBaseUrl.trimEnd('/'))
            putString(WEBSOCKET_URL, config.websocketUrl)
            putString(DEVICE_ID, config.deviceId)
            putString(CERT_ALIAS, config.clientCertificateAlias)
            putString(SIGNING_KEY_ID, config.signingKeyId)
            putString(SIGNING_KEY, config.signingPublicKeyX509)
            putString(DEVICE_TOKEN_IV, CryptoEncoding.base64(encryptedToken.iv))
            putString(DEVICE_TOKEN_CIPHERTEXT, CryptoEncoding.base64(encryptedToken.ciphertext))
            putInt(HEARTBEAT_INTERVAL_SECONDS, config.heartbeatIntervalSeconds)
            putBoolean(OPENCLAW_PAIRED, config.openClawPaired)
        }
    }

    fun setOpenClawPaired(paired: Boolean) = preferences.edit(commit = true) {
        putBoolean(OPENCLAW_PAIRED, paired)
    }

    fun clearActivation() = preferences.edit(commit = true) { clear() }

    companion object {
        private const val BASE_URL = "gateway_base_url"
        private const val WEBSOCKET_URL = "websocket_url"
        private const val DEVICE_ID = "device_id"
        private const val DEVICE_TOKEN_IV = "device_token_iv"
        private const val DEVICE_TOKEN_CIPHERTEXT = "device_token_ciphertext"
        private const val CERT_ALIAS = "client_certificate_alias"
        private const val SIGNING_KEY_ID = "signing_key_id"
        private const val SIGNING_KEY = "signing_public_key_x509"
        private const val HEARTBEAT_INTERVAL_SECONDS = "heartbeat_interval_seconds"
        private const val OPENCLAW_PAIRED = "openclaw_paired"

        fun validateGatewayUrl(url: String) {
            val uri = runCatching { URI(url) }.getOrNull()
                ?: throw IllegalArgumentException("Invalid gateway URL")
            require(uri.scheme.equals("https", ignoreCase = true)) { "HTTPS is required" }
            require(!uri.host.isNullOrBlank() && uri.userInfo == null && uri.fragment == null) {
                "Invalid gateway URL"
            }
        }

        fun validateWebsocketUrl(url: String) {
            val uri = runCatching { URI(url) }.getOrNull()
                ?: throw IllegalArgumentException("Invalid WebSocket URL")
            require(uri.scheme.equals("wss", ignoreCase = true)) { "WSS is required" }
            require(!uri.host.isNullOrBlank() && uri.userInfo == null && uri.fragment == null) {
                "Invalid WebSocket URL"
            }
        }
    }
}
