package com.telebirr.gateway.agent.crypto

import java.security.MessageDigest
import java.util.Base64

object CryptoEncoding {
    fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    fun base64Decode(value: String): ByteArray = Base64.getDecoder().decode(value)

    fun sha256(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)

    fun sha256Hex(value: String): String = sha256(value.toByteArray(Charsets.UTF_8))
        .joinToString(separator = "") { byte ->
            (byte.toInt() and 0xff).toString(16).padStart(2, '0')
        }

    fun constantTimeEquals(left: ByteArray, right: ByteArray): Boolean =
        MessageDigest.isEqual(left, right)
}
