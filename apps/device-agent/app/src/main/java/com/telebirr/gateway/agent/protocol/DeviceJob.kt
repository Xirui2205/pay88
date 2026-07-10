package com.telebirr.gateway.agent.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import com.telebirr.gateway.agent.sim.EthiopianPhoneNumber
import java.math.BigDecimal

@Serializable
enum class DeviceJobType {
    @SerialName("customer_withdrawal") CUSTOMER_WITHDRAWAL,
    @SerialName("unknown_reconciliation") UNKNOWN_RECONCILIATION,
    @SerialName("merchant_settlement") MERCHANT_SETTLEMENT,
    @SerialName("emergency_liquidity_move") EMERGENCY_LIQUIDITY_MOVE,
    @SerialName("automatic_sweep") AUTOMATIC_SWEEP,
    @SerialName("balance_query") BALANCE_QUERY,
}

@Serializable
data class DeviceJobPayload(
    @SerialName("job_id") val jobId: String,
    @SerialName("device_id") val deviceId: String,
    @SerialName("financial_operation_id") val financialOperationId: String,
    val type: DeviceJobType,
    @SerialName("sim_iccid") val simIccid: String,
    @SerialName("profile_id") val profileId: String,
    @SerialName("profile_version") val profileVersion: Int,
    val attempt: Int,
    @SerialName("fencing_token") val fencingToken: Long,
    @SerialName("issued_at_ms") val issuedAtMs: Long,
    @SerialName("lease_expires_at_ms") val leaseExpiresAtMs: Long,
    @SerialName("job_expires_at_ms") val jobExpiresAtMs: Long,
    @SerialName("destination_phone") val destinationPhone: String? = null,
    @SerialName("amount_etb") val amountEtb: String? = null,
    @SerialName("expected_receiver_name") val expectedReceiverName: String? = null,
    @SerialName("approved_provider_name") val approvedProviderName: String? = null,
) {
    fun validated(): DeviceJobPayload = apply {
        require(jobId.matches(Regex("[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}")))
        require(deviceId.matches(Regex("[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}")))
        require(financialOperationId.matches(Regex("[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}")))
        require(simIccid.matches(Regex("[0-9]{10,24}")))
        require(profileId.matches(Regex("[a-z0-9][a-z0-9._-]{2,63}")))
        require(profileVersion > 0 && attempt > 0 && fencingToken > 0)
        require(issuedAtMs > 0)
        require(leaseExpiresAtMs > issuedAtMs)
        require(leaseExpiresAtMs - issuedAtMs <= 10 * 60_000L) { "Job lease is too long" }
        require(jobExpiresAtMs >= leaseExpiresAtMs)
        require(jobExpiresAtMs - issuedAtMs <= 24 * 60 * 60_000L)
        if (
            type == DeviceJobType.CUSTOMER_WITHDRAWAL ||
            type == DeviceJobType.MERCHANT_SETTLEMENT ||
            type == DeviceJobType.EMERGENCY_LIQUIDITY_MOVE ||
            type == DeviceJobType.AUTOMATIC_SWEEP
        ) {
            requireNotNull(destinationPhone)
            EthiopianPhoneNumber.normalize(destinationPhone)
            requireNotNull(amountEtb)
            require(Regex("[0-9]+\\.[0-9]{2}").matches(amountEtb))
            require(BigDecimal(amountEtb).signum() > 0)
            require(!expectedReceiverName.isNullOrBlank())
            require(approvedProviderName == null || approvedProviderName.isNotBlank())
        }
    }
}

@Serializable
data class SignedDeviceJobEnvelope(
    @SerialName("key_id") val keyId: String,
    @SerialName("payload_base64") val payloadBase64: String,
    @SerialName("signature_base64") val signatureBase64: String,
)

@Serializable
data class JobLeaseRenewalPayload(
    @SerialName("job_id") val jobId: String,
    @SerialName("device_id") val deviceId: String,
    @SerialName("fencing_token") val fencingToken: Long,
    @SerialName("issued_at_ms") val issuedAtMs: Long,
    @SerialName("lease_expires_at_ms") val leaseExpiresAtMs: Long,
)

@Serializable
data class SignedLeaseRenewalEnvelope(
    @SerialName("key_id") val keyId: String,
    @SerialName("payload_base64") val payloadBase64: String,
    @SerialName("signature_base64") val signatureBase64: String,
)

enum class JobStatus {
    ACCEPTED,
    DEVICE_STARTED,
    PIN_SUBMITTED,
    PROVIDER_PENDING,
    SUCCESS,
    FAILED,
    UNKNOWN,
    CANCELLED,
    ;

    val wireName: String
        get() = when (this) {
            ACCEPTED -> "leased"
            DEVICE_STARTED -> "device_started"
            PIN_SUBMITTED -> "committed"
            PROVIDER_PENDING -> "provider_pending"
            SUCCESS -> "succeeded"
            FAILED -> "failed"
            UNKNOWN -> "unknown"
            CANCELLED -> "cancelled"
        }
}
