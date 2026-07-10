package com.telebirr.gateway.agent.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update

@Dao
interface AgentDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertSpool(event: SpoolEventEntity)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertSpoolIfAbsent(event: SpoolEventEntity): Long

    @Query("SELECT * FROM spool_events WHERE id = :id")
    suspend fun spoolEvent(id: String): SpoolEventEntity?

    @Query(
        """
        SELECT * FROM spool_events AS candidate
        WHERE candidate.acknowledgedAtMs IS NULL
          AND candidate.corruptAtMs IS NULL
          AND candidate.nextAttemptAtMs <= :now
          AND NOT EXISTS (
              SELECT 1 FROM spool_events AS blocker
              WHERE blocker.acknowledgedAtMs IS NULL
                AND blocker.corruptAtMs IS NULL
                AND blocker.sequence < candidate.sequence
                AND blocker.nextAttemptAtMs > :now
          )
        ORDER BY candidate.sequence
        LIMIT :limit
        """,
    )
    suspend fun pendingSpool(now: Long, limit: Int): List<SpoolEventEntity>

    @Query("UPDATE spool_events SET corruptAtMs = :now, corruptReason = :reason WHERE id = :id AND corruptAtMs IS NULL")
    suspend fun markSpoolCorrupt(id: String, now: Long, reason: String): Int

    @Query("UPDATE spool_events SET acknowledgedAtMs = :now WHERE id IN (:ids) AND acknowledgedAtMs IS NULL")
    suspend fun acknowledgeSpool(ids: List<String>, now: Long): Int

    @Query("UPDATE sms_evidence SET uploadedAtMs = :now WHERE uploadedAtMs IS NULL AND spoolEventId IN (:ids) AND EXISTS (SELECT 1 FROM spool_events WHERE spool_events.id = sms_evidence.spoolEventId AND spool_events.acknowledgedAtMs IS NOT NULL)")
    suspend fun markSmsEvidenceUploaded(ids: List<String>, now: Long): Int

    @Transaction
    suspend fun acknowledgeSpoolAndSms(ids: List<String>, now: Long): Int {
        val acknowledged = acknowledgeSpool(ids, now)
        markSmsEvidenceUploaded(ids, now)
        return acknowledged
    }

    @Query("UPDATE spool_events SET attemptCount = attemptCount + 1, nextAttemptAtMs = :nextAttemptAt WHERE id = :id AND acknowledgedAtMs IS NULL")
    suspend fun deferSpool(id: String, nextAttemptAt: Long): Int

    @Query("DELETE FROM spool_events WHERE acknowledgedAtMs IS NOT NULL AND acknowledgedAtMs < :before")
    suspend fun deleteAcknowledgedSpool(before: Long): Int

    @Query("SELECT * FROM job_executions WHERE jobId = :jobId")
    suspend fun job(jobId: String): JobExecutionEntity?

    @Query("SELECT * FROM job_executions WHERE status IN ('ACCEPTED', 'DEVICE_STARTED', 'PIN_SUBMITTED', 'PROVIDER_PENDING')")
    suspend fun nonTerminalJobs(): List<JobExecutionEntity>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertJob(job: JobExecutionEntity)

    @Update
    suspend fun updateJob(job: JobExecutionEntity): Int

    @Query("SELECT * FROM sim_fences WHERE simIccidHash = :iccidHash")
    suspend fun fence(iccidHash: String): SimFenceEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertFence(fence: SimFenceEntity): Long

    @Query("UPDATE sim_fences SET highestToken = :token, updatedAtMs = :now WHERE simIccidHash = :iccidHash AND highestToken < :token")
    suspend fun advanceFence(iccidHash: String, token: Long, now: Long): Int

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertCommitGuard(guard: FinancialCommitGuardEntity)

    @Query("SELECT * FROM financial_commit_guards WHERE financialOperationId = :operationId")
    suspend fun commitGuard(operationId: String): FinancialCommitGuardEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertSmsEvidence(evidence: SmsEvidenceEntity): Long

    @Query("SELECT * FROM sms_evidence WHERE messageDigest = :digest")
    suspend fun smsEvidence(digest: String): SmsEvidenceEntity?

    @Query("SELECT * FROM sms_evidence WHERE providerTransactionId = :providerTransactionId")
    suspend fun smsEvidenceByProviderTransactionId(providerTransactionId: String): SmsEvidenceEntity?

    @Query("UPDATE sms_evidence SET spoolEventId = :eventId WHERE messageDigest = :digest AND spoolEventId IS NULL")
    suspend fun linkSmsEvidenceOutbox(digest: String, eventId: String): Int

    @Query("UPDATE spool_events SET acknowledgedAtMs = NULL, nextAttemptAtMs = :now WHERE id = :eventId AND acknowledgedAtMs IS NOT NULL AND EXISTS (SELECT 1 FROM sms_evidence WHERE messageDigest = :digest AND uploadedAtMs IS NULL AND spoolEventId = :eventId)")
    suspend fun reactivatePendingSmsOutbox(digest: String, eventId: String, now: Long): Int

    @Transaction
    suspend fun persistSmsEvidenceWithOutbox(
        evidence: SmsEvidenceEntity,
        outboxEvent: SpoolEventEntity,
    ): SmsEvidenceOutboxWrite {
        val inserted = insertSmsEvidence(evidence) != -1L
        var stored = smsEvidence(evidence.messageDigest)
            ?: evidence.providerTransactionId?.let { smsEvidenceByProviderTransactionId(it) }
            ?: error("SMS evidence conflict could not be resolved")
        if (stored.spoolEventId == null) {
            linkSmsEvidenceOutbox(stored.messageDigest, outboxEvent.id)
            stored = smsEvidence(stored.messageDigest) ?: error("SMS evidence disappeared")
        }
        if (stored.uploadedAtMs == null) {
            check(stored.spoolEventId == outboxEvent.id) { "SMS outbox identity mismatch" }
            insertSpoolIfAbsent(outboxEvent)
            reactivatePendingSmsOutbox(stored.messageDigest, outboxEvent.id, outboxEvent.createdAtMs)
        }
        val pending = stored.uploadedAtMs == null && spoolEvent(outboxEvent.id)?.acknowledgedAtMs == null
        return SmsEvidenceOutboxWrite(inserted, stored, pending)
    }

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertBalance(snapshot: BalanceSnapshotEntity)

    @Query("SELECT * FROM balance_snapshots WHERE simIccidHash = :iccidHash")
    suspend fun balance(iccidHash: String): BalanceSnapshotEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSimIdentity(identity: SimIdentityEntity)

    @Query("SELECT * FROM sim_identities")
    suspend fun simIdentities(): List<SimIdentityEntity>

    @Query("SELECT * FROM sim_identities WHERE iccidHash = :iccidHash")
    suspend fun simIdentity(iccidHash: String): SimIdentityEntity?

    @Query("SELECT * FROM sim_identities WHERE expectedSlotIndex = :slotIndex AND state = 'ACTIVE'")
    suspend fun activeSimIdentitiesForSlot(slotIndex: Int): List<SimIdentityEntity>

    @Query("UPDATE sim_identities SET state = 'QUARANTINED', updatedAtMs = :now WHERE iccidHash = :iccidHash")
    suspend fun quarantineSim(iccidHash: String, now: Long): Int

    @Query("UPDATE sim_identities SET subscriptionId = :subscriptionId, slotIndex = :slotIndex, updatedAtMs = :now WHERE iccidHash = :iccidHash AND state = 'ACTIVE' AND expectedSlotIndex = :slotIndex")
    suspend fun updateSubscriptionObservation(
        iccidHash: String,
        subscriptionId: Int,
        slotIndex: Int,
        now: Long,
    ): Int

    @Query("UPDATE job_executions SET status = :nextStatus, terminalAtMs = :terminalAt WHERE jobId = :jobId AND status = :expectedStatus")
    suspend fun transitionJob(
        jobId: String,
        expectedStatus: String,
        nextStatus: String,
        terminalAt: Long?,
    ): Int

    @Query("UPDATE job_executions SET status = 'PIN_SUBMITTED', committedAtMs = :committedAt WHERE jobId = :jobId AND status = 'DEVICE_STARTED' AND committedAtMs IS NULL")
    suspend fun markJobCommitted(jobId: String, committedAt: Long): Int

    @Query("UPDATE job_executions SET leaseExpiresAtMs = :leaseExpiresAt WHERE jobId = :jobId AND fencingToken = :fencingToken AND leaseExpiresAtMs < :leaseExpiresAt AND :leaseExpiresAt <= jobExpiresAtMs AND status IN ('ACCEPTED', 'DEVICE_STARTED', 'PIN_SUBMITTED', 'PROVIDER_PENDING')")
    suspend fun renewJobLease(jobId: String, fencingToken: Long, leaseExpiresAt: Long): Int

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertBalanceQueryLease(lease: BalanceQueryLeaseEntity)

    @Query("SELECT * FROM balance_query_leases WHERE simIccidHash = :iccidHash AND status = 'OPEN' AND createdAtMs <= :receivedAt AND expiresAtMs >= :receivedAt ORDER BY createdAtMs DESC")
    suspend fun balanceLeasesAt(iccidHash: String, receivedAt: Long): List<BalanceQueryLeaseEntity>

    @Query("SELECT * FROM balance_query_leases WHERE simIccidHash = :iccidHash AND status = 'OPEN' AND expiresAtMs >= :now")
    suspend fun openBalanceLeases(iccidHash: String, now: Long): List<BalanceQueryLeaseEntity>

    @Query("UPDATE balance_query_leases SET status = 'CORRELATED', correlatedMessageDigest = :digest WHERE leaseId = :leaseId AND status = 'OPEN'")
    suspend fun correlateBalanceLease(leaseId: String, digest: String): Int

    @Query("UPDATE balance_query_leases SET status = 'EXPIRED' WHERE status = 'OPEN' AND expiresAtMs < :now")
    suspend fun expireBalanceLeases(now: Long): Int
}

data class SmsEvidenceOutboxWrite(
    val inserted: Boolean,
    val evidence: SmsEvidenceEntity,
    val pendingOutboxEnsured: Boolean,
)
