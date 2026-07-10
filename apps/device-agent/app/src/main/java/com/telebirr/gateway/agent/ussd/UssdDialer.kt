package com.telebirr.gateway.agent.ussd

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.core.content.ContextCompat

interface UssdDialer {
    fun dial(shortCode: String, subscriptionId: Int): Boolean
}

/** Phone-account/subscription mapping must be qualified on the exact OEM build. */
class AndroidUssdDialer(private val context: Context) : UssdDialer {
    private val telecom = context.getSystemService(TelecomManager::class.java)

    override fun dial(shortCode: String, subscriptionId: Int): Boolean {
        require(shortCode.matches(Regex("\\*[0-9*]+#")))
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) !=
            PackageManager.PERMISSION_GRANTED
        ) return false
        val handles = runCatching { telecom.callCapablePhoneAccounts }.getOrDefault(emptyList())
        val matching = handles.filter { subscriptionId(it) == subscriptionId }
        if (matching.size != 1) return false
        return runCatching {
            val extras = Bundle().apply {
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, matching.single())
            }
            telecom.placeCall(Uri.fromParts("tel", shortCode, null), extras)
            true
        }.getOrDefault(false)
    }

    private fun subscriptionId(handle: PhoneAccountHandle): Int? {
        val account = runCatching { telecom.getPhoneAccount(handle) }.getOrNull() ?: return null
        val extras = account.extras ?: return null
        val keys = listOf(
            "android.telecom.extra.SUBSCRIPTION_ID",
            "subscription_id",
            "sub_id",
        )
        return keys.firstNotNullOfOrNull { key ->
            if (!extras.containsKey(key)) null else extras.getInt(key).takeIf { it >= 0 }
        }
    }
}
