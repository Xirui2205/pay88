package com.telebirr.gateway.agent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.telebirr.gateway.agent.AgentApplication

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) return
        val app = context.applicationContext as AgentApplication
        if (app.container.config.current() != null) HeartbeatService.start(context)
    }
}
