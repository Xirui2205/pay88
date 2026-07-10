package com.telebirr.gateway.agent.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "spool_events",
    indices = [
        Index(value = ["id"], unique = true),
        Index("nextAttemptAtMs"),
        Index("acknowledgedAtMs"),
    ],
)
data class SpoolEventEntity(
    val id: String,
    val kind: String,
    val payloadIv: ByteArray,
    val payloadCiphertext: ByteArray,
    val createdAtMs: Long,
    val attemptCount: Int,
    val nextAttemptAtMs: Long,
    val acknowledgedAtMs: Long?,
    @PrimaryKey(autoGenerate = true) val sequence: Long = 0,
    val corruptAtMs: Long? = null,
    val corruptReason: String? = null,
)

@Entity(
    tableName = "job_executions",
    indices = [
        Index("financialOperationId"),
        Index(value = ["simIccidHash", "fencingToken"]),
        Index("status"),
    ],
)
data class JobExecutionEntity(
    @PrimaryKey val jobId: String,
    val financialOperationId: String,
    val type: String,
    val simIccidHash: String,
    val profileId: String,
    val profileVersion: Int,
    val attempt: Int,
    val fencingToken: Long,
    val leaseExpiresAtMs: Long,
    val jobExpiresAtMs: Long,
    val payloadDigest: String,
    val status: String,
    val acceptedAtMs: Long,
    val committedAtMs: Long?,
    val terminalAtMs: Long?,
)

@Entity(tableName = "sim_fences")
data class SimFenceEntity(
    @PrimaryKey val simIccidHash: String,
    val highestToken: Long,
    val updatedAtMs: Long,
)

/** A primary key on operation ID is the durable one-commit invariant. */
@Entity(tableName = "financial_commit_guards", indices = [Index(value = ["jobId"], unique = true)])
data class FinancialCommitGuardEntity(
    @PrimaryKey val financialOperationId: String,
    val jobId: String,
    val committedAtMs: Long,
)

@Entity(
    tableName = "sms_evidence",
    indices = [
        Index(value = ["providerTransactionId"], unique = true),
        Index(value = ["spoolEventId"], unique = true),
        Index("receivedAtMs"),
    ],
)
data class SmsEvidenceEntity(
    @PrimaryKey val messageDigest: String,
    val providerTransactionId: String?,
    val simIccidHash: String,
    val sender: String,
    val rawIv: ByteArray,
    val rawCiphertext: ByteArray,
    val parsedType: String,
    val receivedAtMs: Long,
    val uploadedAtMs: Long?,
    val spoolEventId: String?,
)

@Entity(tableName = "balance_snapshots", indices = [Index("capturedAtMs")])
data class BalanceSnapshotEntity(
    @PrimaryKey val simIccidHash: String,
    val customerMinor: Long?,
    val incentiveMinor: Long?,
    val fuelMinor: Long?,
    val pocketMoneyMinor: Long?,
    val capturedAtMs: Long,
    val sourceMessageDigest: String,
    val sourceKind: String,
)

@Entity(tableName = "sim_identities", indices = [Index(value = ["slotIndex"], unique = false)])
data class SimIdentityEntity(
    @PrimaryKey val iccidHash: String,
    val iccidIv: ByteArray,
    val iccidCiphertext: ByteArray,
    val enrolledNumber: String,
    val normalizedAccountName: String,
    val expectedSlotIndex: Int,
    val slotIndex: Int,
    val subscriptionId: Int?,
    val state: String,
    val updatedAtMs: Long,
)

@Entity(
    tableName = "balance_query_leases",
    indices = [Index(value = ["simIccidHash", "expiresAtMs"]), Index("status")],
)
data class BalanceQueryLeaseEntity(
    @PrimaryKey val leaseId: String,
    val simIccidHash: String,
    val createdAtMs: Long,
    val expiresAtMs: Long,
    val status: String,
    val correlatedMessageDigest: String?,
)
