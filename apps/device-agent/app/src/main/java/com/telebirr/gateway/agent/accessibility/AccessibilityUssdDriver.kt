package com.telebirr.gateway.agent.accessibility

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.view.accessibility.AccessibilityNodeInfo
import com.telebirr.gateway.agent.pin.PinVault

class AccessibilityUssdDriver(
    private val service: AccessibilityService,
    private val pinVault: PinVault,
) {
    fun selectOrEnter(root: AccessibilityNodeInfo, value: String): Boolean {
        if (value.isNotEmpty()) findDirectOption(root, value)?.let { option ->
            if (option.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
        }
        return setEditableAndSubmit(root, value)
    }

    fun submitLocalPin(root: AccessibilityNodeInfo, iccid: String): Boolean =
        pinVault.use(iccid) { pin ->
            val mutableSecret = SpannableStringBuilder()
            pin.forEach(mutableSecret::append)
            try {
                setEditableAndSubmit(root, mutableSecret)
            } finally {
                mutableSecret.clear()
                mutableSecret.clearSpans()
            }
        }

    fun dismissPreCommit(): Boolean = service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)

    /**
     * Dismisses only a non-editable provider processing dialog. This is called
     * after PIN dispatch (or after a non-financial balance PIN), and never enters
     * text or confirms a monetary choice.
     */
    fun dismissNonInteractiveModal(root: AccessibilityNodeInfo): Boolean {
        val nodes = descendants(root).toList()
        if (nodes.any { it.isEditable || it.isPassword }) return false
        val allowed = setOf("OK", "CLOSE", "DONE", "\u786e\u5b9a", "\u5173\u95ed", "\u5b8c\u6210")
        val buttons = nodes.filter { node ->
            node.isClickable && sequenceOf(node.text, node.contentDescription)
                .filterNotNull()
                .map { it.toString().trim().uppercase() }
                .any(allowed::contains)
        }
        if (buttons.size == 1 && buttons.single().performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            return true
        }
        // Back is a non-monetary dismissal and is safer than clicking an
        // unqualified carrier/OEM button.
        return service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    }

    private fun setEditableAndSubmit(root: AccessibilityNodeInfo, value: CharSequence): Boolean {
        val editable = descendants(root).singleOrNull { it.isEditable }
            ?: return false
        val arguments = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        }
        if (!editable.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) return false
        val button = descendants(root).filter { node ->
            node.isClickable && node.className?.toString()?.contains("Button", ignoreCase = true) == true
        }.singleOrNull { node ->
            SubmitLabelPolicy.isAllowed(node.text?.toString().orEmpty())
        }
        return button?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
    }

    private fun findDirectOption(root: AccessibilityNodeInfo, number: String): AccessibilityNodeInfo? {
        val matcher = Regex("^\\s*${Regex.escape(number)}(?:[.)\\-:]|$)")
        return descendants(root).filter { it.isClickable }.singleOrNull { node ->
            matcher.containsMatchIn(node.text?.toString().orEmpty())
        }
    }

    fun isPinPrompt(root: AccessibilityNodeInfo): Boolean {
        val nodes = descendants(root).toList()
        if (nodes.none { it.isEditable || it.isPassword }) return false
        return nodes.any { node ->
            sequenceOf(node.text, node.contentDescription)
                .filterNotNull()
                .map { it.toString() }
                .any { Regex("(?iu)\\b(?:ENTER\\s+)?PIN\\b").containsMatchIn(it) }
        }
    }

    fun screenText(root: AccessibilityNodeInfo, sensitivePinScreen: Boolean = false): String = descendants(root)
        .mapNotNull { node ->
            if (node.isEditable || node.isPassword) {
                "[REDACTED INPUT FIELD]"
            } else {
                node.text?.toString()?.takeIf(String::isNotBlank)
                    ?: node.contentDescription?.toString()?.takeIf(String::isNotBlank)
            }
        }
        .map { value -> if (sensitivePinScreen) SensitiveScreenRedactor.redactPinDigits(value) else value }
        .distinct()
        .joinToString("\n")
        .take(8_192)

    private fun descendants(root: AccessibilityNodeInfo): Sequence<AccessibilityNodeInfo> = sequence {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited++ < 256) {
            val node = queue.removeFirst()
            yield(node)
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let(queue::addLast)
            }
        }
    }
}

object SensitiveScreenRedactor {
    private val digitRun = Regex("[0-9\\u0660-\\u0669\\u06F0-\\u06F9\\uFF10-\\uFF19]+")

    fun redactPinDigits(value: String): String = value.replace(digitRun, "[REDACTED PIN]")
}
