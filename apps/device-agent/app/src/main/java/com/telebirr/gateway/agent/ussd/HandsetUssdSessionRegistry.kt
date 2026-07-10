package com.telebirr.gateway.agent.ussd

import com.telebirr.gateway.agent.protocol.DeviceJobPayload
import com.telebirr.gateway.agent.protocol.DeviceJobType
import com.telebirr.gateway.agent.protocol.JobExecutionRepository
import com.telebirr.gateway.agent.protocol.JobStatus
import com.telebirr.gateway.agent.sms.BalanceQueryLeaseRepository
import com.telebirr.gateway.agent.sms.OutgoingSmsSessionMatcher
import com.telebirr.gateway.agent.sms.ParsedTelebirrSms
import com.telebirr.gateway.agent.storage.SpoolRepository
import com.telebirr.gateway.agent.ussd.profile.FlowProfileStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Clock
import java.util.concurrent.atomic.AtomicLong

data class ActiveUssdSession(
    val job: DeviceJobPayload,
    val machine: UssdStateMachine,
    val startedAtMs: Long,
    var leaseExpiresAtMs: Long,
    var committedAtMs: Long? = null,
    var blockedAndQuarantined: Boolean = false,
)

/** Exactly one process-wide lease, deliberately shared by both SIM subscriptions. */
class HandsetUssdSessionRegistry(
    private val profileStore: FlowProfileStore,
    private val jobs: JobExecutionRepository,
    private val balanceLeases: BalanceQueryLeaseRepository,
    private val spool: SpoolRepository,
    private val clock: Clock = Clock.systemUTC(),
) {
    private val handsetMutex = Mutex()
    private val eventMutex = Mutex()
    @Volatile private var activeSession: ActiveUssdSession? = null
    private val processingDismissAuthorizedUntilMs = AtomicLong(0)

    suspend fun begin(job: DeviceJobPayload): Boolean {
        val dismissDeadline = processingDismissAuthorizedUntilMs.get()
        if (clock.millis() <= dismissDeadline) return false
        processingDismissAuthorizedUntilMs.compareAndSet(dismissDeadline, 0)
        if (!handsetMutex.tryLock(job.jobId)) return false
        return runCatching {
            check(activeSession == null)
            val profile = profileStore.load(job.profileId, job.profileVersion)
            val context = if (
                job.type == DeviceJobType.BALANCE_QUERY ||
                job.type == DeviceJobType.UNKNOWN_RECONCILIATION
            ) {
                // Balance profiles never consume these fields, but a valid inert
                // context keeps the generic engine free of nullable money inputs.
                UssdJobContext("0910000000", "1.00", "BALANCE QUERY")
            } else {
                UssdJobContext(
                    requireNotNull(job.destinationPhone),
                    requireNotNull(job.amountEtb),
                    requireNotNull(job.expectedReceiverName),
                    job.approvedProviderName,
                )
            }
            activeSession = ActiveUssdSession(
                job,
                UssdStateMachine(profile, context),
                clock.millis(),
                job.leaseExpiresAtMs,
            )
            true
        }.getOrElse {
            handsetMutex.unlock(job.jobId)
            false
        }
    }

    fun current(): ActiveUssdSession? = activeSession

    suspend fun reportStarted(): Boolean = eventMutex.withLock {
        val session = activeSession ?: return@withLock false
        runCatching {
            enqueueStatus(session, JobStatus.DEVICE_STARTED, "ussd_session_started")
            true
        }.getOrDefault(false)
    }

    suspend fun onScreen(rawScreen: String): PlannedUssdCommand? = eventMutex.withLock {
        val session = activeSession ?: return@withLock null
        if (session.blockedAndQuarantined) return@withLock null
        if (clock.millis() > session.leaseExpiresAtMs && !session.machine.committed) {
            finishLocked(JobStatus.FAILED, "lease_expired_pre_commit")
            return@withLock null
        }
        session.machine.plan(rawScreen)
    }

    suspend fun beforeFinancialPin(commandId: String): Boolean = eventMutex.withLock {
        val session = activeSession ?: return@withLock false
        if (!jobs.markPinSubmitted(session.job.jobId)) return@withLock false
        return@withLock runCatching {
            session.machine.markCommittedBeforeDispatch(commandId)
            session.committedAtMs = clock.millis()
            enqueueStatus(session, JobStatus.PIN_SUBMITTED, "pin_submitted")
            true
        }.getOrElse {
            jobs.markTerminal(session.job.jobId, JobStatus.UNKNOWN)
            blockAndQuarantineLocked(session, "commit_state_desync")
            false
        }
    }

    suspend fun acknowledge(plan: PlannedUssdCommand) = eventMutex.withLock {
        val session = activeSession ?: return@withLock
        session.machine.acknowledgeDispatched(plan.commandId)
        when (plan.command) {
            is UssdCommand.SubmitLocalPin -> {
                if (plan.command.financialCommit) {
                    jobs.markProviderPending(session.job.jobId)
                    enqueueStatus(session, JobStatus.PROVIDER_PENDING, "provider_pending")
                } else if (session.job.type == DeviceJobType.BALANCE_QUERY) {
                    balanceLeases.open(com.telebirr.gateway.agent.crypto.CryptoEncoding.sha256Hex(session.job.simIccid))
                }
            }
            UssdCommand.ProviderSuccess -> finishLocked(JobStatus.SUCCESS, "ussd_success")
            UssdCommand.ProviderFailure -> finishLocked(JobStatus.FAILED, "ussd_failure")
            else -> Unit
        }
    }

    suspend fun dispatchFailed(plan: PlannedUssdCommand) = eventMutex.withLock {
        val session = activeSession ?: return@withLock
        val outcome = session.machine.dispatchFailed(plan.commandId)
        val status = if (outcome.command is UssdCommand.UnknownPostCommit) JobStatus.UNKNOWN else JobStatus.FAILED
        if (status == JobStatus.UNKNOWN) {
            blockAndQuarantineLocked(session, "post_commit_dispatch_failed")
        } else {
            finishLocked(status, outcome.command.javaClass.simpleName)
        }
    }

    suspend fun finishForSafety(command: UssdCommand) = eventMutex.withLock {
        val session = activeSession ?: return@withLock
        if (command is UssdCommand.UnknownPostCommit) {
            jobs.quarantineSimForJob(session.job.jobId)
        }
        val status = when (command) {
            is UssdCommand.UnknownPostCommit -> JobStatus.UNKNOWN
            UssdCommand.ProviderSuccess -> JobStatus.SUCCESS
            UssdCommand.ProviderFailure -> JobStatus.FAILED
            else -> JobStatus.FAILED
        }
        val providerName = when (command) {
            is UssdCommand.RequestNameReview -> command.providerName
            is UssdCommand.ReceiverMismatch -> command.providerName
            else -> null
        }
        // An uncertain name is a deliberate pre-commit cancellation whose
        // reservation stays held for staff review and a newly fenced attempt.
        // A deterministic mismatch remains an explicit pre-commit failure.
        val reportedStatus = if (command is UssdCommand.RequestNameReview) JobStatus.CANCELLED else status
        finishLocked(status, command.javaClass.simpleName, providerName, reportedStatus)
    }

    /**
     * A carrier/OEM modal that cannot be dismissed must never release the
     * handset mutex. Persist the financial outcome, quarantine the SIM, and keep
     * this in-memory blocker until operator recovery or process restart (the
     * durable SIM quarantine survives restart).
     */
    suspend fun blockAndQuarantine(reason: String) = eventMutex.withLock {
        val session = activeSession ?: return@withLock
        blockAndQuarantineLocked(session, reason)
    }

    suspend fun failBeforeStart(reason: String) = eventMutex.withLock {
        finishLocked(JobStatus.FAILED, reason)
    }

    suspend fun cancelAccepted(reason: String) = eventMutex.withLock {
        val session = activeSession ?: return@withLock
        jobs.cancelBeforeStart(session.job.jobId)
        finishLocked(null, reason, reportedStatus = JobStatus.CANCELLED)
    }

    suspend fun completeBalanceFromSms(
        simIccidHash: String,
        success: Boolean,
        providerTransactionId: String?,
    ): Boolean = eventMutex.withLock {
        val session = activeSession ?: return@withLock false
        if (session.blockedAndQuarantined) return@withLock false
        val activeHash = com.telebirr.gateway.agent.crypto.CryptoEncoding.sha256Hex(session.job.simIccid)
        if (activeHash != simIccidHash) return@withLock false
        if (session.job.type != DeviceJobType.BALANCE_QUERY) return@withLock false
        processingDismissAuthorizedUntilMs.set(clock.millis() + PROCESSING_DISMISS_WINDOW_MS)
        finishLocked(
            if (success) JobStatus.SUCCESS else JobStatus.FAILED,
            "sms_confirmation",
            providerTransactionId = providerTransactionId,
        )
        true
    }

    /**
     * A 127 SMS always remains encrypted/uploaded by the receiver. It releases
     * this handset-wide session only when every signed financial attribute has a
     * strong deterministic match and its receipt time is plausible after commit.
     */
    suspend fun completeFromOutgoingSms(
        simIccidHash: String,
        parsed: ParsedTelebirrSms.OutgoingTransfer,
        receivedAtMs: Long,
    ): Boolean = eventMutex.withLock {
        val session = activeSession ?: return@withLock false
        if (session.blockedAndQuarantined) return@withLock false
        val activeHash = com.telebirr.gateway.agent.crypto.CryptoEncoding.sha256Hex(session.job.simIccid)
        if (activeHash != simIccidHash || !session.machine.committed) return@withLock false
        val committedAt = session.committedAtMs ?: return@withLock false
        if (!OutgoingSmsSessionMatcher.stronglyMatches(session.job, committedAt, receivedAtMs, parsed)) {
            return@withLock false
        }
        processingDismissAuthorizedUntilMs.set(clock.millis() + PROCESSING_DISMISS_WINDOW_MS)
        finishLocked(
            if (parsed.outcome == ParsedTelebirrSms.Outcome.SUCCESS) JobStatus.SUCCESS else JobStatus.FAILED,
            "sms_confirmation_strong_match",
            providerTransactionId = parsed.providerTransactionId,
        )
        true
    }

    /** One-shot authorization for a processing modal that raced a valid SMS. */
    fun consumeProcessingDismissAuthorization(rawScreen: String): Boolean {
        val now = clock.millis()
        val deadline = processingDismissAuthorizedUntilMs.get()
        if (now > deadline) return false
        val normalized = UssdScreenParser.normalize(rawScreen)
        if (listOf("PROCESS", "WAIT", "REQUEST", "SMS").none(normalized::contains)) return false
        return processingDismissAuthorizedUntilMs.compareAndSet(deadline, 0)
    }

    suspend fun expireIfNeeded() = eventMutex.withLock {
        val session = activeSession ?: return@withLock
        if (session.blockedAndQuarantined) return@withLock
        if (clock.millis() <= session.leaseExpiresAtMs) return@withLock
        if (session.machine.committed) {
            blockAndQuarantineLocked(session, "post_commit_result_timeout")
        } else {
            finishLocked(JobStatus.FAILED, "pre_commit_lease_expired")
        }
    }

    suspend fun renewLease(jobId: String, leaseExpiresAtMs: Long): Boolean = eventMutex.withLock {
        val session = activeSession ?: return@withLock false
        if (session.blockedAndQuarantined) return@withLock false
        if (session.job.jobId != jobId || leaseExpiresAtMs <= session.leaseExpiresAtMs) return@withLock false
        session.leaseExpiresAtMs = leaseExpiresAtMs
        true
    }

    suspend fun interrupted() = eventMutex.withLock {
        val session = activeSession ?: return@withLock
        if (session.blockedAndQuarantined) return@withLock
        if (session.machine.committed) {
            blockAndQuarantineLocked(session, "accessibility_interrupted_post_commit")
        } else {
            finishLocked(JobStatus.FAILED, "accessibility_interrupted")
        }
    }

    private suspend fun finishLocked(
        status: JobStatus?,
        reason: String,
        providerName: String? = null,
        reportedStatus: JobStatus? = status,
        providerTransactionId: String? = null,
    ) {
        val session = activeSession ?: return
        status?.let { jobs.markTerminal(session.job.jobId, it) }
        runCatching {
            enqueueStatus(
                session,
                reportedStatus,
                reason,
                providerName,
                providerTransactionId,
            )
        }
        activeSession = null
        handsetMutex.unlock(session.job.jobId)
    }

    private suspend fun blockAndQuarantineLocked(session: ActiveUssdSession, reason: String) {
        if (session.blockedAndQuarantined) return
        val outcome = if (session.machine.committed) JobStatus.UNKNOWN else JobStatus.FAILED
        jobs.markTerminal(session.job.jobId, outcome)
        jobs.quarantineSimForJob(session.job.jobId)
        runCatching { enqueueStatus(session, outcome, reason) }
        session.blockedAndQuarantined = true
    }

    private suspend fun enqueueStatus(
        session: ActiveUssdSession,
        status: JobStatus?,
        reason: String,
        providerName: String? = null,
        providerTransactionId: String? = null,
    ) {
        val observedAt = clock.millis()
        val event = buildJsonObject {
            put("job_id", session.job.jobId)
            put("financial_operation_id", session.job.financialOperationId)
            put("fencing_token", session.job.fencingToken)
            put("state", status?.wireName ?: "unknown")
            put("observed_at_ms", observedAt)
            put("error_code", reason)
            put("attempt", session.job.attempt)
            put("profile_id", session.job.profileId)
            put("profile_version", session.job.profileVersion)
            put("provider_transaction_id", providerTransactionId)
            if (providerName != null) {
                // The backend advisory call receives exactly these two names; raw
                // USSD evidence remains a separately authorized support artifact.
                put("expected_receiver_name", session.job.expectedReceiverName)
                put("provider_receiver_name", providerName)
            }
        }.toString().toByteArray()
        spool.enqueue("JOB_STATUS", event)
    }

    companion object {
        private const val PROCESSING_DISMISS_WINDOW_MS = 60_000L
    }
}
