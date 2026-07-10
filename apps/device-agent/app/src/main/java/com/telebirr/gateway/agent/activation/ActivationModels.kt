package com.telebirr.gateway.agent.activation

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ActivationRequest(
    @SerialName("activation_code") val activationCode: String,
    @SerialName("installation_id") val installationId: String,
    @SerialName("hardware_serial") val hardwareSerial: String,
    @SerialName("certificate_alias") val certificateAlias: String = "",
    @SerialName("protocol_version") val protocolVersion: String,
    val manufacturer: String,
    val model: String,
    @SerialName("android_release") val androidRelease: String,
    @SerialName("android_sdk") val androidSdk: Int,
    @SerialName("app_version") val appVersion: String,
    @SerialName("build_fingerprint") val buildFingerprint: String,
)

@Serializable
data class ActivationResponse(
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_token") val deviceToken: String,
    @SerialName("websocket_url") val websocketUrl: String,
    @SerialName("heartbeat_interval_seconds") val heartbeatIntervalSeconds: Int,
    @SerialName("key_id") val keyId: String,
    @SerialName("signing_public_key_pem") val signingPublicKeyPem: String,
    val sims: List<ActivatedSim>,
)

@Serializable
data class ActivationEnvelope(
    val status: String,
    val message: String,
    val code: String,
    val data: ActivationResponse? = null,
    @SerialName("request_id") val requestId: String,
)

@Serializable
data class ActivatedSim(
    val iccid: String,
    @SerialName("telebirr_number") val telebirrNumber: String,
    @SerialName("registered_name") val registeredName: String,
    @SerialName("expected_slot_index") val expectedSlotIndex: Int,
)
