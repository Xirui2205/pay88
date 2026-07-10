package com.telebirr.gateway.agent.protocol

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JobSafetyPolicyTest {
    @Test
    fun `pre-commit explicit failure may retry`() {
        assertTrue(JobSafetyPolicy.canAutomaticallyRetry(JobStatus.FAILED, null))
    }

    @Test
    fun `no status may retry after PIN submission`() {
        JobStatus.entries.forEach { status ->
            assertFalse(JobSafetyPolicy.canAutomaticallyRetry(status, committedAtMs = 1234L))
        }
    }

    @Test
    fun `platform cancellation is accepted-only`() {
        assertTrue(JobSafetyPolicy.canPlatformCancel(JobStatus.ACCEPTED))
        assertFalse(JobSafetyPolicy.canPlatformCancel(JobStatus.DEVICE_STARTED))
        assertFalse(JobSafetyPolicy.canPlatformCancel(JobStatus.PIN_SUBMITTED))
    }
}
