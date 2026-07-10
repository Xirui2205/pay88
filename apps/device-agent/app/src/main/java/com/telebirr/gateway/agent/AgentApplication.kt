package com.telebirr.gateway.agent

import android.app.Application
import com.telebirr.gateway.agent.config.AgentConfigStore
import com.telebirr.gateway.agent.crypto.LocalPayloadCipher
import com.telebirr.gateway.agent.crypto.PayloadVerifier
import com.telebirr.gateway.agent.db.AgentDatabase
import com.telebirr.gateway.agent.pin.PinVault
import com.telebirr.gateway.agent.protocol.DeterministicJobExecutor
import com.telebirr.gateway.agent.protocol.JobExecutionRepository
import com.telebirr.gateway.agent.protocol.SignedJobDecoder
import com.telebirr.gateway.agent.sim.AndroidSubscriptionResolver
import com.telebirr.gateway.agent.sim.SimEnrollmentRepository
import com.telebirr.gateway.agent.sms.BalanceQueryLeaseRepository
import com.telebirr.gateway.agent.sms.BalanceSnapshotRepository
import com.telebirr.gateway.agent.sms.SmsEvidenceRepository
import com.telebirr.gateway.agent.sms.TelebirrSmsParser
import com.telebirr.gateway.agent.storage.SpoolRepository
import com.telebirr.gateway.agent.ussd.AndroidUssdDialer
import com.telebirr.gateway.agent.ussd.HandsetUssdSessionRegistry
import com.telebirr.gateway.agent.ussd.profile.FlowProfileStore
import com.telebirr.gateway.agent.ussd.profile.FlowProfileVerifier

class AgentApplication : Application() {
    lateinit var container: AgentContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AgentContainer(this)
    }
}

class AgentContainer(val application: Application) {
    val database = AgentDatabase.get(application)
    private val localCipher = LocalPayloadCipher()
    val config = AgentConfigStore(application)
    val pinVault = PinVault(application)
    val spool = SpoolRepository(database.agentDao(), localCipher)
    val smsParser = TelebirrSmsParser()
    val smsEvidence = SmsEvidenceRepository(database.agentDao(), localCipher)
    val balanceSnapshots = BalanceSnapshotRepository(database.agentDao())
    val balanceLeases = BalanceQueryLeaseRepository(database.agentDao())
    val simEnrollments = SimEnrollmentRepository(database.agentDao(), localCipher)
    val subscriptionResolver = AndroidSubscriptionResolver(application, database.agentDao())

    @Volatile private var runtime: RuntimeComponents? = null

    @Synchronized
    fun runtimeOrNull(): RuntimeComponents? {
        val activeConfig = config.current() ?: return null
        runtime?.takeIf { it.deviceId == activeConfig.deviceId }?.let { return it }
        val profileVerifier = runCatching {
            FlowProfileVerifier(
                PayloadVerifier.fromX509Base64(activeConfig.signingPublicKeyX509),
                activeConfig.signingKeyId,
            )
        }.getOrNull() ?: return null
        val profileStore = FlowProfileStore(application, profileVerifier)
        val jobs = JobExecutionRepository(
            database,
            SignedJobDecoder(
                PayloadVerifier.fromX509Base64(activeConfig.signingPublicKeyX509),
                activeConfig.signingKeyId,
            ),
            profileStore,
            activeConfig.deviceId,
        )
        val sessions = HandsetUssdSessionRegistry(profileStore, jobs, balanceLeases, spool)
        val executor = DeterministicJobExecutor(
            jobs,
            subscriptionResolver,
            sessions,
            AndroidUssdDialer(application),
        )
        return RuntimeComponents(activeConfig.deviceId, profileStore, jobs, sessions, executor)
            .also { runtime = it }
    }

    fun sessionsOrNull(): HandsetUssdSessionRegistry? = runtimeOrNull()?.sessions

}

data class RuntimeComponents(
    val deviceId: String,
    val profileStore: FlowProfileStore,
    val jobs: JobExecutionRepository,
    val sessions: HandsetUssdSessionRegistry,
    val executor: DeterministicJobExecutor,
)
