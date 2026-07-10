package com.telebirr.gateway.agent.storage

import com.telebirr.gateway.agent.crypto.EncryptedPayload
import com.telebirr.gateway.agent.crypto.PayloadCipher
import com.telebirr.gateway.agent.db.AgentDao
import com.telebirr.gateway.agent.db.SpoolEventEntity
import java.time.Clock
import java.util.UUID
import kotlin.math.min

class SpoolRepository(
    private val dao: AgentDao,
    private val cipher: PayloadCipher,
    private val clock: Clock = Clock.systemUTC(),
) {
    suspend fun enqueue(kind: String, payload: ByteArray): String {
        require(kind.matches(Regex("[A-Z0-9_]{1,64}")))
        val id = UUID.randomUUID().toString()
        val encrypted = cipher.encrypt(payload, associatedData(id, kind))
        val now = clock.millis()
        dao.insertSpool(
            SpoolEventEntity(id, kind, encrypted.iv, encrypted.ciphertext, now, 0, now, null),
        )
        payload.fill(0)
        return id
    }

    suspend fun pending(limit: Int = 100): List<DecryptedSpoolEvent> {
        val now = clock.millis()
        return dao.pendingSpool(now, limit.coerceIn(1, 250)).mapNotNull { entity ->
            runCatching {
                DecryptedSpoolEvent(
                    entity.id,
                    entity.kind,
                    cipher.decrypt(
                        EncryptedPayload(entity.payloadIv, entity.payloadCiphertext),
                        associatedData(entity.id, entity.kind),
                    ),
                    entity.attemptCount,
                    entity.createdAtMs,
                )
            }.getOrElse {
                dao.markSpoolCorrupt(entity.id, now, "payload_decryption_failed")
                null
            }
        }
    }

    suspend fun acknowledge(ids: List<String>) {
        if (ids.isNotEmpty()) dao.acknowledgeSpoolAndSms(ids.distinct(), clock.millis())
    }

    suspend fun defer(event: DecryptedSpoolEvent) {
        val exponent = min(event.attemptCount, 10)
        val delayMs = min(5_000L * (1L shl exponent), 15 * 60_000L)
        dao.deferSpool(event.id, clock.millis() + delayMs)
        event.payload.fill(0)
    }

    suspend fun isolate(event: DecryptedSpoolEvent, reason: String) {
        require(reason.matches(Regex("[a-z0-9_]{1,64}")))
        dao.markSpoolCorrupt(event.id, clock.millis(), reason)
        event.payload.fill(0)
    }

    private fun associatedData(id: String, kind: String) = "$id:$kind".toByteArray()
}

data class DecryptedSpoolEvent(
    val id: String,
    val kind: String,
    val payload: ByteArray,
    val attemptCount: Int,
    val createdAtMs: Long,
)
