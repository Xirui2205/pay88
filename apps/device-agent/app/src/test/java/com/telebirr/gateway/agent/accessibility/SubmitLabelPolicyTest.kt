package com.telebirr.gateway.agent.accessibility

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SubmitLabelPolicyTest {
    @Test
    fun `accepts qualified English and Chinese TECNO actions`() {
        listOf("Send", "REPLY", "ok", "Continue", "Call", "发送", "回复", "确定", "继续", "呼叫")
            .forEach { assertTrue(it, SubmitLabelPolicy.isAllowed(it)) }
    }

    @Test
    fun `does not click an unqualified arbitrary action`() {
        assertFalse(SubmitLabelPolicy.isAllowed("Delete"))
        assertFalse(SubmitLabelPolicy.isAllowed("取消"))
    }
}
