package com.telebirr.gateway.agent.ussd

import com.telebirr.gateway.agent.ussd.profile.BuiltInTelebirrProfiles
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class UssdStateMachineTest {
    private fun machine() = UssdStateMachine(
        BuiltInTelebirrProfiles.sendMoney(),
        UssdJobContext("0911223344", "100.00", "Jane Smith"),
    )

    @Test
    fun `financial verification and modal dismissal are published only as profile v2`() {
        assertEquals(2, BuiltInTelebirrProfiles.sendMoney().version)
        assertEquals(2, BuiltInTelebirrProfiles.balanceQuery().version)
    }

    @Test
    fun `happy path requires durable commit before PIN acknowledgement`() {
        val machine = machine()
        acknowledge(machine, "1. Send Money\n2. Buy Airtime", UssdCommand.SelectMenu("1"))
        acknowledge(machine, "1. Send Money\n2. Send to bank", UssdCommand.SelectMenu("1"))
        acknowledge(machine, "Enter receiver mobile number", UssdCommand.EnterText("911223344"))
        acknowledge(
            machine,
            "To 911223344 Smith Jane\n1. Confirm\n2. Cancel",
            UssdCommand.SelectMenu("1"),
        )
        acknowledge(machine, "Enter amount", UssdCommand.EnterText("100.00"))
        acknowledge(machine, "Enter optional comment", UssdCommand.EnterText(""))
        acknowledge(
            machine,
            "Confirm transfer ETB 100.00 to 911223344 Jane Smith\n1. Confirm\n2. Cancel",
            UssdCommand.SelectMenu("1"),
        )
        assertFalse("PIN step must never be evidence eligible", machine.mayCaptureCurrentScreenEvidence())
        val pin = machine.plan("Enter PIN")
        assertEquals(UssdCommand.SubmitLocalPin(financialCommit = true), pin.command)
        assertThrows(IllegalStateException::class.java) { machine.acknowledgeDispatched(pin.commandId) }
        machine.markCommittedBeforeDispatch(pin.commandId)
        machine.acknowledgeDispatched(pin.commandId)
        assertTrue(machine.committed)

        val unknown = machine.plan("Unrecognized carrier response")
        assertTrue(unknown.command is UssdCommand.UnknownPostCommit)
        assertEquals(UssdEngineStatus.UNKNOWN, machine.status)
    }

    @Test
    fun `unknown screen before PIN aborts without commitment`() {
        val machine = machine()
        val command = machine.plan("A completely different menu")
        assertTrue(command.command is UssdCommand.AbortPreCommit)
        assertFalse(machine.committed)
        assertEquals(UssdEngineStatus.ABORTED, machine.status)
    }

    @Test
    fun `uncertain receiver name stops before confirmation`() {
        val machine = machine()
        acknowledge(machine, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(machine, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(machine, "Enter receiver phone number", UssdCommand.EnterText("911223344"))
        val plan = machine.plan(
            "To 911223344 Jane Tadesse\n1. Confirm\n2. Cancel",
        )
        assertTrue(plan.command is UssdCommand.RequestNameReview)
        assertFalse(machine.committed)
    }

    @Test
    fun `staff-approved exact provider name permits only that uncertain name`() {
        val machine = UssdStateMachine(
            BuiltInTelebirrProfiles.sendMoney(),
            UssdJobContext("0911223344", "100.00", "Jane Smith", "Jane Tadesse"),
        )
        acknowledge(machine, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(machine, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(machine, "Enter receiver phone number", UssdCommand.EnterText("911223344"))
        acknowledge(
            machine,
            "To 911223344 Jane Tadesse\n1. Confirm\n2. Cancel",
            UssdCommand.SelectMenu("1"),
        )
    }

    @Test
    fun `staff approval cannot override a different or mismatched provider name`() {
        val changed = UssdStateMachine(
            BuiltInTelebirrProfiles.sendMoney(),
            UssdJobContext("0911223344", "100.00", "Jane Smith", "Jane Tadesse"),
        )
        acknowledge(changed, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(changed, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(changed, "Enter receiver phone number", UssdCommand.EnterText("911223344"))
        val changedPlan = changed.plan("To 911223344 Jane Kebede\n1. Confirm\n2. Cancel")
        assertTrue(changedPlan.command is UssdCommand.RequestNameReview || changedPlan.command is UssdCommand.ReceiverMismatch)

        val mismatch = UssdStateMachine(
            BuiltInTelebirrProfiles.sendMoney(),
            UssdJobContext("0911223344", "100.00", "Jane Smith", "Abebe Kebede"),
        )
        acknowledge(mismatch, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(mismatch, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(mismatch, "Enter receiver phone number", UssdCommand.EnterText("911223344"))
        val mismatchPlan = mismatch.plan("To 911223344 Abebe Kebede\n1. Confirm\n2. Cancel")
        assertTrue(mismatchPlan.command is UssdCommand.ReceiverMismatch)
    }

    @Test
    fun `observed Telebirr phone then receiver name screen is parsed`() {
        val machine = machine()
        acknowledge(machine, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(machine, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(machine, "Please Enter the receiver mobile number", UssdCommand.EnterText("911223344"))
        acknowledge(
            machine,
            "To 911223344 Jane Smith\nConfirm:\n1. OK\n0. Cancel",
            UssdCommand.SelectMenu("1"),
        )
    }

    @Test
    fun `observed Telebirr final screen validates signed phone amount and name before PIN`() {
        val machine = UssdStateMachine(
            BuiltInTelebirrProfiles.sendMoney(),
            UssdJobContext("+251992844697", "20.00", "Abayine"),
        )
        acknowledge(machine, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(machine, "1. Send Money", UssdCommand.SelectMenu("1"))
        acknowledge(machine, "Please Enter the receiver mobile number", UssdCommand.EnterText("992844697"))
        acknowledge(
            machine,
            "To 992844697 Abayine\nConfirm:\n1. OK\n0. Cancel",
            UssdCommand.SelectMenu("1"),
        )
        acknowledge(machine, "Enter Amount", UssdCommand.EnterText("20.00"))
        acknowledge(machine, "Enter comment to Customer", UssdCommand.EnterText(""))
        acknowledge(
            machine,
            "You are sending:\nETB 20 for 992844697 Abayine\n1.OK\n0.Cancel",
            UssdCommand.SelectMenu("1"),
        )
        assertEquals(UssdCommand.SubmitLocalPin(true), machine.plan("Enter PIN").command)
    }

    @Test
    fun `early recipient screen rejects wrong or missing phone even when name matches`() {
        fun atRecipient(): UssdStateMachine = machine().also {
            acknowledge(it, "1. Send Money", UssdCommand.SelectMenu("1"))
            acknowledge(it, "1. Send Money", UssdCommand.SelectMenu("1"))
            acknowledge(it, "Enter receiver phone number", UssdCommand.EnterText("911223344"))
        }
        assertTrue(
            atRecipient().plan("To 911223399 Jane Smith\n1. Confirm\n0. Cancel").command is
                UssdCommand.AbortPreCommit,
        )
        assertTrue(
            atRecipient().plan("Receiver name: Jane Smith\n1. Confirm\n0. Cancel").command is
                UssdCommand.AbortPreCommit,
        )
    }

    @Test
    fun `final confirmation rejects any changed financial attribute`() {
        fun atFinal(): UssdStateMachine = machine().also {
            acknowledge(it, "1. Send Money", UssdCommand.SelectMenu("1"))
            acknowledge(it, "1. Send Money", UssdCommand.SelectMenu("1"))
            acknowledge(it, "Enter receiver phone number", UssdCommand.EnterText("911223344"))
            acknowledge(it, "To 911223344 Jane Smith\n1. Confirm\n0. Cancel", UssdCommand.SelectMenu("1"))
            acknowledge(it, "Enter amount", UssdCommand.EnterText("100.00"))
            acknowledge(it, "Enter comment", UssdCommand.EnterText(""))
        }
        assertTrue(
            atFinal().plan("You are sending ETB 101.00 for 911223344 Jane Smith\n1.OK\n0.Cancel").command is
                UssdCommand.AbortPreCommit,
        )
        assertTrue(
            atFinal().plan("You are sending ETB 100.00 for 911223399 Jane Smith\n1.OK\n0.Cancel").command is
                UssdCommand.AbortPreCommit,
        )
        assertTrue(
            atFinal().plan("You are sending ETB 100.00 for 911223344 Abebe Kebede\n1.OK\n0.Cancel").command is
                UssdCommand.ReceiverMismatch,
        )
        assertTrue(
            atFinal().plan("You are sending ETB 100.00 plus ETB 2.00 for 911223344 Jane Smith\n1.OK\n0.Cancel").command is
                UssdCommand.AbortPreCommit,
        )
    }

    @Test
    fun `duplicate accessibility event returns same planned command`() {
        val machine = machine()
        val first = machine.plan("1. Send Money")
        val duplicate = machine.plan("1. Send Money")
        assertEquals(first.commandId, duplicate.commandId)
    }

    @Test
    fun `balance transcript follows semantic path without financial commitment`() {
        val machine = UssdStateMachine(
            BuiltInTelebirrProfiles.balanceQuery(),
            UssdJobContext("0910000000", "1.00", "BALANCE QUERY"),
        )
        acknowledge(machine, "1. Buy Airtime\n2. Next", UssdCommand.SelectMenu("2"))
        acknowledge(machine, "1. My Account\n2. Help", UssdCommand.SelectMenu("1"))
        acknowledge(machine, "1. Query Balance\n2. Statement", UssdCommand.SelectMenu("1"))
        val pin = machine.plan("Enter PIN")
        assertEquals(UssdCommand.SubmitLocalPin(financialCommit = false), pin.command)
        assertThrows(IllegalArgumentException::class.java) {
            machine.markCommittedBeforeDispatch(pin.commandId)
        }
        machine.acknowledgeDispatched(pin.commandId)
        assertFalse(machine.committed)
        val processing = machine.plan("Your request is processing; balance will arrive by SMS")
        assertEquals(UssdCommand.DismissAndWaitForProvider, processing.command)
    }

    private fun acknowledge(machine: UssdStateMachine, screen: String, expected: UssdCommand) {
        val plan = machine.plan(screen)
        assertEquals(expected, plan.command)
        machine.acknowledgeDispatched(plan.commandId)
    }
}
