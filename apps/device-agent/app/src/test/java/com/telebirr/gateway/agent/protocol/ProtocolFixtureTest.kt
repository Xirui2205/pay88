package com.telebirr.gateway.agent.protocol

import com.telebirr.gateway.agent.activation.ActivationEnvelope
import com.telebirr.gateway.agent.crypto.PayloadVerifier
import com.telebirr.gateway.agent.crypto.CryptoEncoding
import com.telebirr.gateway.agent.ussd.profile.FlowOperation
import com.telebirr.gateway.agent.ussd.profile.FlowProfileVerifier
import com.telebirr.gateway.agent.ussd.profile.SignedFlowProfileEnvelope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class ProtocolFixtureTest {
    private val json = Json { ignoreUnknownKeys = false }
    private val fixtureText = requireNotNull(
        javaClass.classLoader?.getResourceAsStream("protocol/device-protocol-v1.json"),
    ).bufferedReader().use { it.readText() }
    private val fixture = json.parseToJsonElement(fixtureText).jsonObject
    private val keyId = requireNotNull(fixture["key_id"]).jsonPrimitive.content
    private val verifier = PayloadVerifier.fromPem(
        requireNotNull(fixture["signing_public_key_pem"]).jsonPrimitive.content,
    )

    @Test
    fun `standard activation envelope decodes device token websocket key and sims`() {
        val envelope = json.decodeFromJsonElement<ActivationEnvelope>(
            requireNotNull(fixture["activation_response"]),
        )
        val data = requireNotNull(envelope.data)
        assertEquals("success", envelope.status)
        assertEquals("ok", envelope.code)
        assertEquals(keyId, data.keyId)
        assertTrue(data.websocketUrl.startsWith("wss://"))
        assertEquals(2, data.sims.size)
    }

    @Test
    fun `P-256 signed job decodes exact numeric fence and expiry fields`() {
        val envelope = json.decodeFromJsonElement<SignedDeviceJobEnvelope>(
            requireNotNull(fixture["signed_job_envelope"]),
        )
        val expected = json.decodeFromJsonElement<DeviceJobPayload>(
            requireNotNull(fixture["decoded_job_payload"]),
        )
        val decoded = SignedJobDecoder(verifier, keyId).decode(envelope).payload
        assertEquals(expected, decoded)
        assertEquals(DeviceJobType.CUSTOMER_WITHDRAWAL, decoded.type)
        assertEquals(42L, decoded.fencingToken)
        assertTrue(decoded.jobExpiresAtMs > decoded.leaseExpiresAtMs)
    }

    @Test
    fun `signed profile includes observed transcript steps and one PIN commit point`() {
        val envelope = json.decodeFromJsonElement<SignedFlowProfileEnvelope>(
            requireNotNull(fixture["signed_profile_envelope"]),
        )
        val profile = FlowProfileVerifier(verifier, keyId).verify(envelope).profile
        assertEquals("telebirr.send-money.v1", profile.profileId)
        assertEquals(FlowOperation.WITHDRAWAL, profile.operation)
        assertEquals(
            listOf(
                "main-send-menu", "send-submenu", "destination", "verify-recipient",
                "amount", "comment", "final-confirm", "pin", "provider-result",
            ),
            profile.steps.map { it.id },
        )
        assertEquals(listOf("pin"), profile.steps.filter { it.response.financialCommit }.map { it.id })
    }

    @Test
    fun `signed lease renewal is bound to device job and numeric fence`() {
        val envelope = json.decodeFromJsonElement<SignedLeaseRenewalEnvelope>(
            requireNotNull(fixture["signed_lease_renewal_envelope"]),
        )
        val expected = json.decodeFromJsonElement<JobLeaseRenewalPayload>(
            requireNotNull(fixture["decoded_lease_renewal_payload"]),
        )
        assertEquals(expected, SignedJobDecoder(verifier, keyId).decodeRenewal(envelope))
    }

    @Test
    fun `tampered exact job payload is rejected`() {
        val envelope = json.decodeFromJsonElement<SignedDeviceJobEnvelope>(
            requireNotNull(fixture["signed_job_envelope"]),
        )
        val bytes = CryptoEncoding.base64Decode(envelope.payloadBase64)
        bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
        val tampered = envelope.copy(payloadBase64 = CryptoEncoding.base64(bytes))
        assertThrows(IllegalArgumentException::class.java) {
            SignedJobDecoder(verifier, keyId).decode(tampered)
        }
    }
}
