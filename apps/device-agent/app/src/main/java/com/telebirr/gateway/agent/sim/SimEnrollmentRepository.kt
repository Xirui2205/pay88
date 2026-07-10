package com.telebirr.gateway.agent.sim

import com.telebirr.gateway.agent.crypto.CryptoEncoding
import com.telebirr.gateway.agent.crypto.PayloadCipher
import com.telebirr.gateway.agent.db.AgentDao
import com.telebirr.gateway.agent.db.SimIdentityEntity
import com.telebirr.gateway.agent.ussd.NameNormalizer
import java.time.Clock

class SimEnrollmentRepository(
    private val dao: AgentDao,
    private val cipher: PayloadCipher,
    private val clock: Clock = Clock.systemUTC(),
) {
    suspend fun enroll(
        iccid: String,
        telebirrNumber: String,
        accountName: String,
        expectedSlot: Int,
        observedSlot: Int,
        subscriptionId: Int,
    ) {
        require(iccid.matches(Regex("[0-9]{10,24}")))
        val normalizedNumber = EthiopianPhoneNumber.normalize(telebirrNumber)
        require(expectedSlot in 0..1 && observedSlot == expectedSlot)
        val hash = CryptoEncoding.sha256Hex(iccid)
        val encrypted = cipher.encrypt(iccid.toByteArray(), hash.toByteArray())
        dao.upsertSimIdentity(
            SimIdentityEntity(
                iccidHash = hash,
                iccidIv = encrypted.iv,
                iccidCiphertext = encrypted.ciphertext,
                enrolledNumber = normalizedNumber,
                normalizedAccountName = NameNormalizer.normalize(accountName).joinToString(" "),
                expectedSlotIndex = expectedSlot,
                slotIndex = observedSlot,
                subscriptionId = subscriptionId,
                state = "ACTIVE",
                updatedAtMs = clock.millis(),
            ),
        )
    }
}
