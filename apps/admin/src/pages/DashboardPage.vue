<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { ArrowRight, Check, Connection, Refresh, Tickets, Timer, Warning } from '@element-plus/icons-vue'
import MetricCard from '../components/MetricCard.vue'
import StatusPill from '../components/StatusPill.vue'
import { deposits as demoDeposits, withdrawals as demoWithdrawals } from '../data/mock'
import { usePlatformStore } from '../stores/platform'

const platform=usePlatformStore()
const online = computed(() => platform.qualifiedPhones)
const totalBalance = computed(() => platform.totalSpendable)
const recent=computed(()=>platform.demoMode?[...demoDeposits.slice(0,2),...demoWithdrawals.slice(0,2)]:[...platform.operations.deposits.slice(0,2),...platform.operations.withdrawals.slice(0,2)])
const demoAlerts = [
  { tone: 'red', title: 'Device offline', detail: 'AA-Kazanchis-01 · last seen 8 minutes ago', icon: Connection },
  { tone: 'amber', title: 'Balance becoming stale', detail: 'AA-Bole-02 · SIM 1 · last query 28 min ago', icon: Timer },
  { tone: 'purple', title: 'Unknown payout requires review', detail: 'WD-38204 · ETB 875.00 · Blue Nile Play', icon: Warning },
]
type DashboardData={
  open_cases:number
  sims:{count:number;main_balance:string;reserved:string}
  today:{deposit_count:number;deposit_amount:string;withdrawal_count:number;withdrawal_amount:string;processed_amount:string;net_inflow:string}
  capacity:{online_qualified_phones:number;measured_sessions:number;p95_session_seconds:number;safety_factor:number;theoretical_per_minute:number;usable_per_minute:number;queued_withdrawals:number;estimated_queue_wait_seconds:number|null}
  reconciliation:{unbalanced_journals:number;physical_balance:string;live_custody_balance:string;physical_custody_drift:string}
}
const stats=computed(()=>platform.dashboard as DashboardData|null)
const today=computed(()=>stats.value?.today??{deposit_count:7219,deposit_amount:'10820000.00',withdrawal_count:4108,withdrawal_amount:'7600000.00',processed_amount:'18420000.00',net_inflow:'3220000.00'})
const capacity=computed(()=>stats.value?.capacity??{online_qualified_phones:online.value,measured_sessions:58,p95_session_seconds:22,safety_factor:.73,theoretical_per_minute:58,usable_per_minute:42.6,queued_withdrawals:2,estimated_queue_wait_seconds:46})
const reconciliation=computed(()=>stats.value?.reconciliation??{unbalanced_journals:0,physical_balance:String(totalBalance.value),live_custody_balance:String(totalBalance.value),physical_custody_drift:'0.00'})
const activeSims=computed(()=>platform.devices.flatMap(device=>device.sims).filter(sim=>sim.health==='healthy'||sim.health==='warning').length)
const alerts=computed(()=>platform.demoMode?demoAlerts:platform.alerts.slice(0,3).map(alert=>({
  tone:alert.type==='unknown_payout'||alert.type==='reconciliation_drift'?'purple':alert.type==='device_offline'?'red':'amber',
  title:alert.type.replace(/_/g,' ').replace(/^./,(letter:string)=>letter.toUpperCase()),
  detail:alert.message,
  icon:alert.type==='device_offline'?Connection:alert.type==='unknown_payout'?Warning:Timer,
})))
const throughputPercent=computed(()=>capacity.value.theoretical_per_minute>0?Math.min(100,Math.round(capacity.value.usable_per_minute/capacity.value.theoretical_per_minute*100)):0)
const formatEtb=(value:string|number)=>Number(value).toLocaleString('en',{maximumFractionDigits:2})
onMounted(()=>{platform.loadOperations('deposits');platform.loadOperations('withdrawals')})
</script>

<template>
  <div class="page">
    <div class="page-heading">
      <div><p class="eyebrow">Live control room</p><h1>Good morning, Selam</h1><span class="muted">Platform health and ETB movement across the fleet.</span></div>
      <div class="toolbar"><el-button :icon="Refresh" :loading="platform.refreshing" @click="platform.refresh">Refresh</el-button><el-button type="primary" @click="$router.push('/devices/new')">Add phone</el-button></div>
    </div>

    <section class="grid grid-4 metrics">
      <MetricCard label="Processed today" :value="`ETB ${formatEtb(today.processed_amount)}`" :detail="`${today.deposit_count + today.withdrawal_count} successful operations`" tone="primary" />
      <MetricCard label="Fleet liquidity" :value="`ETB ${totalBalance.toLocaleString('en', { maximumFractionDigits: 0 })}`" :detail="`Custody drift ETB ${formatEtb(reconciliation.physical_custody_drift)}`" tone="teal" />
      <MetricCard label="Active fleet" :value="`${online}/${platform.devices.length} phones`" :detail="`${activeSims} SIMs currently available`" tone="amber" />
      <MetricCard label="Needs attention" :value="`${stats?.open_cases ?? 4} cases`" :detail="`${platform.alerts.length || (platform.demoMode ? 3 : 0)} active alerts`" tone="red" />
    </section>

    <section class="grid main-grid">
      <div class="panel flow-panel">
        <div class="panel-head"><div><h2>Payment flow</h2><span class="muted small">Current financial day · Africa/Addis_Ababa</span></div></div>
        <div class="panel-body">
          <div class="flow-totals"><div><span>Deposits</span><strong>ETB {{ formatEtb(today.deposit_amount) }}</strong><small>{{ today.deposit_count.toLocaleString() }} successful</small></div><div><span>Withdrawals</span><strong>ETB {{ formatEtb(today.withdrawal_amount) }}</strong><small>{{ today.withdrawal_count.toLocaleString() }} successful</small></div><div><span>Net inflow</span><strong :class="{green:Number(today.net_inflow)>=0}">ETB {{ formatEtb(today.net_inflow) }}</strong><small>Deposit minus withdrawal principal</small></div></div>
          <div class="real-bars" aria-label="Current financial-day deposit and withdrawal totals"><div><span>Deposit volume</span><el-progress :percentage="Math.round(Number(today.deposit_amount)/Math.max(1,Number(today.deposit_amount)+Number(today.withdrawal_amount))*100)" :show-text="false" :stroke-width="14"/></div><div><span>Withdrawal volume</span><el-progress color="#1aa48f" :percentage="Math.round(Number(today.withdrawal_amount)/Math.max(1,Number(today.deposit_amount)+Number(today.withdrawal_amount))*100)" :show-text="false" :stroke-width="14"/></div></div>
        </div>
      </div>
      <div class="panel alerts-panel">
        <div class="panel-head"><div><h2>Active alerts</h2><span class="muted small">Requires operator action</span></div><el-button text type="primary" @click="$router.push('/reconciliation')">View all</el-button></div>
        <div class="alerts">
          <button v-for="alert in alerts" :key="alert.title" @click="$router.push('/reconciliation')">
            <span :class="['alert-icon', alert.tone]"><el-icon><component :is="alert.icon" /></el-icon></span><span><strong>{{ alert.title }}</strong><small>{{ alert.detail }}</small></span><el-icon><ArrowRight /></el-icon>
          </button>
        </div>
        <div v-if="reconciliation.unbalanced_journals===0" class="all-clear"><el-icon><Check /></el-icon> All ledger journals are balanced</div>
        <div v-else class="all-clear invariant-failure"><el-icon><Warning /></el-icon> {{ reconciliation.unbalanced_journals }} unbalanced ledger journals</div>
      </div>
    </section>

    <section class="grid lower-grid">
      <div class="panel">
        <div class="panel-head"><div><h2>Recent payment activity</h2><span class="muted small">Latest deposits and withdrawals</span></div><el-button text type="primary" @click="$router.push('/deposits')">Open ledger</el-button></div>
        <div class="table-wrap"><el-table :data="recent" stripe>
          <el-table-column label="Reference" min-width="130"><template #default="s"><strong>{{ s.row.reference }}</strong><div class="muted small">{{ s.row.merchant }}</div></template></el-table-column>
          <el-table-column prop="customer" label="Customer" min-width="120" />
          <el-table-column label="Amount" width="125"><template #default="s"><span class="amount">ETB {{ s.row.amount.toLocaleString() }}</span></template></el-table-column>
          <el-table-column label="Status" width="145"><template #default="s"><StatusPill :status="s.row.p2pStatus" /></template></el-table-column>
          <el-table-column prop="age" label="Age" width="90" />
        </el-table></div>
      </div>
      <div class="panel capacity-panel">
        <div class="panel-head"><div><h2>Capacity now</h2><span class="muted small">Measured fleet throughput</span></div><el-icon class="capacity-icon"><Tickets /></el-icon></div>
        <div class="panel-body"><strong>{{ capacity.usable_per_minute }}</strong><span>usable USSD sessions / min</span><el-progress :percentage="throughputPercent" :show-text="false" :stroke-width="8" /><div class="capacity-meta"><span><b>{{ capacity.theoretical_per_minute }}</b> theoretical/min</span><span><b>{{ Math.round(capacity.safety_factor*100) }}%</b> safety factor</span><span><b>{{ capacity.p95_session_seconds }}s</b> p95 · {{ capacity.measured_sessions }} samples</span></div><div class="queue-note"><b>{{ capacity.queued_withdrawals }}</b><span>withdrawals currently queued<br/><small>{{ capacity.estimated_queue_wait_seconds===null?'No qualified capacity':`Estimated wait ${capacity.estimated_queue_wait_seconds}s` }}</small></span></div></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.metrics { margin-bottom: 18px; }.main-grid { grid-template-columns: minmax(0, 1.65fr) minmax(310px, .75fr); margin-bottom: 18px; }.lower-grid { grid-template-columns: minmax(0, 1.5fr) minmax(290px, .6fr); }
.flow-totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; border-bottom: 1px solid var(--line); padding-bottom: 17px; }
.flow-totals span,.flow-totals small { display: block; color: var(--muted); font-size: 11px; }.flow-totals strong { display: block; font: 700 18px 'Manrope'; margin: 5px 0 3px; }.flow-totals .green { color: var(--teal); }
.real-bars{display:grid;gap:18px;padding:28px 2px 18px}.real-bars>div>span{display:block;color:var(--muted);font-size:11px;margin-bottom:8px}
.alerts { padding: 0 12px; }.alerts button { width: 100%; border: 0; border-bottom: 1px solid var(--line); padding: 14px 8px; display: grid; grid-template-columns: 36px 1fr 18px; gap: 10px; align-items: center; background: transparent; text-align: left; cursor: pointer; }.alerts button > span:nth-child(2) strong,.alerts button small { display:block; }.alerts button strong { font-size: 12px; }.alerts button small { color:var(--muted); margin-top:4px; line-height:1.35; }.alert-icon { width: 34px; height: 34px; display:grid; place-items:center; border-radius:9px; }.alert-icon.red { color:#d64c60;background:#ffedf0}.alert-icon.amber{color:#bd7312;background:#fff3de}.alert-icon.purple{color:#714bb3;background:#f1eafa}.all-clear{margin:14px 20px 18px;padding:10px;border-radius:9px;background:#e9f8f4;color:#0d806d;font-size:11px;display:flex;align-items:center;gap:7px}
.invariant-failure{background:#ffedf0;color:#c33d54}
.capacity-icon{font-size:24px;color:var(--primary)}.capacity-panel .panel-body>strong{display:block;font:800 35px 'Manrope';letter-spacing:-.05em}.capacity-panel .panel-body>span{display:block;color:var(--muted);font-size:11px;margin:2px 0 15px}.capacity-meta{display:flex;justify-content:space-between;gap:8px;margin:14px 0 17px;color:var(--muted);font-size:10px}.capacity-meta b{display:block;color:var(--ink);font-size:13px}.queue-note{padding:12px;border-radius:10px;background:#f5f5ff;display:flex;gap:12px;align-items:center}.queue-note>b{font:800 24px 'Manrope';color:var(--primary)}.queue-note span{font-size:11px}.queue-note small{color:var(--muted)}
@media(max-width:1200px){.main-grid,.lower-grid{grid-template-columns:1fr}.alerts-panel{min-height:0}}@media(max-width:600px){.flow-totals{grid-template-columns:1fr 1fr}.flow-totals>div:last-child{grid-column:1/-1}}
</style>
