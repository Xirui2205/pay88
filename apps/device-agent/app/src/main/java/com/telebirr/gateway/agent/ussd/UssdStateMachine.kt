package com.telebirr.gateway.agent.ussd

import com.telebirr.gateway.agent.ussd.profile.FlowProfile
import com.telebirr.gateway.agent.ussd.profile.InputValue
import com.telebirr.gateway.agent.ussd.profile.ResponseType
import com.telebirr.gateway.agent.sim.EthiopianPhoneNumber
import java.math.BigDecimal
import java.math.RoundingMode
import java.util.UUID

data class UssdJobContext(
    val destinationPhone: String,
    val amountEtb: String,
    val expectedReceiverName: String,
    val approvedProviderName: String? = null,
) {
    val canonicalDestinationPhone: String = EthiopianPhoneNumber.canonical(destinationPhone)
    val telebirrDestinationInput: String = EthiopianPhoneNumber.toTelebirrInput(destinationPhone)
    val amountMinor: Long

    init {
        val amount = BigDecimal(amountEtb).setScale(2, RoundingMode.UNNECESSARY)
        require(amount.signum() > 0)
        amountMinor = amount.movePointRight(2).longValueExact()
        require(expectedReceiverName.isNotBlank())
    }
}

sealed interface UssdCommand {
    data class SelectMenu(val optionNumber: String) : UssdCommand
    data class EnterText(val value: String) : UssdCommand
    data class SubmitLocalPin(val financialCommit: Boolean) : UssdCommand
    data object WaitForProvider : UssdCommand
    data object DismissAndWaitForProvider : UssdCommand
    data class AbortPreCommit(val reason: String) : UssdCommand
    data class RequestNameReview(val providerName: String) : UssdCommand
    data class ReceiverMismatch(val providerName: String) : UssdCommand
    data class UnknownPostCommit(val evidence: String) : UssdCommand
    data object ProviderSuccess : UssdCommand
    data object ProviderFailure : UssdCommand
}

data class PlannedUssdCommand(
    val commandId: String,
    val command: UssdCommand,
    val nextStepId: String?,
)

enum class UssdEngineStatus { ACTIVE, COMMITTING, COMMITTED, WAITING_PROVIDER, SUCCESS, FAILED, ABORTED, UNKNOWN }

/**
 * Pure deterministic engine. It never performs Accessibility actions. A caller must
 * durably persist `PIN_SUBMITTED` through [markCommittedBeforeDispatch] before
 * dispatching a financial PIN command to Android.
 */
class UssdStateMachine(
    private val profile: FlowProfile,
    private val context: UssdJobContext,
    private val parser: UssdScreenParser = UssdScreenParser(),
) {
    private val steps = profile.validated().steps.associateBy { it.id }
    private var stepId = profile.initialStepId
    private var pending: PlannedUssdCommand? = null
    var status: UssdEngineStatus = UssdEngineStatus.ACTIVE
        private set
    var committed: Boolean = false
        private set

    fun currentStepId(): String = stepId

    fun currentStepRequiresLocalPin(): Boolean =
        steps[stepId]?.response?.type == ResponseType.SUBMIT_LOCAL_PIN

    /** PIN prompts are never eligible for local/cloud evidence capture. */
    fun mayCaptureCurrentScreenEvidence(): Boolean = !currentStepRequiresLocalPin()

    fun recognizesTerminalScreen(rawScreen: String): Boolean =
        terminalCommand(parser.parse(rawScreen)) != null

    fun plan(rawScreen: String): PlannedUssdCommand {
        pending?.let { return it }
        check(status == UssdEngineStatus.ACTIVE || status == UssdEngineStatus.COMMITTED || status == UssdEngineStatus.WAITING_PROVIDER) {
            "USSD engine is terminal: $status"
        }
        val screen = parser.parse(rawScreen)
        terminalCommand(screen)?.let { return terminalPlan(it) }
        val step = requireNotNull(steps[stepId])

        val forbidden = step.expectation.forbiddenAny.map(UssdScreenParser::normalize)
        if (forbidden.any(screen.normalizedText::contains)) {
            return safetyPlan("Forbidden screen marker")
        }
        val required = step.expectation.requiredAny.map(UssdScreenParser::normalize)
        if (required.isNotEmpty() && required.none(screen.normalizedText::contains)) {
            return safetyPlan("Unexpected screen at $stepId")
        }

        val command = when (step.response.type) {
            ResponseType.SELECT_MENU -> selectMenu(screen, requireNotNull(step.response.selectAction))
            ResponseType.ENTER_VALUE -> when (requireNotNull(step.response.inputValue)) {
                InputValue.DESTINATION_PHONE -> UssdCommand.EnterText(context.telebirrDestinationInput)
                InputValue.AMOUNT_ETB -> UssdCommand.EnterText(context.amountEtb)
                InputValue.EMPTY_TEXT -> UssdCommand.EnterText("")
            }
            ResponseType.VERIFY_RECIPIENT_AND_SELECT -> verifyRecipientAndSelect(screen)
            ResponseType.VERIFY_TRANSFER_AND_SELECT -> verifyTransferAndSelect(screen)
            ResponseType.SUBMIT_LOCAL_PIN -> UssdCommand.SubmitLocalPin(step.response.financialCommit)
            ResponseType.WAIT_FOR_PROVIDER -> UssdCommand.WaitForProvider
            ResponseType.DISMISS_AND_WAIT_FOR_PROVIDER -> UssdCommand.DismissAndWaitForProvider
        }
        if (command is UssdCommand.AbortPreCommit ||
            command is UssdCommand.RequestNameReview ||
            command is UssdCommand.ReceiverMismatch ||
            command is UssdCommand.UnknownPostCommit
        ) {
            return terminalPlan(command)
        }
        return PlannedUssdCommand(UUID.randomUUID().toString(), command, step.nextStepId)
            .also { pending = it }
    }

    /** Must be called in the same critical section as the durable commit guard. */
    fun markCommittedBeforeDispatch(commandId: String) {
        val plan = requirePending(commandId)
        val command = plan.command as? UssdCommand.SubmitLocalPin
            ?: error("Only a PIN command may commit")
        require(command.financialCommit) { "Balance PIN is not a financial commit" }
        check(!committed) { "Financial PIN was already committed" }
        committed = true
        status = UssdEngineStatus.COMMITTING
    }

    fun acknowledgeDispatched(commandId: String) {
        val plan = requirePending(commandId)
        if (plan.command is UssdCommand.SubmitLocalPin && plan.command.financialCommit) {
            check(committed) { "Persist commitment before submitting PIN" }
            status = UssdEngineStatus.COMMITTED
        } else if (
            plan.command is UssdCommand.WaitForProvider ||
            plan.command is UssdCommand.DismissAndWaitForProvider
        ) {
            status = UssdEngineStatus.WAITING_PROVIDER
        }
        plan.nextStepId?.let { stepId = it }
        pending = null
    }

    fun dispatchFailed(commandId: String): PlannedUssdCommand {
        requirePending(commandId)
        pending = null
        return if (committed) {
            status = UssdEngineStatus.UNKNOWN
            PlannedUssdCommand(UUID.randomUUID().toString(), UssdCommand.UnknownPostCommit("dispatch_failed"), null)
        } else {
            status = UssdEngineStatus.ABORTED
            PlannedUssdCommand(UUID.randomUUID().toString(), UssdCommand.AbortPreCommit("dispatch_failed"), null)
        }
    }

    private fun requirePending(commandId: String): PlannedUssdCommand =
        requireNotNull(pending).also { require(it.commandId == commandId) { "Stale USSD command" } }

    private fun terminalCommand(screen: ParsedUssdScreen): UssdCommand? {
        val success = profile.terminalMarkers.successAny
            .map(UssdScreenParser::normalize)
            .any(screen.normalizedText::contains)
        val failure = profile.terminalMarkers.failureAny
            .map(UssdScreenParser::normalize)
            .any(screen.normalizedText::contains)
        if (success && failure) return safetyCommand("Ambiguous terminal screen")
        return when {
            success -> UssdCommand.ProviderSuccess
            failure -> UssdCommand.ProviderFailure
            else -> null
        }
    }

    private fun terminalPlan(command: UssdCommand): PlannedUssdCommand {
        status = when (command) {
            UssdCommand.ProviderSuccess -> UssdEngineStatus.SUCCESS
            UssdCommand.ProviderFailure -> UssdEngineStatus.FAILED
            is UssdCommand.UnknownPostCommit -> UssdEngineStatus.UNKNOWN
            else -> UssdEngineStatus.ABORTED
        }
        return PlannedUssdCommand(UUID.randomUUID().toString(), command, null)
    }

    private fun safetyPlan(reason: String): PlannedUssdCommand = terminalPlan(safetyCommand(reason))

    private fun safetyCommand(reason: String): UssdCommand = if (committed) {
        UssdCommand.UnknownPostCommit(reason)
    } else {
        UssdCommand.AbortPreCommit(reason)
    }

    private fun selectMenu(
        screen: ParsedUssdScreen,
        action: com.telebirr.gateway.agent.ussd.profile.SemanticAction,
    ): UssdCommand {
        val aliases = profile.labelAliases[action].orEmpty().map(UssdScreenParser::normalize)
        val exact = screen.options.filter { it.normalizedLabel in aliases }
        val candidates = if (exact.isNotEmpty()) exact else screen.options.filter { option ->
            aliases.any { alias -> option.normalizedLabel.contains(alias) }
        }
        return if (candidates.size == 1) {
            UssdCommand.SelectMenu(candidates.single().number)
        } else {
            safetyCommand("Missing or ambiguous menu action $action")
        }
    }

    private fun verifyRecipientAndSelect(screen: ParsedUssdScreen): UssdCommand {
        if (!hasExactlyOneMatchingPhone(screen)) {
            return safetyCommand("Receiver phone missing, ambiguous, or mismatched")
        }
        return verifyNameAndSelect(screen)
    }

    /** Last deterministic gate immediately before the PIN prompt. */
    private fun verifyTransferAndSelect(screen: ParsedUssdScreen): UssdCommand {
        if (!hasExactlyOneMatchingPhone(screen)) {
            return safetyCommand("Final receiver phone missing, ambiguous, or mismatched")
        }
        val amounts = extractEtbAmounts(screen.rawText)
        if (amounts.size != 1 || amounts.single() != context.amountMinor) {
            return safetyCommand("Final amount missing, ambiguous, or mismatched")
        }
        return verifyNameAndSelect(screen)
    }

    private fun verifyNameAndSelect(screen: ParsedUssdScreen): UssdCommand {
        val names = profile.recipientNamePatterns.mapNotNull { pattern ->
            Regex(pattern).find(screen.rawText)?.groupValues?.getOrNull(1)?.trim()
        }.distinct()
        if (names.size != 1) return safetyCommand("Receiver name missing or ambiguous")
        val providerName = names.single()
        return when (NameNormalizer.compare(context.expectedReceiverName, providerName)) {
            DeterministicNameMatch.HIGH_CONFIDENCE -> selectMenu(
                screen,
                requireNotNull(steps[stepId]?.response?.selectAction),
            )
            DeterministicNameMatch.UNCERTAIN -> {
                val approved = context.approvedProviderName?.let {
                    NameNormalizer.compare(it, providerName) == DeterministicNameMatch.HIGH_CONFIDENCE
                } == true
                if (approved) {
                    selectMenu(screen, requireNotNull(steps[stepId]?.response?.selectAction))
                } else {
                    UssdCommand.RequestNameReview(providerName)
                }
            }
            DeterministicNameMatch.MISMATCH -> UssdCommand.ReceiverMismatch(providerName)
        }
    }

    private fun hasExactlyOneMatchingPhone(screen: ParsedUssdScreen): Boolean {
        val patterns = providerPhone.findAll(screen.rawText)
            .mapNotNull { EthiopianPhoneNumber.providerPattern(it.value) }
            .distinct()
            .toList()
        return patterns.size == 1 && EthiopianPhoneNumber.matchesProviderDisplay(
            context.canonicalDestinationPhone,
            patterns.single(),
        )
    }

    private fun extractEtbAmounts(raw: String): List<Long> = etbAmount.findAll(raw).mapNotNull { match ->
        val value = match.groups[1]?.value ?: match.groups[2]?.value ?: return@mapNotNull null
        runCatching {
            val amount = BigDecimal(value.replace(",", "")).setScale(2, RoundingMode.UNNECESSARY)
            amount.movePointRight(2).longValueExact()
        }.getOrNull()
    }.distinct().toList()

    companion object {
        private val providerPhone = Regex(
            "(?<![0-9*])(?:\\+?251[ ()-]*|0)?9(?:[ ()-]*[0-9*]){8}(?![0-9*])",
        )
        private val etbAmount = Regex(
            "(?iu)(?:ETB|BIRR)\\s*([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?)|" +
                "([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?)\\s*(?:ETB|BIRR)",
        )
    }
}
