package com.telebirr.gateway.agent.db

import android.app.Application
import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.telebirr.gateway.agent.crypto.EncryptedPayload
import com.telebirr.gateway.agent.crypto.PayloadCipher
import com.telebirr.gateway.agent.storage.SpoolRepository
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [31])
class SpoolOrderingTest {
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
    fun `pending order follows insertion sequence across wall clock rollback`() = runTest {
        dao.insertSpool(event("device-started", 2_000))
        dao.insertSpool(event("pin-submitted", 1_000))

        assertEquals(
            listOf("device-started", "pin-submitted"),
            dao.pendingSpool(5_000, 10).map { it.id },
        )
    }

    @Test
    fun `deferred earliest event blocks later causal events`() = runTest {
        dao.insertSpool(event("device-started", 1_000))
        dao.insertSpool(event("pin-submitted", 2_000))
        dao.deferSpool("device-started", 10_000)

        assertEquals(emptyList<SpoolEventEntity>(), dao.pendingSpool(5_000, 10))
        assertEquals(
            listOf("device-started", "pin-submitted"),
            dao.pendingSpool(10_000, 10).map { it.id },
        )
    }

    @Test
    fun `corrupt earliest row is marked and isolated from later delivery`() = runTest {
        dao.insertSpool(event("corrupt", 1_000).copy(payloadCiphertext = byteArrayOf(9)))
        dao.insertSpool(event("valid", 2_000).copy(payloadCiphertext = byteArrayOf(2)))
        val cipher = object : PayloadCipher {
            override fun encrypt(plaintext: ByteArray, associatedData: ByteArray) =
                EncryptedPayload(byteArrayOf(1), plaintext.copyOf())

            override fun decrypt(payload: EncryptedPayload, associatedData: ByteArray): ByteArray {
                if (payload.ciphertext.contentEquals(byteArrayOf(9))) error("corrupt")
                return payload.ciphertext.copyOf()
            }
        }
        val repository = SpoolRepository(
            dao,
            cipher,
            Clock.fixed(Instant.ofEpochMilli(5_000), ZoneOffset.UTC),
        )

        assertEquals(listOf("valid"), repository.pending(10).map { it.id })
        assertNotNull(dao.spoolEvent("corrupt")?.corruptAtMs)
        assertEquals("payload_decryption_failed", dao.spoolEvent("corrupt")?.corruptReason)
    }

    private fun event(id: String, wallClock: Long) = SpoolEventEntity(
        id = id,
        kind = "JOB_STATUS",
        payloadIv = byteArrayOf(1),
        payloadCiphertext = byteArrayOf(2),
        createdAtMs = wallClock,
        attemptCount = 0,
        nextAttemptAtMs = 0,
        acknowledgedAtMs = null,
    )
}
