package com.telebirr.gateway.agent.crypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class EncryptedPayload(val iv: ByteArray, val ciphertext: ByteArray)

interface PayloadCipher {
    fun encrypt(plaintext: ByteArray, associatedData: ByteArray): EncryptedPayload
    fun decrypt(payload: EncryptedPayload, associatedData: ByteArray): ByteArray
}

/** Encrypts raw SMS/USSD and protocol evidence before it reaches Room. */
class LocalPayloadCipher(private val alias: String = "telebirr-agent-local-spool-v1") : PayloadCipher {
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @Synchronized
    private fun key(): SecretKey {
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
                    .build(),
            )
            generateKey()
        }
    }

    override fun encrypt(plaintext: ByteArray, associatedData: ByteArray): EncryptedPayload {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(associatedData)
        return EncryptedPayload(cipher.iv, cipher.doFinal(plaintext))
    }

    override fun decrypt(payload: EncryptedPayload, associatedData: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, payload.iv))
        cipher.updateAAD(associatedData)
        return cipher.doFinal(payload.ciphertext)
    }
}
