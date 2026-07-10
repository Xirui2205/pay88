package com.telebirr.gateway.agent.protocol

import com.telebirr.gateway.agent.crypto.CryptoEncoding
import com.telebirr.gateway.agent.crypto.PayloadVerifier
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

data class VerifiedDeviceJob(
    val payload: DeviceJobPayload,
    val payloadDigest: String,
    val exactPayload: ByteArray,
)

class SignedJobDecoder(
    private val verifier: PayloadVerifier,
    private val acceptedKeyId: String,
    private val json: Json = Json { ignoreUnknownKeys = false },
) {
    fun decode(envelope: SignedDeviceJobEnvelope): VerifiedDeviceJob {
        require(envelope.keyId == acceptedKeyId) { "Unexpected job signing key" }
        require(envelope.payloadBase64.length in 4..24_000) { "Job payload is too large" }
        require(envelope.signatureBase64.length in 4..1_024) { "Job signature is too large" }
        val payloadBytes = CryptoEncoding.base64Decode(envelope.payloadBase64)
        require(verifier.verify(payloadBytes, CryptoEncoding.base64Decode(envelope.signatureBase64))) {
            "Invalid job signature"
        }
        return VerifiedDeviceJob(
            payload = json.decodeFromString<DeviceJobPayload>(payloadBytes.decodeToString()).validated(),
            payloadDigest = CryptoEncoding.sha256(payloadBytes).joinToString("") {
                (it.toInt() and 0xff).toString(16).padStart(2, '0')
            },
            exactPayload = payloadBytes,
        )
    }

    fun decodeRenewal(envelope: SignedLeaseRenewalEnvelope): JobLeaseRenewalPayload {
        require(envelope.keyId == acceptedKeyId) { "Unexpected job signing key" }
        require(envelope.payloadBase64.length in 4..8_000)
        require(envelope.signatureBase64.length in 4..1_024)
        val payloadBytes = CryptoEncoding.base64Decode(envelope.payloadBase64)
        require(verifier.verify(payloadBytes, CryptoEncoding.base64Decode(envelope.signatureBase64))) {
            "Invalid lease-renewal signature"
        }
        return json.decodeFromString<JobLeaseRenewalPayload>(payloadBytes.decodeToString()).also {
            require(it.jobId.isNotBlank() && it.deviceId.isNotBlank() && it.fencingToken > 0)
            require(it.leaseExpiresAtMs > it.issuedAtMs)
            require(it.leaseExpiresAtMs - it.issuedAtMs <= 10 * 60_000L)
        }
    }
}
