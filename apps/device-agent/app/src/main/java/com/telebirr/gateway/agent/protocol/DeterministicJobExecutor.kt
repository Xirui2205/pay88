package com.telebirr.gateway.agent.protocol

import com.telebirr.gateway.agent.sim.SubscriptionAttribution
import com.telebirr.gateway.agent.sim.SubscriptionResolver
import com.telebirr.gateway.agent.ussd.HandsetUssdSessionRegistry
import com.telebirr.gateway.agent.ussd.UssdDialer

class DeterministicJobExecutor(
    private val jobs: JobExecutionRepository,
    private val subscriptions: SubscriptionResolver,
    private val sessions: HandsetUssdSessionRegistry,
    private val dialer: UssdDialer,
) {
    suspend fun submit(envelope: SignedDeviceJobEnvelope): JobAcceptance {
        val acceptance = jobs.accept(envelope)
        if (acceptance !is JobAcceptance.Accepted) return acceptance
        val job = acceptance.job
        val subscription = (subscriptions.qualified(job.simIccid) as? SubscriptionAttribution.Resolved)?.subscription
            ?: return rejectAccepted(job, "sim_attribution_failed")
        if (!sessions.begin(job)) return rejectAccepted(job, "handset_ussd_busy")
        if (!jobs.start(job.jobId)) {
            sessions.cancelAccepted("job_start_rejected")
            return JobAcceptance.Rejected("job_start_rejected")
        }
        if (!sessions.reportStarted()) {
            sessions.failBeforeStart("status_spool_failed")
            return JobAcceptance.Rejected("status_spool_failed")
        }
        if (!dialer.dial("*127#", subscription.subscriptionId)) {
            sessions.failBeforeStart("ussd_dial_failed")
            return JobAcceptance.Rejected("ussd_dial_failed")
        }
        return acceptance
    }

    private suspend fun rejectAccepted(job: DeviceJobPayload, code: String): JobAcceptance {
        // It remains pre-commit and can safely be superseded with a higher fence.
        jobs.cancelBeforeStart(job.jobId)
        return JobAcceptance.Rejected(code)
    }
}
