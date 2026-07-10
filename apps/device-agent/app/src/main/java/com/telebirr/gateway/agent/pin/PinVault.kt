package com.telebirr.gateway.agent.pin

import android.content.Context
import android.annotation.SuppressLint
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.telebirr.gateway.agent.crypto.CryptoEncoding
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Device-local PIN vault. The AES key is non-exportable and each SIM has a separate
 * alias. Plaintext is exposed only to the callback and cleared immediately after.
 */
class PinVault(context: Context) {
    private val preferences = context.getSharedPreferences("local-pin-vault-v1", Context.MODE_PRIVATE)
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun put(iccid: String, pin: CharArray) {
        var plaintext: ByteArray? = null
        try {
            require(iccid.matches(Regex("[0-9]{10,24}"))) { "Invalid ICCID" }
            require(pin.size in 4..8 && pin.all { it in '0'..'9' }) { "PIN must contain 4-8 digits" }
            val keyId = keyId(iccid)
            plaintext = encode(pin)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey(keyId))
            cipher.updateAAD(keyId.toByteArray())
            val encrypted = cipher.doFinal(plaintext)
            val serialized = listOf(
                "1",
                Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
                Base64.encodeToString(encrypted, Base64.NO_WRAP),
            ).joinToString(":")
            check(preferences.edit().putString(keyId, serialized).commit())
        } finally {
            plaintext?.fill(0)
            pin.fill('\u0000')
        }
    }

    fun contains(iccid: String): Boolean = preferences.contains(keyId(iccid))

    @SuppressLint("ApplySharedPref") // Secret deletion must be durable before returning.
    fun delete(iccid: String) {
        val id = keyId(iccid)
        preferences.edit().remove(id).commit()
        if (keyStore.containsAlias(id)) keyStore.deleteEntry(id)
    }

    fun <T> use(iccid: String, operation: (CharArray) -> T): T {
        val id = keyId(iccid)
        val fields = requireNotNull(preferences.getString(id, null)) { "No local PIN for SIM" }.split(':')
        require(fields.size == 3 && fields[0] == "1") { "Unsupported PIN blob" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            requireNotNull(keyStore.getKey(id, null) as? SecretKey) { "PIN key unavailable" },
            GCMParameterSpec(128, Base64.decode(fields[1], Base64.NO_WRAP)),
        )
        cipher.updateAAD(id.toByteArray())
        val plaintext = cipher.doFinal(Base64.decode(fields[2], Base64.NO_WRAP))
        val pin = decode(plaintext)
        return try {
            operation(pin)
        } finally {
            plaintext.fill(0)
            pin.fill('\u0000')
        }
    }

    private fun keyId(iccid: String): String = "telebirr-pin-${CryptoEncoding.sha256Hex(iccid).take(32)}"

    @Synchronized
    private fun getOrCreateKey(alias: String): SecretKey {
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
            generateKey()
        }
    }

    private fun encode(chars: CharArray): ByteArray {
        val bytes = Charsets.UTF_8.newEncoder().encode(CharBuffer.wrap(chars))
        return ByteArray(bytes.remaining()).also(bytes::get)
    }

    private fun decode(bytes: ByteArray): CharArray {
        val chars = Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes))
        return CharArray(chars.remaining()).also(chars::get)
    }
}
