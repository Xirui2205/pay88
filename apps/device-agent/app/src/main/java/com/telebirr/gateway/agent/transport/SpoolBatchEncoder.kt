package com.telebirr.gateway.agent.transport

import com.telebirr.gateway.agent.storage.DecryptedSpoolEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class EncodedSpoolBatch(
    val message: JsonObject?,
    val selected: List<DecryptedSpoolEvent>,
    val oversized: DecryptedSpoolEvent?,
)

/** Builds a causally ordered WebSocket frame below the configured byte budget. */
object SpoolBatchEncoder {
    const val DEFAULT_MAX_FRAME_BYTES = 200 * 1024

    fun encode(
        deviceId: String,
        events: List<DecryptedSpoolEvent>,
        json: Json,
        maxFrameBytes: Int = DEFAULT_MAX_FRAME_BYTES,
    ): EncodedSpoolBatch {
        require(maxFrameBytes in 1_024..256 * 1024)
        val selected = mutableListOf<DecryptedSpoolEvent>()
        val encoded = mutableListOf<JsonElement>()
        events.forEach { event ->
            val element = eventElement(event, json)
            val candidate = message(deviceId, encoded + element)
            if (candidate.toString().toByteArray(Charsets.UTF_8).size <= maxFrameBytes) {
                selected += event
                encoded += element
            } else {
                return if (selected.isEmpty()) {
                    EncodedSpoolBatch(null, emptyList(), event)
                } else {
                    EncodedSpoolBatch(message(deviceId, encoded), selected.toList(), null)
                }
            }
        }
        return EncodedSpoolBatch(
            message(deviceId, encoded).takeIf { encoded.isNotEmpty() },
            selected.toList(),
            null,
        )
    }

    private fun eventElement(event: DecryptedSpoolEvent, json: Json) = buildJsonObject {
        put("id", event.id)
        put("kind", event.kind)
        put("created_at_ms", event.createdAtMs)
        val raw = event.payload.decodeToString()
        put("payload", runCatching { json.parseToJsonElement(raw) }.getOrElse { JsonPrimitive(raw) })
    }

    private fun message(deviceId: String, events: List<JsonElement>) = buildJsonObject {
        put("type", "spool_batch")
        put("device_id", deviceId)
        put("events", buildJsonArray { events.forEach(::add) })
    }
}
