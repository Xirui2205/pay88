package com.telebirr.gateway.agent.accessibility

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import com.telebirr.gateway.agent.AgentApplication
import com.telebirr.gateway.agent.ussd.UssdCommand
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class TelebirrAccessibilityService : AccessibilityService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var driver: AccessibilityUssdDriver
    private var lastScreen: String? = null
    private var lastScreenAtMs: Long = 0
    private var suppressEventsUntilMs: Long = 0
    private var deferredScreenRead: Job? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        val app = application as AgentApplication
        driver = AccessibilityUssdDriver(this, app.container.pinVault)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event?.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) return
        processCurrentScreen()
    }

    private fun processCurrentScreen() {
        val now = System.currentTimeMillis()
        if (now < suppressEventsUntilMs) {
            scheduleScreenRead(suppressEventsUntilMs - now + 50L)
            return
        }
        val root = rootInActiveWindow ?: return
        val sessions = (application as AgentApplication).container.sessionsOrNull()
        val machine = sessions?.current()?.machine
        val pinPrompt = machine?.currentStepRequiresLocalPin() == true || driver.isPinPrompt(root)
        val text = driver.screenText(root, pinPrompt)
        if (text.isBlank()) return
        // A lingering PIN dialog after dispatch is neither evidence nor a new
        // financial state. Poll until it is replaced by the processing result.
        if (
            pinPrompt &&
            machine?.currentStepRequiresLocalPin() == false &&
            !machine.recognizesTerminalScreen(text)
        ) {
            scheduleScreenRead(500L)
            return
        }
        if (text == lastScreen && now - lastScreenAtMs < 2_000) return
        lastScreen = text
        lastScreenAtMs = now
        scope.launch { handleScreen(text, root, pinPrompt) }
    }

    private fun scheduleScreenRead(delayMs: Long) {
        deferredScreenRead?.cancel()
        deferredScreenRead = scope.launch {
            delay(delayMs.coerceAtLeast(1L))
            processCurrentScreen()
        }
    }

    private suspend fun handleScreen(
        text: String,
        root: android.view.accessibility.AccessibilityNodeInfo,
        sensitivePinScreen: Boolean,
    ) {
        val app = application as AgentApplication
        val sessions = app.container.sessionsOrNull() ?: return
        val session = sessions.current()
        if (session == null) {
            if (sessions.consumeProcessingDismissAuthorization(text)) {
                driver.dismissNonInteractiveModal(root)
            }
            return
        }
        if (!sensitivePinScreen && session.machine.mayCaptureCurrentScreenEvidence()) {
            app.container.spool.enqueue(
                "USSD_SCREEN_EVIDENCE",
                buildJsonObject {
                    put("job_id", session.job.jobId)
                    put("step_id", session.machine.currentStepId())
                    put("screen", text)
                    put("captured_at_ms", System.currentTimeMillis())
                }.toString().toByteArray(),
            )
        }
        val plan = runCatching { sessions.onScreen(text) }.getOrNull() ?: return
        when (val command = plan.command) {
            is UssdCommand.SelectMenu -> dispatch(plan, driver.selectOrEnter(root, command.optionNumber))
            is UssdCommand.EnterText -> dispatch(plan, driver.selectOrEnter(root, command.value))
            is UssdCommand.SubmitLocalPin -> {
                if (command.financialCommit && !sessions.beforeFinancialPin(plan.commandId)) {
                    sessions.finishForSafety(UssdCommand.AbortPreCommit("commit_guard_failed"))
                    return
                }
                suppressEventsUntilMs = System.currentTimeMillis() + 1_500L
                val submitted = runCatching { driver.submitLocalPin(root, session.job.simIccid) }.getOrDefault(false)
                if (submitted) scheduleScreenRead(1_550L)
                dispatch(plan, submitted)
            }
            UssdCommand.WaitForProvider -> sessions.acknowledge(plan)
            UssdCommand.DismissAndWaitForProvider -> {
                if (driver.dismissNonInteractiveModal(root)) {
                    sessions.acknowledge(plan)
                } else {
                    sessions.blockAndQuarantine("processing_modal_undismissed")
                }
            }
            is UssdCommand.AbortPreCommit,
            is UssdCommand.RequestNameReview,
            is UssdCommand.ReceiverMismatch,
            -> {
                if (driver.dismissPreCommit()) {
                    sessions.finishForSafety(command)
                } else {
                    sessions.blockAndQuarantine("pre_commit_modal_undismissed")
                }
            }
            is UssdCommand.UnknownPostCommit,
            UssdCommand.ProviderSuccess,
            UssdCommand.ProviderFailure,
            -> {
                // Never enter data on a terminal screen. Editable/ambiguous
                // post-commit screens remain visible and are reported unknown.
                if (driver.dismissNonInteractiveModal(root)) {
                    sessions.finishForSafety(command)
                } else {
                    sessions.blockAndQuarantine("terminal_modal_undismissed")
                }
            }
        }
    }

    private suspend fun dispatch(plan: com.telebirr.gateway.agent.ussd.PlannedUssdCommand, success: Boolean) {
        val sessions = (application as AgentApplication).container.sessionsOrNull() ?: return
        if (success) sessions.acknowledge(plan) else sessions.dispatchFailed(plan)
    }

    override fun onInterrupt() {
        scope.launch { (application as AgentApplication).container.sessionsOrNull()?.interrupted() }
    }

    override fun onDestroy() {
        deferredScreenRead?.cancel()
        scope.cancel()
        super.onDestroy()
    }
}
