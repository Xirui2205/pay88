package com.telebirr.gateway.agent.transport

import com.telebirr.gateway.agent.storage.DecryptedSpoolEvent
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpoolBatchEncoderTest {
    private val json = Json { ignoreUnknownKeys = false }

    @Test
    fun `one hundred eight kilobyte events are split below websocket budget in causal order`() {
        val events = (0 until 100).map { index -> event(index, "x".repeat(8 * 1024)) }
        val batch = SpoolBatchEncoder.encode("device:pilot:0001", events, json)

        assertNotNull(batch.message)
        assertNull(batch.oversized)
        assertTrue(batch.selected.size in 1 until 100)
        assertEquals(events.take(batch.selected.size).map { it.id }, batch.selected.map { it.id })
        assertTrue(
            batch.message.toString().toByteArray(Charsets.UTF_8).size <=
                SpoolBatchEncoder.DEFAULT_MAX_FRAME_BYTES,
        )
    }

    @Test
    fun `single oversized event is isolated instead of retried forever`() {
        val event = event(0, "x".repeat(220 * 1024))
        val batch = SpoolBatchEncoder.encode("device:pilot:0001", listOf(event), json)

        assertNull(batch.message)
        assertTrue(batch.selected.isEmpty())
        assertEquals(event.id, batch.oversized?.id)
    }

    private fun event(index: Int, payload: String) = DecryptedSpoolEvent(
        id = "event-${index.toString().padStart(3, '0')}",
        kind = "USSD_SCREEN_EVIDENCE",
        payload = payload.toByteArray(),
        attemptCount = 0,
        createdAtMs = index.toLong(),
    )
}
