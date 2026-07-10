package com.telebirr.gateway.agent.sim

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import androidx.core.content.ContextCompat
import com.telebirr.gateway.agent.crypto.CryptoEncoding
import com.telebirr.gateway.agent.db.AgentDao
import java.time.Clock

data class ResolvedSubscription(
    val subscriptionId: Int,
    val slotIndex: Int,
    val iccid: String,
    val iccidHash: String,
)

sealed interface SubscriptionAttribution {
    data class Resolved(val subscription: ResolvedSubscription) : SubscriptionAttribution
    data class Uncertain(val reason: String) : SubscriptionAttribution
    data class Quarantined(val iccidHash: String, val reason: String) : SubscriptionAttribution
}

interface SubscriptionResolver {
    suspend fun resolve(intent: Intent): SubscriptionAttribution
    suspend fun qualified(iccid: String): SubscriptionAttribution
    suspend fun active(): List<ResolvedSubscription>
}

/** Fails closed if vendor extras, subscription ID, slot, ICCID, and enrollment disagree. */
class AndroidSubscriptionResolver(
    private val context: Context,
    private val dao: AgentDao,
    private val clock: Clock = Clock.systemUTC(),
) : SubscriptionResolver {
    private val manager = context.getSystemService(SubscriptionManager::class.java)

    override suspend fun resolve(intent: Intent): SubscriptionAttribution {
        val active = activeInfos()
        if (active.isEmpty()) return SubscriptionAttribution.Uncertain("no_readable_active_subscription")
        val subscriptionExtras = intExtras(
            intent,
            listOf(
                SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX,
                "subscription",
                "subscription_id",
                "sub_id",
            ),
        )
        val slotExtras = intExtras(intent, listOf("slot", "slot_id", "simSlot", "sim_slot"))
        if (subscriptionExtras.size > 1 || slotExtras.size > 1) {
            return SubscriptionAttribution.Uncertain("conflicting_subscription_extras")
        }
        val requestedSubId = subscriptionExtras.singleOrNull()
        val requestedSlot = slotExtras.singleOrNull()
        val candidates = when {
            requestedSubId != null && requestedSlot != null -> active.filter {
                it.subscriptionId == requestedSubId && it.simSlotIndex == requestedSlot
            }
            requestedSubId != null -> active.filter { it.subscriptionId == requestedSubId }
            requestedSlot != null -> active.filter { it.simSlotIndex == requestedSlot }
            active.size == 1 -> active
            else -> emptyList()
        }
        if (candidates.size != 1) return SubscriptionAttribution.Uncertain("ambiguous_subscription_attribution")
        return validate(candidates.single())
    }

    override suspend fun qualified(iccid: String): SubscriptionAttribution {
        if (!iccid.matches(Regex("[0-9]{10,24}"))) {
            return SubscriptionAttribution.Uncertain("invalid_requested_iccid")
        }
        val hash = CryptoEncoding.sha256Hex(iccid)
        val candidates = activeInfos().filter { it.iccId?.trim() == iccid }
        if (candidates.size != 1) {
            dao.quarantineSim(hash, clock.millis())
            return SubscriptionAttribution.Quarantined(hash, "enrolled_sim_missing_or_duplicated")
        }
        return validate(candidates.single())
    }

    private suspend fun validate(info: SubscriptionInfo): SubscriptionAttribution {
        val iccid = info.iccId?.trim().orEmpty()
        if (!iccid.matches(Regex("[0-9]{10,24}"))) {
            return SubscriptionAttribution.Uncertain("iccid_unavailable")
        }
        val hash = CryptoEncoding.sha256Hex(iccid)
        val enrollment = dao.simIdentity(hash)
        if (enrollment == null) {
            dao.activeSimIdentitiesForSlot(info.simSlotIndex).forEach { prior ->
                dao.quarantineSim(prior.iccidHash, clock.millis())
            }
            return SubscriptionAttribution.Quarantined(hash, "sim_not_enrolled_or_swapped")
        }
        if (enrollment.state != "ACTIVE") {
            return SubscriptionAttribution.Quarantined(hash, "sim_not_active")
        }
        if (enrollment.expectedSlotIndex != info.simSlotIndex) {
            dao.quarantineSim(hash, clock.millis())
            return SubscriptionAttribution.Quarantined(hash, "sim_slot_changed")
        }
        if (enrollment.subscriptionId != info.subscriptionId || enrollment.slotIndex != info.simSlotIndex) {
            // Subscription IDs are transient and commonly change after reboot. ICCID
            // plus the qualified slot remains authoritative, so refresh this mapping.
            dao.updateSubscriptionObservation(hash, info.subscriptionId, info.simSlotIndex, clock.millis())
        }
        return SubscriptionAttribution.Resolved(
            ResolvedSubscription(info.subscriptionId, info.simSlotIndex, iccid, hash),
        )
    }

    override suspend fun active(): List<ResolvedSubscription> = activeInfos().mapNotNull { info ->
        val iccid = info.iccId?.trim().orEmpty()
        if (!iccid.matches(Regex("[0-9]{10,24}"))) null else ResolvedSubscription(
            info.subscriptionId,
            info.simSlotIndex,
            iccid,
            CryptoEncoding.sha256Hex(iccid),
        )
    }

    private fun activeInfos(): List<SubscriptionInfo> {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) !=
            PackageManager.PERMISSION_GRANTED
        ) return emptyList()
        return runCatching { manager.activeSubscriptionInfoList.orEmpty() }.getOrDefault(emptyList())
    }

    private fun intExtras(intent: Intent, keys: List<String>): List<Int> = keys.mapNotNull { key ->
        if (!intent.hasExtra(key)) null else intent.getIntExtra(key, Int.MIN_VALUE)
            .takeUnless { it == Int.MIN_VALUE || it == SubscriptionManager.INVALID_SUBSCRIPTION_ID }
    }.distinct()
}
