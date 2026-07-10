package com.telebirr.gateway.agent.ussd.profile

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class FlowOperation {
    @SerialName("withdrawal") WITHDRAWAL,
    @SerialName("unknown_reconciliation") UNKNOWN_RECONCILIATION,
    @SerialName("balance_query") BALANCE_QUERY,
    @SerialName("emergency_liquidity_move") EMERGENCY_LIQUIDITY_MOVE,
    @SerialName("automatic_sweep") SWEEP,
    @SerialName("merchant_settlement") SETTLEMENT,
}

@Serializable
enum class SemanticAction {
    @SerialName("next") NEXT,
    @SerialName("send_money") SEND_MONEY,
    @SerialName("my_account") MY_ACCOUNT,
    @SerialName("query_balance") QUERY_BALANCE,
    @SerialName("confirm") CONFIRM,
    @SerialName("cancel") CANCEL,
}

@Serializable
enum class ResponseType {
    @SerialName("select_menu") SELECT_MENU,
    @SerialName("enter_value") ENTER_VALUE,
    @SerialName("verify_recipient_and_select") VERIFY_RECIPIENT_AND_SELECT,
    @SerialName("verify_transfer_and_select") VERIFY_TRANSFER_AND_SELECT,
    @SerialName("submit_local_pin") SUBMIT_LOCAL_PIN,
    @SerialName("wait_for_provider") WAIT_FOR_PROVIDER,
    @SerialName("dismiss_and_wait_for_provider") DISMISS_AND_WAIT_FOR_PROVIDER,
}

@Serializable
enum class InputValue {
    @SerialName("destination_phone") DESTINATION_PHONE,
    @SerialName("amount_etb") AMOUNT_ETB,
    @SerialName("empty_text") EMPTY_TEXT,
}

@Serializable
data class ScreenExpectation(
    @SerialName("required_any") val requiredAny: List<String> = emptyList(),
    @SerialName("forbidden_any") val forbiddenAny: List<String> = emptyList(),
)

@Serializable
data class FlowResponse(
    val type: ResponseType,
    @SerialName("select_action") val selectAction: SemanticAction? = null,
    @SerialName("input_value") val inputValue: InputValue? = null,
    @SerialName("financial_commit") val financialCommit: Boolean = false,
)

@Serializable
data class FlowStep(
    val id: String,
    val expectation: ScreenExpectation,
    val response: FlowResponse,
    @SerialName("next_step_id") val nextStepId: String? = null,
)

@Serializable
data class TerminalMarkers(
    @SerialName("success_any") val successAny: List<String>,
    @SerialName("failure_any") val failureAny: List<String>,
)

@Serializable
data class FlowProfile(
    @SerialName("profile_id") val profileId: String,
    val version: Int,
    val operation: FlowOperation,
    @SerialName("initial_step_id") val initialStepId: String,
    @SerialName("label_aliases") val labelAliases: Map<SemanticAction, List<String>>,
    @SerialName("recipient_name_patterns") val recipientNamePatterns: List<String> = emptyList(),
    @SerialName("terminal_markers") val terminalMarkers: TerminalMarkers,
    val steps: List<FlowStep>,
) {
    fun validated(): FlowProfile = apply {
        require(profileId.matches(Regex("[a-z0-9][a-z0-9._-]{2,63}")))
        require(version > 0)
        require(steps.size in 1..32)
        require(labelAliases.size <= SemanticAction.entries.size)
        require(labelAliases.values.flatten().size <= 64)
        require(labelAliases.values.flatten().all { it.length in 1..96 })
        require(recipientNamePatterns.size <= 8)
        require(recipientNamePatterns.all { it.length in 1..256 && runCatching { Regex(it) }.isSuccess })
        val ids = steps.map(FlowStep::id)
        require(ids.all { it.matches(Regex("[a-z0-9][a-z0-9._-]{1,63}")) })
        require(ids.distinct().size == ids.size) { "Duplicate flow step" }
        require(initialStepId in ids) { "Missing initial step" }
        require(steps.all { it.nextStepId == null || it.nextStepId in ids }) { "Broken step transition" }
        require(steps.flatMap { it.expectation.requiredAny + it.expectation.forbiddenAny }
            .all { it.length in 1..128 })
        steps.forEach { step ->
            when (step.response.type) {
                ResponseType.SELECT_MENU,
                ResponseType.VERIFY_RECIPIENT_AND_SELECT,
                ResponseType.VERIFY_TRANSFER_AND_SELECT,
                -> requireNotNull(step.response.selectAction)
                ResponseType.ENTER_VALUE -> requireNotNull(step.response.inputValue)
                ResponseType.SUBMIT_LOCAL_PIN,
                ResponseType.WAIT_FOR_PROVIDER,
                ResponseType.DISMISS_AND_WAIT_FOR_PROVIDER,
                -> Unit
            }
            if (step.response.financialCommit) {
                require(operation != FlowOperation.BALANCE_QUERY)
                require(step.response.type == ResponseType.SUBMIT_LOCAL_PIN)
            }
        }
        if (
            operation == FlowOperation.WITHDRAWAL ||
            operation == FlowOperation.EMERGENCY_LIQUIDITY_MOVE ||
            operation == FlowOperation.SWEEP ||
            operation == FlowOperation.SETTLEMENT
        ) {
            require(steps.count { it.response.financialCommit } == 1) {
                "A money-moving flow must define exactly one commit point"
            }
        }
        require(terminalMarkers.successAny.isNotEmpty())
        require(terminalMarkers.failureAny.isNotEmpty())
        require((terminalMarkers.successAny + terminalMarkers.failureAny).all { it.length in 1..96 })
        require(
            terminalMarkers.successAny.map { it.trim().uppercase() }.toSet()
                .intersect(terminalMarkers.failureAny.map { it.trim().uppercase() }.toSet())
                .isEmpty(),
        ) { "Success and failure terminal markers overlap" }
    }
}

@Serializable
data class SignedFlowProfileEnvelope(
    @SerialName("key_id") val keyId: String,
    @SerialName("payload_base64") val payloadBase64: String,
    @SerialName("signature_base64") val signatureBase64: String,
)
