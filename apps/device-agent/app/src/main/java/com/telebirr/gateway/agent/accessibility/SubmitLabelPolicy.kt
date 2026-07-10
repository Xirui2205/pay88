package com.telebirr.gateway.agent.accessibility

/** Qualified English and Simplified Chinese system-dialog action labels. */
object SubmitLabelPolicy {
    private val allowed = setOf(
        "SEND", "REPLY", "OK", "CONTINUE", "CALL",
        "发送", "回复", "确定", "继续", "呼叫",
    )

    fun isAllowed(value: String): Boolean = value.trim().uppercase() in allowed
}
