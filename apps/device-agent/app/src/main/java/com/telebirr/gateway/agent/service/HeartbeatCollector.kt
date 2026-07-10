package com.telebirr.gateway.agent.service

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.telebirr.gateway.agent.AgentContainer
import com.telebirr.gateway.agent.BuildConfig
import com.telebirr.gateway.agent.accessibility.TelebirrAccessibilityService
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Clock

class HeartbeatCollector(
    private val context: Context,
    private val container: AgentContainer,
    private val clock: Clock = Clock.systemUTC(),
) {
    suspend fun collect(): JsonObject {
        val config = requireNotNull(container.config.current())
        val runtime = container.runtimeOrNull()
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        val simIdentities = container.database.agentDao().simIdentities()
        val enrolledByHash = simIdentities.associateBy { it.iccidHash }
        val observedSubscriptions = container.subscriptionResolver.active()
        val balances = simIdentities.associate { sim ->
            sim.iccidHash to container.database.agentDao().balance(sim.iccidHash)
        }
        return buildJsonObject {
            put("device_id", config.deviceId)
            put("sent_at_ms", clock.millis())
            put("agent_version", BuildConfig.VERSION_NAME)
            put("app_version", BuildConfig.VERSION_NAME)
            put("protocol_version", BuildConfig.AGENT_PROTOCOL_VERSION)
            put("android_sdk", android.os.Build.VERSION.SDK_INT)
            put("android_version", android.os.Build.VERSION.RELEASE)
            put("build_fingerprint", android.os.Build.FINGERPRINT)
            put("manufacturer", android.os.Build.MANUFACTURER)
            put("model", android.os.Build.MODEL)
            put("battery_percent", batteryPercent(battery))
            put("charging", charging(battery))
            put("temperature_celsius", battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1)?.takeIf { it >= 0 }?.div(10.0))
            put("network_type", networkType(capabilities))
            val accessibilityOk = accessibilityEnabled()
            val permissionsOk = listOf(
                Manifest.permission.RECEIVE_SMS,
                Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.READ_PHONE_NUMBERS,
                Manifest.permission.CALL_PHONE,
            ).all(::granted)
            put("accessibility_ok", accessibilityOk)
            put("permissions_ok", permissionsOk)
            put("openclaw_paired", config.openClawPaired)
            put("permissions", buildJsonObject {
                put("receive_sms", granted(Manifest.permission.RECEIVE_SMS))
                put("read_phone_state", granted(Manifest.permission.READ_PHONE_STATE))
                put("read_phone_numbers", granted(Manifest.permission.READ_PHONE_NUMBERS))
                put("call_phone", granted(Manifest.permission.CALL_PHONE))
            })
            put("profiles", buildJsonArray {
                runtime?.profileStore?.installedMetadata().orEmpty().forEach { (id, version) ->
                    add(buildJsonObject {
                        put("id", id)
                        put("version", version)
                    })
                }
            })
            put(
                "ussd_profile_version",
                runtime?.profileStore?.installedMetadata()?.joinToString(",") { "${it.first}@${it.second}" }.orEmpty(),
            )
            put("sims", buildJsonArray {
                observedSubscriptions.forEach { observed ->
                    val sim = enrolledByHash[observed.iccidHash]
                    add(buildJsonObject {
                        put("iccid", observed.iccid)
                        put("iccid_hash", observed.iccidHash)
                        put("telebirr_number", sim?.enrolledNumber)
                        put("number_suffix", sim?.enrolledNumber?.filter(Char::isDigit)?.takeLast(4))
                        put("registered_name", sim?.normalizedAccountName)
                        put("slot_index", observed.slotIndex)
                        put("subscription_id", observed.subscriptionId)
                        put("state", sim?.state ?: "UNENROLLED")
                        val balance = balances[observed.iccidHash]
                        put("customer_e_money_minor", balance?.customerMinor)
                        put("incentive_minor", balance?.incentiveMinor)
                        put("fuel_payment_minor", balance?.fuelMinor)
                        put("pocket_money_minor", balance?.pocketMoneyMinor)
                        put("balance_captured_at_ms", balance?.capturedAtMs)
                        put("balance_source", balance?.sourceKind)
                    })
                }
            })
        }
    }

    private fun batteryPercent(intent: Intent?): Int? {
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        return if (level < 0 || scale <= 0) null else (level * 100 / scale)
    }

    private fun charging(intent: Intent?): Boolean {
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        return status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    }

    private fun networkType(capabilities: NetworkCapabilities?): String = when {
        capabilities == null -> "offline"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        else -> "other"
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun accessibilityEnabled(): Boolean {
        val expected = ComponentName(context, TelebirrAccessibilityService::class.java).flattenToString()
        val enabled = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ).orEmpty()
        return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }
}
