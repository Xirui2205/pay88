package com.telebirr.gateway.agent.sim

object EthiopianPhoneNumber {
    /** Canonical local Telebirr form, e.g. `0911223344`. */
    fun normalize(value: String): String {
        val compact = value.trim().replace(Regex("[\\s()-]"), "")
        val digits = compact.removePrefix("+")
        val normalized = when {
            digits.matches(Regex("09[0-9]{8}")) -> digits
            digits.matches(Regex("9[0-9]{8}")) -> "0$digits"
            digits.matches(Regex("2519[0-9]{8}")) -> "0${digits.substring(3)}"
            else -> throw IllegalArgumentException("Invalid Ethiopian mobile number")
        }
        return normalized
    }

    /** Signed/cloud identity. Never use provider display formatting as identity. */
    fun canonical(value: String): String = "+251${normalize(value).substring(1)}"

    /** Telebirr's observed USSD prompt expects nine digits without the trunk `0`. */
    fun toTelebirrInput(value: String): String = normalize(value).substring(1)

    /**
     * Matches a provider-rendered full or masked number to a signed destination.
     * Examples accepted for `+251992844697`: `992844697`, `0992844697`,
     * `251992844697`, `9928****7`, and `2519****4697`.
     */
    fun matchesProviderDisplay(expected: String, displayed: String): Boolean {
        val expectedProvider = toTelebirrInput(expected)
        val pattern = providerPattern(displayed) ?: return false
        return pattern.length == expectedProvider.length && pattern.indices.all { index ->
            pattern[index] == '*' || pattern[index] == expectedProvider[index]
        }
    }

    /** Canonical nine-character provider pattern (`9`, digits and `*`) or null. */
    fun providerPattern(value: String): String? {
        val compact = value
            .trim()
            .replace(Regex("[\\s()\\-]"), "")
            .removePrefix("+")
        val local = when {
            compact.matches(Regex("2519[0-9*]{8}")) -> compact.substring(3)
            compact.matches(Regex("09[0-9*]{8}")) -> compact.substring(1)
            compact.matches(Regex("9[0-9*]{8}")) -> compact
            else -> return null
        }
        // A masked identity must retain visible evidence on both sides. A full
        // identity naturally passes this rule.
        if ('*' in local && (local.takeWhile { it != '*' }.isEmpty() || local.takeLastWhile { it != '*' }.isEmpty())) {
            return null
        }
        return local
    }

    fun visiblePrefix(providerPattern: String): String = if ('*' in providerPattern) {
        providerPattern.takeWhile(Char::isDigit)
    } else {
        providerPattern.take(4)
    }

    fun visibleSuffix(providerPattern: String): String = if ('*' in providerPattern) {
        providerPattern.takeLastWhile(Char::isDigit)
    } else {
        providerPattern.takeLast(4)
    }
}
