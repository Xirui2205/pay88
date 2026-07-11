package com.telebirr.gateway.agent.activation

import com.telebirr.gateway.agent.config.AgentConfigStore
import com.telebirr.gateway.agent.crypto.PayloadVerifier
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class ActivationClient(
    private val httpClient: OkHttpClient,
    private val json: Json = Json { ignoreUnknownKeys = false },
) {
    suspend fun activate(baseUrl: String, activation: ActivationRequest): ActivationResponse =
        withContext(Dispatchers.IO) {
            AgentConfigStore.validateGatewayUrl(baseUrl)
            val body = json.encodeToString(activation)
                .toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url(baseUrl.trimEnd('/') + "/v1/device/activate")
                .post(body)
                .header("Accept", "application/json")
                .build()
            httpClient.newCall(request).execute().use { response ->
                val responseBody = requireNotNull(response.body).string()
                if (!response.isSuccessful) {
                    val message = runCatching {
                        json.decodeFromString<ActivationEnvelope>(responseBody).message
                    }.getOrNull()
                    error(message ?: "Activation rejected (${response.code})")
                }
                val envelope = json.decodeFromString<ActivationEnvelope>(responseBody)
                require(envelope.status == "success" && envelope.code == "ok") {
                    "Activation response was not successful"
                }
                requireNotNull(envelope.data).also {
                    require(it.deviceId.isNotBlank())
                    require(it.deviceToken.matches(Regex("[A-Za-z0-9_-]{32,512}")))
                    require(it.keyId.isNotBlank())
                    PayloadVerifier.fromPem(it.signingPublicKeyPem)
                    AgentConfigStore.validateWebsocketUrl(it.websocketUrl)
                    require(it.heartbeatIntervalSeconds in 15..60)
                    require(it.sims.size in 1..2) { "Activation must contain one or two qualified SIMs" }
                }
            }
        }
}
