package com.telebirr.gateway.agent.protocol

import androidx.room.withTransaction
import com.telebirr.gateway.agent.crypto.CryptoEncoding
import com.telebirr.gateway.agent.db.AgentDatabase
import com.telebirr.gateway.agent.db.FinancialCommitGuardEntity
import com.telebirr.gateway.agent.db.JobExecutionEntity
import com.telebirr.gateway.agent.db.SimFenceEntity
import com.telebirr.gateway.agent.ussd.profile.FlowOperation
import com.telebirr.gateway.agent.ussd.profile.FlowProfileStore
import java.time.Clock

sealed interface JobAcceptance {
    data class Accepted(val job: DeviceJobPayload) : JobAcceptance
    data class Duplicate(val job: DeviceJobPayload, val status: JobStatus) : JobAcceptance
    data class Rejected(val code: String) : JobAcceptance
}

class JobExecutionRepository(
    private val database: AgentDatabase,
    private val decoder: SignedJobDecoder,
    private val profileStore: FlowProfileStore,
    private val expectedDeviceId: String,
    private val clock: Clock = Clock.systemUTC(),
) {
    private val dao = database.agentDao()

    suspend fun accept(envelope: SignedDeviceJobEnvelope): JobAcceptance {
        val verified = runCatching { decoder.decode(envelope) }
            .getOrElse { return JobAcceptance.Rejected("invalid_signature_or_payload") }
        val payload = verified.payload
        if (payload.deviceId != expectedDeviceId) {
            return JobAcceptance.Rejected("wrong_device")
        }
        val now = clock.millis()
        if (now > payload.leaseExpiresAtMs || now > payload.jobExpiresAtMs || payload.issuedAtMs > now + 120_000L) {
            return JobAcceptance.Rejected("expired_or_future_job")
        }
        val profile = runCatching { profileStore.load(payload.profileId, payload.profileVersion) }
            .getOrElse { return JobAcceptance.Rejected("profile_unavailable") }
        val expectedOperation = when (payload.type) {
            DeviceJobType.CUSTOMER_WITHDRAWAL -> FlowOperation.WITHDRAWAL
            DeviceJobType.UNKNOWN_RECONCILIATION -> FlowOperation.UNKNOWN_RECONCILIATION
            DeviceJobType.BALANCE_QUERY -> FlowOperation.BALANCE_QUERY
            DeviceJobType.AUTOMATIC_SWEEP -> FlowOperation.SWEEP
            DeviceJobType.MERCHANT_SETTLEMENT -> FlowOperation.SETTLEMENT
            DeviceJobType.EMERGENCY_LIQUIDITY_MOVE -> FlowOperation.EMERGENCY_LIQUIDITY_MOVE
        }
        if (profile.operation != expectedOperation) return JobAcceptance.Rejected("profile_operation_mismatch")
        val iccidHash = CryptoEncoding.sha256Hex(payload.simIccid)

        return database.withTransaction {
            dao.job(payload.jobId)?.let { existing ->
                return@withTransaction if (existing.payloadDigest == verified.payloadDigest) {
                    JobAcceptance.Duplicate(payload, JobStatus.valueOf(existing.status))
                } else {
                    JobAcceptance.Rejected("job_id_conflict")
                }
            }
            val sim = dao.simIdentity(iccidHash)
            if (sim == null || sim.state != "ACTIVE") {
                return@withTransaction JobAcceptance.Rejected("sim_not_active")
            }
            if (dao.commitGuard(payload.financialOperationId) != null) {
                return@withTransaction JobAcceptance.Rejected("financial_operation_already_committed")
            }
            val fence = dao.fence(iccidHash)
            if (fence == null) {
                dao.insertFence(SimFenceEntity(iccidHash, payload.fencingToken, now))
            } else if (payload.fencingToken <= fence.highestToken) {
                return@withTransaction JobAcceptance.Rejected("stale_fencing_token")
            } else if (dao.advanceFence(iccidHash, payload.fencingToken, now) != 1) {
                return@withTransaction JobAcceptance.Rejected("stale_fencing_token")
            }
            dao.insertJob(
                JobExecutionEntity(
                    jobId = payload.jobId,
                    financialOperationId = payload.financialOperationId,
                    type = payload.type.name,
                    simIccidHash = iccidHash,
                    profileId = payload.profileId,
                    profileVersion = payload.profileVersion,
                    attempt = payload.attempt,
                    fencingToken = payload.fencingToken,
                    leaseExpiresAtMs = payload.leaseExpiresAtMs,
                    jobExpiresAtMs = payload.jobExpiresAtMs,
                    payloadDigest = verified.payloadDigest,
                    status = JobStatus.ACCEPTED.name,
                    acceptedAtMs = now,
                    committedAtMs = null,
                    terminalAtMs = null,
                ),
            )
            JobAcceptance.Accepted(payload)
        }
    }

    suspend fun start(jobId: String): Boolean = database.withTransaction {
        val job = dao.job(jobId) ?: return@withTransaction false
        val currentFence = dao.fence(job.simIccidHash) ?: return@withTransaction false
        if (job.fencingToken != currentFence.highestToken || job.leaseExpiresAtMs <= clock.millis()) {
            return@withTransaction false
        }
        dao.transitionJob(jobId, JobStatus.ACCEPTED.name, JobStatus.DEVICE_STARTED.name, null) == 1
    }

    /** Durable operation guard is inserted before Accessibility receives the PIN. */
    suspend fun markPinSubmitted(jobId: String): Boolean = database.withTransaction {
        val job = dao.job(jobId) ?: return@withTransaction false
        if (job.status != JobStatus.DEVICE_STARTED.name || job.committedAtMs != null) return@withTransaction false
        val fence = dao.fence(job.simIccidHash) ?: return@withTransaction false
        if (fence.highestToken != job.fencingToken || job.leaseExpiresAtMs <= clock.millis()) {
            return@withTransaction false
        }
        val existing = dao.commitGuard(job.financialOperationId)
        if (existing != null) return@withTransaction existing.jobId == jobId
        val now = clock.millis()
        dao.insertCommitGuard(FinancialCommitGuardEntity(job.financialOperationId, jobId, now))
        check(dao.markJobCommitted(jobId, now) == 1)
        true
    }

    suspend fun markProviderPending(jobId: String): Boolean =
        dao.transitionJob(jobId, JobStatus.PIN_SUBMITTED.name, JobStatus.PROVIDER_PENDING.name, null) == 1

    suspend fun markTerminal(jobId: String, outcome: JobStatus): Boolean {
        require(outcome in setOf(JobStatus.SUCCESS, JobStatus.FAILED, JobStatus.UNKNOWN))
        val job = dao.job(jobId) ?: return false
        val allowed = when (job.status) {
            JobStatus.PIN_SUBMITTED.name, JobStatus.PROVIDER_PENDING.name -> true
            JobStatus.DEVICE_STARTED.name ->
                outcome == JobStatus.FAILED || job.type == DeviceJobType.BALANCE_QUERY.name
            else -> false
        }
        if (!allowed) return false
        return dao.transitionJob(jobId, job.status, outcome.name, clock.millis()) == 1
    }

    suspend fun cancelBeforeStart(jobId: String): Boolean =
        dao.transitionJob(jobId, JobStatus.ACCEPTED.name, JobStatus.CANCELLED.name, clock.millis()) == 1

    suspend fun renewLease(jobId: String, fencingToken: Long, leaseExpiresAtMs: Long): Boolean {
        val now = clock.millis()
        if (leaseExpiresAtMs <= now || leaseExpiresAtMs - now > 10 * 60_000L) return false
        return dao.renewJobLease(jobId, fencingToken, leaseExpiresAtMs) == 1
    }

    suspend fun renewLease(envelope: SignedLeaseRenewalEnvelope): JobLeaseRenewalPayload? {
        val renewal = runCatching { decoder.decodeRenewal(envelope) }.getOrElse { return null }
        if (renewal.deviceId != expectedDeviceId) return null
        if (renewal.issuedAtMs > clock.millis() + 120_000L) return null
        return renewal.takeIf {
            renewLease(renewal.jobId, renewal.fencingToken, renewal.leaseExpiresAtMs)
        }
    }

    /**
     * Process death discards the in-memory Accessibility session. A persisted
     * commit is therefore `unknown`; a persisted pre-commit job is safely failed.
     */
    suspend fun recoverOrphanedJobs(activeJobId: String?): List<RecoveredJob> {
        val recovered = mutableListOf<RecoveredJob>()
        database.withTransaction {
            dao.nonTerminalJobs().filterNot { it.jobId == activeJobId }.forEach { job ->
                val committed = job.committedAtMs != null || job.status in setOf(
                    JobStatus.PIN_SUBMITTED.name,
                    JobStatus.PROVIDER_PENDING.name,
                )
                val next = if (committed) JobStatus.UNKNOWN else JobStatus.FAILED
                if (dao.transitionJob(job.jobId, job.status, next.name, clock.millis()) == 1) {
                    recovered += RecoveredJob(
                        job.jobId,
                        job.financialOperationId,
                        job.fencingToken,
                        next,
                    )
                }
            }
        }
        return recovered
    }

    suspend fun canAutomaticallyRetry(jobId: String): Boolean {
        val job = dao.job(jobId) ?: return false
        return JobSafetyPolicy.canAutomaticallyRetry(JobStatus.valueOf(job.status), job.committedAtMs)
    }

    /** Fail-closed local quarantine for a carrier/OEM dialog that blocks safe cleanup. */
    suspend fun quarantineSimForJob(jobId: String): Boolean = database.withTransaction {
        val job = dao.job(jobId) ?: return@withTransaction false
        dao.quarantineSim(job.simIccidHash, clock.millis()) == 1
    }
}

data class RecoveredJob(
    val jobId: String,
    val financialOperationId: String,
    val fencingToken: Long,
    val status: JobStatus,
)

object JobSafetyPolicy {
    fun canAutomaticallyRetry(status: JobStatus, committedAtMs: Long?): Boolean =
        committedAtMs == null && status in setOf(JobStatus.ACCEPTED, JobStatus.FAILED)

    fun canPlatformCancel(status: JobStatus): Boolean = status == JobStatus.ACCEPTED
}
