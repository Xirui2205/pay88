package com.telebirr.gateway.agent.sms

import com.telebirr.gateway.agent.crypto.CryptoEncoding
import com.telebirr.gateway.agent.crypto.PayloadCipher
import com.telebirr.gateway.agent.db.AgentDao
import com.telebirr.gateway.agent.db.SmsEvidenceEntity
import com.telebirr.gateway.agent.db.SpoolEventEntity
import java.util.UUID

data class EvidenceResult(
    val inserted: Boolean,
    val digest: String,
    val pendingOutboxEnsured: Boolean,
)

object SmsEvidenceOutboxIdentity {
    fun digest(message: AttributedSms): String = message.parsed?.providerTransactionId?.let {
        CryptoEncoding.sha256Hex("provider:${it.uppercase()}")
    } ?: CryptoEncoding.sha256Hex(
        "${message.iccid}|${message.sender}|${message.receivedAtMs}|${message.rawMessage}",
    )

    fun eventId(digest: String): String = UUID.nameUUIDFromBytes(
        "telebirr-sms-evidence:$digest".toByteArray(Charsets.UTF_8),
    ).toString()
}

class SmsEvidenceRepository(
    private val dao: AgentDao,
    private val cipher: PayloadCipher,
) {
    suspend fun persistWithOutbox(
        message: AttributedSms,
        payloadFactory: (canonicalDigest: String) -> ByteArray,
    ): EvidenceResult {
        val candidateDigest = SmsEvidenceOutboxIdentity.digest(message)
        val prior = dao.smsEvidence(candidateDigest)
            ?: message.parsed?.providerTransactionId?.let { dao.smsEvidenceByProviderTransactionId(it) }
        val digest = prior?.messageDigest ?: candidateDigest
        val outboxId = prior?.spoolEventId ?: SmsEvidenceOutboxIdentity.eventId(digest)
        val parsedType = message.parsed?.javaClass?.simpleName ?: "UNPARSED"
        val encrypted = cipher.encrypt(
            message.rawMessage.toByteArray(Charsets.UTF_8),
            "$digest:$parsedType".toByteArray(),
        )
        val payload = payloadFactory(digest)
        val encryptedOutbox = try {
            cipher.encrypt(payload, "$outboxId:SMS_EVIDENCE".toByteArray())
        } finally {
            payload.fill(0)
        }
        val result = dao.persistSmsEvidenceWithOutbox(
            SmsEvidenceEntity(
                messageDigest = digest,
                providerTransactionId = message.parsed?.providerTransactionId,
                simIccidHash = CryptoEncoding.sha256Hex(message.iccid),
                sender = message.sender,
                rawIv = encrypted.iv,
                rawCiphertext = encrypted.ciphertext,
                parsedType = parsedType,
                receivedAtMs = message.receivedAtMs,
                uploadedAtMs = null,
                spoolEventId = outboxId,
            ),
            SpoolEventEntity(
                id = outboxId,
                kind = "SMS_EVIDENCE",
                payloadIv = encryptedOutbox.iv,
                payloadCiphertext = encryptedOutbox.ciphertext,
                createdAtMs = message.receivedAtMs,
                attemptCount = 0,
                nextAttemptAtMs = message.receivedAtMs,
                acknowledgedAtMs = null,
            ),
        )
        return EvidenceResult(result.inserted, result.evidence.messageDigest, result.pendingOutboxEnsured)
    }
}
