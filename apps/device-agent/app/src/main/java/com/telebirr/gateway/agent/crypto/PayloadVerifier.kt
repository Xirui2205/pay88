package com.telebirr.gateway.agent.crypto

import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/** Verifies the exact payload bytes supplied by the gateway; no JSON re-encoding occurs. */
class PayloadVerifier private constructor(private val key: PublicKey) {
    fun verify(payload: ByteArray, signature: ByteArray): Boolean = runCatching {
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(key)
            update(payload)
            verify(signature)
        }
    }.getOrDefault(false)

    companion object {
        fun fromX509Base64(encoded: String): PayloadVerifier {
            require(encoded.isNotBlank()) { "A pinned signing key is required" }
            val key = KeyFactory.getInstance("EC").generatePublic(
                X509EncodedKeySpec(CryptoEncoding.base64Decode(encoded)),
            )
            return PayloadVerifier(key)
        }

        fun x509Base64FromPem(pem: String): String {
            val normalized = pem
                .replace("-----BEGIN PUBLIC KEY-----", "")
                .replace("-----END PUBLIC KEY-----", "")
                .replace(Regex("\\s+"), "")
            require(normalized.isNotBlank()) { "Public key PEM is empty" }
            // Decode once so malformed PEM is rejected during activation.
            CryptoEncoding.base64Decode(normalized)
            return normalized
        }

        fun fromPem(pem: String): PayloadVerifier = fromX509Base64(x509Base64FromPem(pem))
    }
}
