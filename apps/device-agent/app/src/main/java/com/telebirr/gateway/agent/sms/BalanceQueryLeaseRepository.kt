package com.telebirr.gateway.agent.sms

import com.telebirr.gateway.agent.db.AgentDao
import com.telebirr.gateway.agent.db.BalanceQueryLeaseEntity
import java.time.Clock
import java.util.UUID

class BalanceQueryLeaseRepository(
    private val dao: AgentDao,
    private val clock: Clock = Clock.systemUTC(),
) {
    suspend fun open(simIccidHash: String, durationMs: Long = 120_000): String {
        require(durationMs in 30_000..5 * 60_000)
        val now = clock.millis()
        dao.expireBalanceLeases(now)
        require(dao.openBalanceLeases(simIccidHash, now).isEmpty()) {
            "A balance query lease is already open for this SIM"
        }
        val id = UUID.randomUUID().toString()
        dao.insertBalanceQueryLease(
            BalanceQueryLeaseEntity(id, simIccidHash, now, now + durationMs, "OPEN", null),
        )
        return id
    }

    suspend fun correlate(simIccidHash: String, receivedAtMs: Long, digest: String): Boolean {
        val leases = dao.balanceLeasesAt(simIccidHash, receivedAtMs)
        if (leases.size != 1) return false
        return dao.correlateBalanceLease(leases.single().leaseId, digest) == 1
    }
}
