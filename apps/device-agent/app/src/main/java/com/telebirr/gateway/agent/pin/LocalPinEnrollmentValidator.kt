package com.telebirr.gateway.agent.pin

enum class LocalPinEnrollmentValidation {
    VALID,
    REQUIRED_FIELD_MISSING,
    PIN_MISMATCH,
}

/**
 * Performs the UI-level checks that must succeed before a PIN reaches [PinVault].
 *
 * The caller retains ownership of both arrays and must wipe them after every save
 * attempt. Format and length validation remains in [PinVault], immediately before
 * encryption.
 */
object LocalPinEnrollmentValidator {
    fun validate(
        iccid: String,
        pin: CharArray,
        confirmation: CharArray,
    ): LocalPinEnrollmentValidation = when {
        iccid.isBlank() || pin.isBlank() || confirmation.isBlank() ->
            LocalPinEnrollmentValidation.REQUIRED_FIELD_MISSING

        !pin.contentEquals(confirmation) -> LocalPinEnrollmentValidation.PIN_MISMATCH
        else -> LocalPinEnrollmentValidation.VALID
    }

    private fun CharArray.isBlank(): Boolean = isEmpty() || all(Char::isWhitespace)
}
