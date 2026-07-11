package com.telebirr.gateway.agent.transport

import com.telebirr.gateway.agent.AgentContainer
import com.telebirr.gateway.agent.config.AgentConfig
import com.telebirr.gateway.agent.protocol.SignedDeviceJobEnvelope
import com.telebirr.gateway.agent.protocol.SignedLeaseRenewalEnvelope
import com.telebirr.gateway.agent.protocol.JobAcceptance
import com.telebirr.gateway.agent.storage.DecryptedSpoolEvent
import com.telebirr.gateway.agent.ussd.profile.SignedFlowProfileEnvelope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicBoolean

class DeviceGatewayClient(
    private val container: AgentContainer,
    private val config: AgentConfig,
    private val json: Json = Json { ignoreUnknownKeys = false },
) : WebSocketListener() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = MtlsOkHttpClientFactory.create(container.application, config.clientCertificateAlias)
    private val connected = AtomicBoolean(false)
    private val inbound = Channel<String>(capacity = 64)
    @Volatile private var socket: WebSocket? = null

    init {
        scope.launch {
            for (message in inbound) handleMessage(message)
        }
    }

    fun connect() {
        if (socket != null) return
        container.connectionDiagnostics.connecting()
        socket = http.newWebSocket(
            Request.Builder()
                .url(config.websocketUrl)
                .header("Authorization", "Bearer ${config.deviceToken}")
                .header("X-Device-Id", config.deviceId)
                .header("X-Device-Protocol", "1")
                .build(),
            this,
        )
    }

    fun isConnected(): Boolean = connected.get()

    override fun onOpen(webSocket: WebSocket, response: Response) {
        connected.set(true)
        container.connectionDiagnostics.socketOpened(response.code)
        send(
            buildJsonObject {
                put("type", "hello")
                put("device_id", config.deviceId)
                put("protocol_version", "1")
            },
        )
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        if (inbound.trySend(text).isFailure) {
            webSocket.close(1011, "inbound_queue_full")
        }
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        connected.set(false)
        socket = null
        container.connectionDiagnostics.closed(code, reason)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        connected.set(false)
        socket = null
        container.connectionDiagnostics.failed(
            "${t.javaClass.simpleName}: ${t.message ?: "connection failed"}",
            response?.code,
        )
    }

    fun sendHeartbeat(payload: JsonObject): Boolean {
        val sentAtMs = payload["sent_at_ms"]?.jsonPrimitive?.content?.toLongOrNull()
            ?: System.currentTimeMillis()
        val accepted = send(buildJsonObject {
            put("type", "heartbeat")
            put("payload", payload)
        })
        if (accepted) container.connectionDiagnostics.heartbeatSent(sentAtMs)
        return accepted
    }

    fun requestLeaseRenewal(jobId: String, fencingToken: Long): Boolean = send(
        buildJsonObject {
            put("type", "lease_renewal_request")
            put("job_id", jobId)
            put("fencing_token", fencingToken)
        },
    )

    suspend fun flushSpool(): Boolean {
        if (!connected.get()) return false
        val events = container.spool.pending(100)
        if (events.isEmpty()) return true
        val batch = SpoolBatchEncoder.encode(config.deviceId, events, json)
        batch.oversized?.let { oversized ->
            container.spool.isolate(oversized, "serialized_frame_too_large")
            events.filterNot { it.id == oversized.id }.forEach { it.payload.fill(0) }
            return true
        }
        val message = batch.message ?: run {
            events.forEach { it.payload.fill(0) }
            return true
        }
        val accepted = send(message)
        val selectedIds = batch.selected.mapTo(hashSetOf(), DecryptedSpoolEvent::id)
        events.forEach { event ->
            event.payload.fill(0)
            if (!accepted && event.id in selectedIds) container.spool.defer(event)
        }
        return accepted
    }

    private suspend fun handleMessage(raw: String) {
        val message = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        when (message["type"]?.jsonPrimitive?.content) {
            "hello_ack" -> container.connectionDiagnostics.helloAcknowledged()
            "heartbeat_ack" -> {
                val receivedAt = message["received_at_ms"]?.jsonPrimitive?.content?.toLongOrNull()
                    ?: System.currentTimeMillis()
                container.connectionDiagnostics.heartbeatAcknowledged(receivedAt)
            }
            "profile_install" -> {
                handleProfileInstall(message["envelope"])
            }
            "job" -> {
                val envelope = runCatching {
                    json.decodeFromJsonElement<SignedDeviceJobEnvelope>(requireNotNull(message["envelope"]))
                }.getOrNull() ?: return
                val acceptance = container.runtimeOrNull()?.executor?.submit(envelope) ?: return
                container.spool.enqueue(
                    "JOB_ACCEPTANCE",
                    buildJsonObject {
                        when (acceptance) {
                            is JobAcceptance.Accepted -> {
                                put("job_id", acceptance.job.jobId)
                                put("result", "accepted")
                            }
                            is JobAcceptance.Duplicate -> {
                                put("job_id", acceptance.job.jobId)
                                put("result", "duplicate")
                                put("state", acceptance.status.wireName)
                            }
                            is JobAcceptance.Rejected -> {
                                put("result", "rejected")
                                put("code", acceptance.code)
                            }
                        }
                    }.toString().toByteArray(),
                )
            }
            "lease_renewal" -> {
                val envelope = runCatching {
                    json.decodeFromJsonElement<SignedLeaseRenewalEnvelope>(requireNotNull(message["envelope"]))
                }.getOrNull() ?: return
                val runtime = container.runtimeOrNull() ?: return
                val renewal = runtime.jobs.renewLease(envelope) ?: return
                runtime.sessions.renewLease(renewal.jobId, renewal.leaseExpiresAtMs)
            }
            "spool_ack" -> {
                val ids = message["event_ids"]?.jsonArray.orEmpty().mapNotNull {
                    runCatching { it.jsonPrimitive.content }.getOrNull()
                }
                container.spool.acknowledge(ids)
            }
        }
    }

    private suspend fun handleProfileInstall(envelopeElement: JsonElement?) {
        val observedAt = System.currentTimeMillis()
        val envelope = runCatching {
            json.decodeFromJsonElement<SignedFlowProfileEnvelope>(requireNotNull(envelopeElement))
        }.getOrElse { error ->
            enqueueProfileInstallResult(
                envelopeElement = envelopeElement,
                keyId = null,
                profileId = null,
                profileVersion = null,
                result = "rejected",
                code = "envelope_decode_failed",
                message = diagnosticMessage(error),
                observedAt = observedAt,
            )
            return
        }
        try {
            val runtime = container.runtimeOrNull() ?: error("Agent runtime is unavailable")
            val profile = runtime.profileStore.install(envelope)
            enqueueProfileInstallResult(
                envelopeElement = envelopeElement,
                keyId = envelope.keyId,
                profileId = profile.profileId,
                profileVersion = profile.version,
                result = "installed",
                code = "ok",
                message = "Signed USSD profile installed and verified",
                observedAt = observedAt,
            )
        } catch (error: Throwable) {
            enqueueProfileInstallResult(
                envelopeElement = envelopeElement,
                keyId = envelope.keyId,
                profileId = profileIdentity(envelope.payloadBase64).first,
                profileVersion = profileIdentity(envelope.payloadBase64).second,
                result = "rejected",
                code = profileInstallErrorCode(error),
                message = diagnosticMessage(error),
                observedAt = observedAt,
            )
        }
    }

    private suspend fun enqueueProfileInstallResult(
        envelopeElement: JsonElement?,
        keyId: String?,
        profileId: String?,
        profileVersion: Int?,
        result: String,
        code: String,
        message: String,
        observedAt: Long,
    ) {
        val installed = container.runtimeOrNull()?.profileStore?.installedMetadata().orEmpty()
        container.spool.enqueue(
            "PROFILE_INSTALL_RESULT",
            buildJsonObject {
                put("profile_id", profileId)
                put("profile_version", profileVersion)
                put("key_id", keyId)
                put("result", result)
                put("code", code)
                put("message", message)
                put("observed_at_ms", observedAt)
                put("installed_profiles", buildJsonArray {
                    installed.forEach { (id, version) ->
                        add(buildJsonObject { put("id", id); put("version", version) })
                    }
                })
                envelopeElement?.let { put("server_envelope", it) }
            }.toString().toByteArray(),
        )
    }

    private fun profileIdentity(payloadBase64: String): Pair<String?, Int?> = runCatching {
        val payload = com.telebirr.gateway.agent.crypto.CryptoEncoding.base64Decode(payloadBase64).decodeToString()
        val objectValue = json.parseToJsonElement(payload).jsonObject
        objectValue["profile_id"]?.jsonPrimitive?.content to
            objectValue["version"]?.jsonPrimitive?.content?.toIntOrNull()
    }.getOrDefault(null to null)

    private fun profileInstallErrorCode(error: Throwable): String {
        val message = error.message.orEmpty().lowercase()
        return when {
            "runtime is unavailable" in message -> "runtime_unavailable"
            "unexpected profile signing key" in message -> "signing_key_mismatch"
            "invalid profile signature" in message -> "signature_invalid"
            "rollback" in message -> "profile_rollback_rejected"
            "different signed content" in message -> "profile_version_conflict"
            "atomically install" in message -> "profile_storage_failed"
            else -> "profile_validation_failed"
        }
    }

    private fun diagnosticMessage(error: Throwable): String =
        (error.message ?: error::class.java.simpleName).take(500)

    private fun send(message: JsonObject): Boolean = socket?.send(message.toString()) == true

    fun close() {
        socket?.close(1000, "agent_shutdown")
        socket = null
        connected.set(false)
        inbound.close()
        scope.cancel()
        http.dispatcher.executorService.shutdown()
        http.connectionPool.evictAll()
    }
}
