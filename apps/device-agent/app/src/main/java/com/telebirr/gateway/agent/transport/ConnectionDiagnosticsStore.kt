package com.telebirr.gateway.agent.transport

import android.content.Context
import java.text.DateFormat
import java.util.Date

data class ConnectionDiagnostics(
    val phase: String,
    val detail: String,
    val lastConnectAttemptAtMs: Long,
    val lastSocketOpenAtMs: Long,
    val lastHelloAcknowledgedAtMs: Long,
    val lastHeartbeatSentAtMs: Long,
    val lastHeartbeatAcknowledgedAtMs: Long,
    val lastHttpStatus: Int,
) {
    val authenticated: Boolean
        get() = lastHelloAcknowledgedAtMs > 0L &&
            lastHelloAcknowledgedAtMs >= lastConnectAttemptAtMs

    val heartbeatAcknowledged: Boolean
        get() = lastHeartbeatAcknowledgedAtMs > 0L &&
            lastHeartbeatAcknowledgedAtMs >= lastConnectAttemptAtMs

    fun displayText(): String {
        fun time(value: Long): String = if (value <= 0L) "never" else
            DateFormat.getDateTimeInstance().format(Date(value))
        return buildString {
            append("Connection: ").append(phase)
            if (detail.isNotBlank()) append("\nDetails: ").append(detail)
            if (lastHttpStatus > 0) append("\nWebSocket HTTP: ").append(lastHttpStatus)
            append("\nAuthenticated hello: ").append(if (authenticated) "YES" else "NO")
            append(" (last: ").append(time(lastHelloAcknowledgedAtMs)).append(')')
            append("\nHeartbeat acknowledged: ").append(if (heartbeatAcknowledged) "YES" else "NO")
            append(" (last: ").append(time(lastHeartbeatAcknowledgedAtMs)).append(')')
            append("\nLast attempt: ").append(time(lastConnectAttemptAtMs))
            append("\nLast socket open: ").append(time(lastSocketOpenAtMs))
            append("\nLast heartbeat sent: ").append(time(lastHeartbeatSentAtMs))
        }
    }
}

class ConnectionDiagnosticsStore(context: Context) {
    private val preferences = context.getSharedPreferences("connection-diagnostics-v1", Context.MODE_PRIVATE)

    fun snapshot(): ConnectionDiagnostics = ConnectionDiagnostics(
        phase = preferences.getString("phase", "disconnected") ?: "disconnected",
        detail = preferences.getString("detail", "") ?: "",
        lastConnectAttemptAtMs = preferences.getLong("connect_attempt", 0L),
        lastSocketOpenAtMs = preferences.getLong("socket_open", 0L),
        lastHelloAcknowledgedAtMs = preferences.getLong("hello_ack", 0L),
        lastHeartbeatSentAtMs = preferences.getLong("heartbeat_sent", 0L),
        lastHeartbeatAcknowledgedAtMs = preferences.getLong("heartbeat_ack", 0L),
        lastHttpStatus = preferences.getInt("http_status", 0),
    )

    fun connecting() = update("connecting", "Opening authenticated device WebSocket") {
        putLong("connect_attempt", System.currentTimeMillis())
        putInt("http_status", 0)
    }

    fun socketOpened(httpStatus: Int) = update("socket_open", "WebSocket opened; waiting for server hello acknowledgement") {
        putLong("socket_open", System.currentTimeMillis())
        putInt("http_status", httpStatus)
    }

    fun helloAcknowledged() = update("authenticated", "Device token accepted; waiting for heartbeat acknowledgement") {
        putLong("hello_ack", System.currentTimeMillis())
    }

    fun heartbeatSent(sentAtMs: Long) = update("heartbeat_sent", "Heartbeat sent; waiting for backend acknowledgement") {
        putLong("heartbeat_sent", sentAtMs)
    }

    fun heartbeatAcknowledged(receivedAtMs: Long) = update("online", "Authenticated heartbeat acknowledged by backend") {
        putLong("heartbeat_ack", receivedAtMs)
    }

    fun closed(code: Int, reason: String) = update("disconnected", "WebSocket closed: $code ${reason.ifBlank { "no reason" }}") {}

    fun failed(message: String, httpStatus: Int?) = update("failed", message.take(500)) {
        httpStatus?.let { putInt("http_status", it) }
    }

    private inline fun update(
        phase: String,
        detail: String,
        extra: android.content.SharedPreferences.Editor.() -> Unit,
    ) {
        preferences.edit().putString("phase", phase).putString("detail", detail).apply {
            extra()
        }.apply()
    }
}
