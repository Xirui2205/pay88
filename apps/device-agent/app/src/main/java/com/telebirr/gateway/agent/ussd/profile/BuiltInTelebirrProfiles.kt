package com.telebirr.gateway.agent.ussd.profile

/**
 * Replay/simulator templates. Production installs only a signature-verified copy
 * through [FlowProfileStore]; these objects are never selected as a fallback.
 */
object BuiltInTelebirrProfiles {
    private val aliases = mapOf(
        SemanticAction.NEXT to listOf("NEXT", "MORE", "ቀጣይ"),
        SemanticAction.SEND_MONEY to listOf("SEND MONEY", "TRANSFER MONEY", "ገንዘብ ላክ"),
        SemanticAction.MY_ACCOUNT to listOf("MY ACCOUNT", "ACCOUNT", "የኔ አካውንት"),
        SemanticAction.QUERY_BALANCE to listOf("QUERY BALANCE", "CHECK BALANCE", "BALANCE", "ቀሪ ሂሳብ"),
        SemanticAction.CONFIRM to listOf("CONFIRM", "YES", "OK", "አረጋግጥ"),
        SemanticAction.CANCEL to listOf("CANCEL", "NO", "BACK", "ሰርዝ"),
    )

    private val terminals = TerminalMarkers(
        successAny = listOf("SUCCESSFUL", "COMPLETED", "ተሳክቷል"),
        failureAny = listOf("FAILED", "DECLINED", "INSUFFICIENT", "INVALID PIN", "አልተሳካም"),
    )

    fun sendMoney(): FlowProfile = FlowProfile(
        profileId = "telebirr.send-money.v1",
        version = 2,
        operation = FlowOperation.WITHDRAWAL,
        initialStepId = "main-send-menu",
        labelAliases = aliases,
        recipientNamePatterns = listOf(
            // Observed Telebirr screen: "To 992844697 Abayine\nConfirm:".
            "(?iu)\\bto\\s+[+0-9*() -]{8,24}\\s+([\\p{L}][\\p{L}\\p{M} .'-]{1,80}?)(?=\\s*(?:\\n|confirm|[10][.)]|$))",
            // Observed final screen: "You are sending: ETB 20 for 992844697 Abayine".
            "(?iu)\\bfor\\s+[+0-9*() -]{8,24}\\s+([\\p{L}][\\p{L}\\p{M} .'-]{1,80}?)(?=\\s*(?:\\n|[10][.)]|confirm|$))",
            "(?iu)\\bto\\s+([\\p{L}][\\p{L}\\p{M} .'-]{1,80}?)(?:\\s*\\(|\\n|,|$)",
            "(?iu)receiver(?: name)?\\s*[:=-]\\s*([\\p{L}][\\p{L}\\p{M} .'-]{1,80}?)(?:\\n|,|$)",
        ),
        terminalMarkers = terminals,
        steps = listOf(
            FlowStep(
                "main-send-menu",
                ScreenExpectation(requiredAny = listOf("SEND", "TRANSFER")),
                FlowResponse(ResponseType.SELECT_MENU, selectAction = SemanticAction.SEND_MONEY),
                "send-submenu",
            ),
            FlowStep(
                "send-submenu",
                ScreenExpectation(requiredAny = listOf("SEND MONEY", "TRANSFER MONEY")),
                FlowResponse(ResponseType.SELECT_MENU, selectAction = SemanticAction.SEND_MONEY),
                "destination",
            ),
            FlowStep(
                "destination",
                ScreenExpectation(requiredAny = listOf("MOBILE NUMBER", "RECEIVER", "PHONE NUMBER")),
                FlowResponse(ResponseType.ENTER_VALUE, inputValue = InputValue.DESTINATION_PHONE),
                "verify-recipient",
            ),
            FlowStep(
                "verify-recipient",
                ScreenExpectation(requiredAny = listOf("CONFIRM", "RECEIVER", "NAME")),
                FlowResponse(
                    ResponseType.VERIFY_RECIPIENT_AND_SELECT,
                    selectAction = SemanticAction.CONFIRM,
                ),
                "amount",
            ),
            FlowStep(
                "amount",
                ScreenExpectation(requiredAny = listOf("ENTER AMOUNT", "AMOUNT")),
                FlowResponse(ResponseType.ENTER_VALUE, inputValue = InputValue.AMOUNT_ETB),
                "comment",
            ),
            FlowStep(
                "comment",
                ScreenExpectation(requiredAny = listOf("COMMENT", "REMARK", "REFERENCE")),
                FlowResponse(ResponseType.ENTER_VALUE, inputValue = InputValue.EMPTY_TEXT),
                "final-confirm",
            ),
            FlowStep(
                "final-confirm",
                ScreenExpectation(requiredAny = listOf("CONFIRM", "TRANSFER", "SEND")),
                FlowResponse(
                    ResponseType.VERIFY_TRANSFER_AND_SELECT,
                    selectAction = SemanticAction.CONFIRM,
                ),
                "pin",
            ),
            FlowStep(
                "pin",
                ScreenExpectation(requiredAny = listOf("ENTER PIN", "PIN")),
                FlowResponse(ResponseType.SUBMIT_LOCAL_PIN, financialCommit = true),
                "provider-result",
            ),
            FlowStep(
                "provider-result",
                ScreenExpectation(requiredAny = listOf("PROCESS", "WAIT", "REQUEST")),
                FlowResponse(ResponseType.DISMISS_AND_WAIT_FOR_PROVIDER),
            ),
        ),
    ).validated()

    fun balanceQuery(): FlowProfile = FlowProfile(
        profileId = "telebirr.balance-query.v1",
        version = 2,
        operation = FlowOperation.BALANCE_QUERY,
        initialStepId = "next",
        labelAliases = aliases,
        terminalMarkers = terminals,
        steps = listOf(
            FlowStep(
                "next",
                ScreenExpectation(requiredAny = listOf("NEXT", "MORE")),
                FlowResponse(ResponseType.SELECT_MENU, selectAction = SemanticAction.NEXT),
                "my-account",
            ),
            FlowStep(
                "my-account",
                ScreenExpectation(requiredAny = listOf("MY ACCOUNT", "ACCOUNT")),
                FlowResponse(ResponseType.SELECT_MENU, selectAction = SemanticAction.MY_ACCOUNT),
                "query-balance",
            ),
            FlowStep(
                "query-balance",
                ScreenExpectation(requiredAny = listOf("BALANCE")),
                FlowResponse(ResponseType.SELECT_MENU, selectAction = SemanticAction.QUERY_BALANCE),
                "pin",
            ),
            FlowStep(
                "pin",
                ScreenExpectation(requiredAny = listOf("ENTER PIN", "PIN")),
                FlowResponse(ResponseType.SUBMIT_LOCAL_PIN, financialCommit = false),
                "processing",
            ),
            FlowStep(
                "processing",
                ScreenExpectation(requiredAny = listOf("PROCESS", "SMS", "REQUEST")),
                FlowResponse(ResponseType.DISMISS_AND_WAIT_FOR_PROVIDER),
            ),
        ),
    ).validated()
}
