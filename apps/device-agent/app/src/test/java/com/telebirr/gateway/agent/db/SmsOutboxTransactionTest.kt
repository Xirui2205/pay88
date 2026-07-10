package com.telebirr.gateway.agent.db

import android.app.Application
import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [31])
class SmsOutboxTransactionTest {
    private lateinit var database: AgentDatabase
    private lateinit var dao: AgentDao

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext<Context>(),
            AgentDatabase::class.java,
        ).allowMainThreadQueries().build()
        dao = database.agentDao()
    }

    @After
    fun tearDown() = database.close()

    @Test
    fun `evidence and pending outbox are atomic and acknowledgement marks both`() = runTest {
        val digest = "a".repeat(64)
        val eventId = UUID.nameUUIDFromBytes(digest.toByteArray()).toString()
        val evidence = evidence(digest, "TX-ATOMIC-1", eventId)
        val event = event(eventId)

        val first = dao.persistSmsEvidenceWithOutbox(evidence, event)
        assertTrue(first.inserted)
        assertTrue(first.pendingOutboxEnsured)
        assertNull(dao.smsEvidence(digest)?.uploadedAtMs)
        assertEquals(listOf(eventId), dao.pendingSpool(2_000, 10).map { it.id })

        assertEquals(1, dao.acknowledgeSpoolAndSms(listOf(eventId), 3_000))
        assertNotNull(dao.smsEvidence(digest)?.uploadedAtMs)
        assertNotNull(dao.spoolEvent(eventId)?.acknowledgedAtMs)

        val duplicate = dao.persistSmsEvidenceWithOutbox(evidence, event)
        assertFalse(duplicate.inserted)
        assertFalse(duplicate.pendingOutboxEnsured)
        assertTrue(dao.pendingSpool(4_000, 10).isEmpty())
    }

    @Test
    fun `duplicate repairs legacy crash gap when evidence exists without outbox`() = runTest {
        val digest = "b".repeat(64)
        val eventId = UUID.nameUUIDFromBytes(digest.toByteArray()).toString()
        val evidence = evidence(digest, "TX-RECOVER-1", eventId)
        assertTrue(dao.insertSmsEvidence(evidence) != -1L)
        assertNull(dao.spoolEvent(eventId))

        val recovered = dao.persistSmsEvidenceWithOutbox(evidence, event(eventId))
        assertFalse(recovered.inserted)
        assertTrue(recovered.pendingOutboxEnsured)
        assertEquals(eventId, dao.pendingSpool(2_000, 10).single().id)
    }

    private fun evidence(digest: String, providerId: String, eventId: String) = SmsEvidenceEntity(
        messageDigest = digest,
        providerTransactionId = providerId,
        simIccidHash = "c".repeat(64),
        sender = "127",
        rawIv = byteArrayOf(1, 2, 3),
        rawCiphertext = byteArrayOf(4, 5, 6),
        parsedType = "OutgoingTransfer",
        receivedAtMs = 1_000,
        uploadedAtMs = null,
        spoolEventId = eventId,
    )

    private fun event(eventId: String) = SpoolEventEntity(
        id = eventId,
        kind = "SMS_EVIDENCE",
        payloadIv = byteArrayOf(7, 8, 9),
        payloadCiphertext = byteArrayOf(10, 11, 12),
        createdAtMs = 1_000,
        attemptCount = 0,
        nextAttemptAtMs = 1_000,
        acknowledgedAtMs = null,
    )
}
