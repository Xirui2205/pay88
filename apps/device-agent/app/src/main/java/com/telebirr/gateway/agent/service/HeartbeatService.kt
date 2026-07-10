package com.telebirr.gateway.agent.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.telebirr.gateway.agent.AgentApplication
import com.telebirr.gateway.agent.R
import com.telebirr.gateway.agent.activation.ActivationActivity
import com.telebirr.gateway.agent.transport.DeviceGatewayClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class HeartbeatService : LifecycleService() {
    private var loop: Job? = null
    private var gateway: DeviceGatewayClient? = null
    private var recoveryDone = false

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIFICATION_ID, notification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        if (loop?.isActive != true) {
            loop = lifecycleScope.launch { heartbeatLoop() }
        }
        return Service.START_STICKY
    }

    private suspend fun heartbeatLoop() {
        val container = (application as AgentApplication).container
        while (lifecycleScope.isActive) {
            val config = container.config.current()
            if (config == null) {
                stopSelf()
                return
            }
            runCatching {
                val runtime = container.runtimeOrNull()
                runtime?.sessions?.expireIfNeeded()
                if (runtime != null && !recoveryDone) {
                    runtime.jobs.recoverOrphanedJobs(runtime.sessions.current()?.job?.jobId)
                        .forEach { recovered ->
                            container.spool.enqueue(
                                "JOB_STATUS",
                                buildJsonObject {
                                    put("job_id", recovered.jobId)
                                    put("financial_operation_id", recovered.financialOperationId)
                                    put("fencing_token", recovered.fencingToken)
                                    put("state", recovered.status.wireName)
                                    put("error_code", "process_restart_recovery")
                                    put("observed_at_ms", System.currentTimeMillis())
                                }.toString().toByteArray(),
                            )
                        }
                    recoveryDone = true
                }
                val client = gateway ?: DeviceGatewayClient(container, config).also {
                    gateway = it
                    it.connect()
                }
                if (!client.isConnected()) client.connect()
                runtime?.sessions?.current()?.job?.let { activeJob ->
                    client.requestLeaseRenewal(activeJob.jobId, activeJob.fencingToken)
                }
                client.sendHeartbeat(HeartbeatCollector(this, container).collect())
                client.flushSpool()
            }
            delay((config.heartbeatIntervalSeconds * 1_000L).coerceIn(15_000L, 60_000L))
        }
    }

    override fun onDestroy() {
        loop?.cancel()
        gateway?.close()
        gateway = null
        super.onDestroy()
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.heartbeat_channel),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            setShowBadge(false)
            description = getString(R.string.heartbeat_running)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun notification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_agent)
        .setContentTitle(getString(R.string.app_name))
        .setContentText(getString(R.string.heartbeat_running))
        .setOngoing(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, ActivationActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            ),
        )
        .build()

    companion object {
        private const val CHANNEL_ID = "fleet-heartbeat-v1"
        private const val NOTIFICATION_ID = 127
        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, HeartbeatService::class.java))
        }
    }
}
