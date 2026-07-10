package com.telebirr.gateway.agent.ussd

import java.text.Normalizer

enum class DeterministicNameMatch { HIGH_CONFIDENCE, UNCERTAIN, MISMATCH }

object NameNormalizer {
    private val variants = mapOf(
        "MOHAMMED" to "MUHAMMAD",
        "MOHAMED" to "MUHAMMAD",
        "MOHAMAD" to "MUHAMMAD",
        "MUHAMMED" to "MUHAMMAD",
        "ABDALLA" to "ABDULLAH",
        "ABDALLAH" to "ABDULLAH",
        "HASSEN" to "HASSAN",
        "AHMED" to "AHMAD",
        "TESFAYE" to "TESFAY",
    )

    fun normalize(name: String): List<String> = Normalizer.normalize(name, Normalizer.Form.NFKD)
        .uppercase()
        .replace(Regex("[^\\p{L}\\p{M}]+"), " ")
        .trim()
        .split(Regex("\\s+"))
        .filter(String::isNotBlank)
        .map { variants[it] ?: it }

    fun compare(expected: String, actual: String): DeterministicNameMatch {
        val left = normalize(expected)
        val right = normalize(actual)
        if (left.isEmpty() || right.isEmpty()) return DeterministicNameMatch.UNCERTAIN
        if (left == right || left.sorted() == right.sorted()) return DeterministicNameMatch.HIGH_CONFIDENCE
        val overlap = left.toSet().intersect(right.toSet()).size
        return when {
            overlap == 0 -> DeterministicNameMatch.MISMATCH
            else -> DeterministicNameMatch.UNCERTAIN
        }
    }
}
