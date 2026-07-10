package com.telebirr.gateway.agent.ussd

import java.text.Normalizer

data class MenuOption(val number: String, val label: String, val normalizedLabel: String)

data class ParsedUssdScreen(
    val rawText: String,
    val normalizedText: String,
    val options: List<MenuOption>,
)

class UssdScreenParser {
    private val menuLine = Regex("(?m)^\\s*([0-9]{1,2})\\s*[.)\\-:]\\s*(.+?)\\s*$")

    fun parse(raw: String): ParsedUssdScreen {
        val canonicalRaw = normalizeDigits(raw).replace("\r\n", "\n").replace('\r', '\n')
        val options = menuLine.findAll(canonicalRaw).map { match ->
            MenuOption(
                number = match.groupValues[1],
                label = match.groupValues[2].trim(),
                normalizedLabel = normalize(match.groupValues[2]),
            )
        }.toList()
        return ParsedUssdScreen(canonicalRaw, normalize(canonicalRaw), options)
    }

    companion object {
        fun normalize(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFKC)
            .uppercase()
            .replace(Regex("[\\p{Z}\\s]+"), " ")
            .replace(Regex(" ?\\n ?"), "\n")
            .trim()

        private fun normalizeDigits(value: String): String = buildString(value.length) {
            value.forEach { char ->
                append(
                    when (char) {
                        in '٠'..'٩' -> '0' + (char - '٠')
                        in '۰'..'۹' -> '0' + (char - '۰')
                        in '０'..'９' -> '0' + (char - '０')
                        in '፩'..'፱' -> '1' + (char - '፩')
                        else -> char
                    },
                )
            }
        }
    }
}
