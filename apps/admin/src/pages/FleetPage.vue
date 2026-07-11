<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { CirclePlus, Download, Refresh, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import StatusPill from '../components/StatusPill.vue'
import { usePlatformStore } from '../stores/platform'
import type { Device } from '../types'

const platform = usePlatformStore()
const query = ref('')
const health = ref('all')
const expanded = ref<string[]>([])
const quarantineDialog = ref(false)
const selectedDevice = ref<Device | null>(null)
const quarantineReason = ref('')
const password = ref('')
const acting = ref(false)
const maintenanceDialog = ref(false)
const maintenanceMode = ref<'recover'|'retire'|'delete'>('recover')
const maintenanceReason = ref('')
const replacementHardware = ref(false)
const recoverySims = ref<Array<{slot:number;iccid:string;phone_number:string;account_name:string}>>([])
const recoveryResult = ref<{activation_code:string;activation_expires_at:string}|null>(null)
const diagnosticsDialog = ref(false)
const diagnosticsLoading = ref(false)
const diagnostics = ref<Record<string, unknown> | null>(null)

const visible = computed(() => platform.devices.filter((device) =>
  (health.value === 'all' || device.health === health.value)
  && `${device.name} ${device.location} ${device.group}`.toLowerCase().includes(query.value.toLowerCase()),
))
const balance = computed(() => platform.totalSpendable)
const availableSims = computed(() => platform.devices.flatMap((device) => device.sims).filter((sim) => sim.health === 'healthy').length)
const totalSims = computed(() => platform.devices.flatMap((device) => device.sims).length)
const dailyHeadroom = computed(() => platform.devices.flatMap((device) => device.sims).reduce((sum, sim) => sum + Math.max(0, sim.dailyLimit - sim.dailyUsed), 0))
const diagnosticsReady = computed(() => Boolean((diagnostics.value as {readiness?: {ready?: boolean}} | null)?.readiness?.ready))

onMounted(async () => {
  await platform.refresh()
  expanded.value = platform.devices.slice(0, 2).map((device) => device.id)
})

async function queryBalance(simId: string) {
  acting.value = true
  try {
    await platform.queueBalance(simId)
    ElMessage.success('Balance query queued behind higher-priority financial work')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not queue balance query')
  } finally { acting.value = false }
}

async function setOnline(device: Device, value: boolean | string | number) {
  acting.value = true
  try {
    await platform.setDeviceOnline(device.id, Boolean(value))
    ElMessage.success(Boolean(value) ? `${device.name} is online` : `${device.name} is offline`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not change phone status')
    await platform.refresh()
  } finally { acting.value = false }
}

async function openDiagnostics(device: Device) {
  selectedDevice.value = device
  diagnostics.value = null
  diagnosticsDialog.value = true
  diagnosticsLoading.value = true
  try {
    diagnostics.value = await platform.getDeviceDiagnostics(device.id)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not load device diagnostics')
  } finally { diagnosticsLoading.value = false }
}

function openQuarantine(device: Device) {
  selectedDevice.value = device
  quarantineReason.value = ''
  password.value = ''
  quarantineDialog.value = true
}

async function quarantine() {
  if (!selectedDevice.value || quarantineReason.value.trim().length < 5 || !password.value) {
    ElMessage.warning('Enter a reason and reauthenticate with your password')
    return
  }
  acting.value = true
  try {
    await platform.quarantineDevice(selectedDevice.value.id, quarantineReason.value.trim(), password.value)
    quarantineDialog.value = false
    ElMessage.success('Device and both SIMs quarantined')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Quarantine failed')
  } finally { acting.value = false }
}

function openMaintenance(device: Device, mode: 'recover'|'retire'|'delete') {
  selectedDevice.value = device
  maintenanceMode.value = mode
  maintenanceReason.value = ''
  password.value = ''
  replacementHardware.value = device.status === 'retired'
  recoveryResult.value = null
  recoverySims.value = device.sims.map((sim) => ({ slot: sim.slot - 1, iccid: '', phone_number: '', account_name: sim.accountName }))
  maintenanceDialog.value = true
}

async function maintainDevice() {
  if (!selectedDevice.value || maintenanceReason.value.trim().length < 10 || !password.value) {
    ElMessage.warning('Enter a reason of at least 10 characters and reauthenticate')
    return
  }
  if (maintenanceMode.value === 'recover' && recoverySims.value.some((sim) => !/^\d{10,24}$/.test(sim.iccid) || !sim.phone_number || !sim.account_name.trim())) {
    ElMessage.warning('Verify the full ICCID, Telebirr number and registered name for every SIM')
    return
  }
  acting.value = true
  try {
    if (maintenanceMode.value === 'recover') {
      recoveryResult.value = await platform.recoverDevice(selectedDevice.value.id, { reason: maintenanceReason.value.trim(), replacement_hardware: replacementHardware.value, sims: recoverySims.value }, password.value)
      ElMessage.success('Old credentials revoked; activate the phone with the new code')
    } else if (maintenanceMode.value === 'retire') {
      await platform.retireDevice(selectedDevice.value.id, maintenanceReason.value.trim(), password.value)
      maintenanceDialog.value = false
      ElMessage.success('Device retired and SIM assignments disabled')
    } else {
      await platform.deleteDevice(selectedDevice.value.id, maintenanceReason.value.trim(), password.value)
      maintenanceDialog.value = false
      ElMessage.success('Failed enrollment deleted; its SIM identities can now be enrolled again')
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Device maintenance failed')
  } finally { acting.value = false }
}

function exportCsv() {
  const lines = [
    ['device', 'location', 'group', 'health', 'sim_slot', 'phone', 'account_name', 'balance_etb', 'balance_age_minutes', 'daily_used_etb', 'daily_limit_etb'].join(','),
    ...platform.devices.flatMap((device) => device.sims.map((sim) => [device.name, device.location, device.group, device.health, sim.slot, sim.phone, sim.accountName, sim.balance.toFixed(2), sim.balanceAge, sim.dailyUsed.toFixed(2), sim.dailyLimit.toFixed(2)].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))),
  ]
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `fleet-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="page">
    <div class="page-heading">
      <div><p class="eyebrow">Physical fleet</p><h1>Fleet & liquidity</h1><span class="muted">Devices, SIM wallets, balances and transfer headroom.</span></div>
      <div class="toolbar"><el-button :icon="Refresh" :loading="platform.refreshing" @click="platform.refresh">Refresh view</el-button><el-button type="primary" :icon="CirclePlus" @click="$router.push('/devices/new')">Add phone</el-button></div>
    </div>
    <div class="summary-strip panel">
      <div><span>Total spendable</span><strong>ETB {{ balance.toLocaleString('en', { minimumFractionDigits: 2 }) }}</strong></div>
      <div><span>Online phones</span><strong>{{ platform.qualifiedPhones }} / {{ platform.devices.length }}</strong></div>
      <div><span>Available SIMs</span><strong>{{ availableSims }} / {{ totalSims }}</strong></div>
      <div><span>Daily headroom</span><strong>ETB {{ dailyHeadroom.toLocaleString('en', { maximumFractionDigits: 0 }) }}</strong></div>
    </div>
    <div class="panel fleet-panel">
      <div class="filters"><el-input v-model="query" :prefix-icon="Search" placeholder="Search phone, group or location" clearable class="search"/><el-select v-model="health" style="width:150px"><el-option label="All health" value="all"/><el-option label="Healthy" value="healthy"/><el-option label="Warning" value="warning"/><el-option label="Offline" value="offline"/><el-option label="Quarantined" value="quarantined"/></el-select><el-button :icon="Download" class="push" @click="exportCsv">Export</el-button></div>
      <el-empty v-if="!visible.length" description="No fleet devices match this view" />
      <el-collapse v-else v-model="expanded" class="device-list">
        <el-collapse-item v-for="device in visible" :key="device.id" :name="device.id">
          <template #title>
            <div class="device-head"><div class="device-icon"><span aria-hidden="true">📱</span><i :class="`status-${device.health}`" /></div><div class="device-name"><strong>{{ device.name }}</strong><span>{{ device.model }} · {{ device.group }}</span></div><div class="device-location desktop-only"><span>Location</span><strong>{{ device.location }}</strong></div><div class="device-seen desktop-only"><span>Last seen</span><strong>{{ device.lastSeen }}</strong></div><StatusPill :status="device.health" /></div>
          </template>
          <div class="device-meta"><el-switch :model-value="device.status==='online'" :loading="acting" active-text="Online" inactive-text="Offline" :disabled="device.status==='quarantined'||device.status==='retired'" @change="setOnline(device, $event)"/><span :class="device.credentialsConfigured?'ok':'bad'">Activation <b>{{device.credentialsConfigured?'Credentials stored':'Not activated'}}</b></span><span :class="device.socketConnected?'ok':'bad'">Agent socket <b>{{device.socketConnected?'Authenticated':'Disconnected'}}</b></span><span>Battery <b>{{ device.battery }}%</b></span><span>Temperature <b>{{ device.temperature }}°C</b></span><span>Agent <b>v{{ device.appVersion }}</b></span><span>USSD profile <b>{{ device.profileVersion }}</b></span><span :class="device.permissionsOk?'ok':'bad'">Permissions <b>{{device.permissionsOk?'OK':'Blocked'}}</b></span><span :class="device.accessibilityOk?'ok':'bad'">Accessibility <b>{{device.accessibilityOk?'OK':'Blocked'}}</b></span><span :class="device.readiness.ready?'ok':'bad'">Execution <b>{{device.readiness.ready?'Ready':'Blocked'}}</b></span><el-button size="small" type="primary" plain @click.stop="openDiagnostics(device)">Full diagnostics</el-button><el-button v-if="device.status==='pending'||device.status==='qualifying'" size="small" type="primary" plain @click.stop="$router.push({path:'/devices/new',query:{device:device.id}})">Open setup</el-button><el-button v-if="device.status==='pending'||device.status==='qualifying'" size="small" type="danger" plain @click.stop="openMaintenance(device,'delete')">Delete phone</el-button><el-button v-if="device.status==='quarantined'||device.status==='retired'" size="small" type="warning" plain @click.stop="openMaintenance(device,'recover')">Recover / re-enroll</el-button><el-button v-if="device.status!=='retired'&&device.status!=='pending'&&device.status!=='qualifying'" size="small" type="danger" plain @click.stop="openMaintenance(device,'retire')">Retire</el-button><el-button size="small" type="danger" plain :disabled="device.status==='quarantined'||device.status==='retired'" @click.stop="openQuarantine(device)">Quarantine</el-button></div>
          <el-alert v-if="device.credentialsConfigured&&!device.socketConnected" class="readiness-alert" type="warning" :closable="false" show-icon><template #title>Agent is activated but disconnected{{device.disconnectReason?`: ${device.disconnectReason}`:''}}. Open the Agent on the phone and tap Reconnect now.</template></el-alert>
          <el-alert v-if="!device.readiness.ready" class="readiness-alert" type="error" :closable="false" show-icon><template #title>Execution blocked: {{device.readiness.blockers.map(item=>`${item.code}: ${item.message}`).join(' · ')}}</template></el-alert>
          <div class="sim-grid">
            <article v-for="sim in device.sims" :key="sim.id" class="sim-card">
              <header><span class="slot">SIM {{ sim.slot }}</span><StatusPill :status="sim.health" /></header>
              <div class="sim-id"><strong>{{ sim.phone }}</strong><span>{{ sim.accountName }}</span></div>
              <div class="sim-balance"><span>Spendable balance</span><strong>ETB {{ sim.balance.toLocaleString('en', { minimumFractionDigits: 2 }) }}</strong><small :class="{ stale: sim.balanceAge >= 30 }">{{ sim.balanceAge >= 999 ? 'No balance snapshot' : `${sim.balanceAge} min old · SMS/USSD` }}</small></div>
              <div class="limit"><div><span>Daily transfer usage</span><b>{{ Math.min(100, Math.round(sim.dailyUsed / Math.max(1, sim.dailyLimit) * 100)) }}%</b></div><el-progress :percentage="Math.min(100, Math.round(sim.dailyUsed / Math.max(1, sim.dailyLimit) * 100))" :show-text="false" :stroke-width="6" :color="sim.dailyUsed / Math.max(1, sim.dailyLimit) > .8 ? '#d18a24' : '#5c5ce2'"/><small>ETB {{ sim.dailyUsed.toLocaleString() }} of {{ sim.dailyLimit.toLocaleString() }}</small></div>
              <footer><el-button size="small" :loading="acting" @click="queryBalance(sim.id)">Query balance</el-button><span class="muted small">{{ sim.balanceAge >= 30 ? 'Payout sourcing stopped while stale' : 'Eligible subject to reservations' }}</span></footer>
            </article>
          </div>
        </el-collapse-item>
      </el-collapse>
    </div>
    <el-dialog v-model="diagnosticsDialog" :title="`Full diagnostics${selectedDevice ? ` — ${selectedDevice.name}` : ''}`" width="min(980px,96vw)">
      <div v-loading="diagnosticsLoading" class="diagnostics-body">
        <el-alert v-if="diagnostics && !diagnosticsReady" title="This phone cannot receive a USSD job. The exact blockers are included below." type="error" :closable="false" show-icon/>
        <p class="muted small">Complete persisted backend response: readiness blockers, raw heartbeat, profile-install response, active USSD lock and device response log.</p>
        <pre>{{ diagnostics ? JSON.stringify(diagnostics, null, 2) : 'Waiting for backend response…' }}</pre>
      </div>
      <template #footer><el-button @click="diagnosticsDialog=false">Close</el-button><el-button type="primary" :loading="diagnosticsLoading" @click="selectedDevice&&openDiagnostics(selectedDevice)">Refresh diagnostics</el-button></template>
    </el-dialog>
    <el-dialog v-model="quarantineDialog" title="Quarantine device" width="min(520px,92vw)">
      <el-alert title="This immediately stops new assignments for the handset and both SIMs." type="warning" :closable="false" show-icon/>
      <el-form label-position="top" style="margin-top:16px"><el-form-item label="Audited reason"><el-input v-model="quarantineReason" type="textarea" :rows="3" maxlength="1000"/></el-form-item><el-form-item label="Your password"><el-input v-model="password" type="password" show-password autocomplete="current-password"/></el-form-item></el-form>
      <template #footer><el-button @click="quarantineDialog=false">Cancel</el-button><el-button type="danger" :loading="acting" @click="quarantine">Quarantine device</el-button></template>
    </el-dialog>
    <el-dialog v-model="maintenanceDialog" :title="maintenanceMode==='recover'?'Recover or re-enroll device':maintenanceMode==='delete'?'Delete failed enrollment':'Retire device'" width="min(620px,94vw)" :close-on-click-modal="false">
      <template v-if="recoveryResult"><el-alert title="Enter this activation code on the phone." type="warning" :closable="false" show-icon/><div class="recovery-code"><code>{{recoveryResult.activation_code}}</code><small>Expires {{new Date(recoveryResult.activation_expires_at).toLocaleString()}}</small></div><ol><li>Open Telebirr Device Agent on the phone.</li><li>Enter this code.</li><li>Return to Fleet and switch the phone Online.</li></ol></template>
      <template v-else><el-alert :title="maintenanceMode==='recover'?'This creates a new phone activation code.':maintenanceMode==='delete'?'This permanently removes the phone record and releases its SIM identities.':'Retirement is blocked while any deposit, payout or unknown outcome remains assigned.'" type="warning" :closable="false" show-icon/><el-form label-position="top" style="margin-top:16px"><template v-if="maintenanceMode==='recover'"><el-switch v-model="replacementHardware" active-text="Replacement handset / clear hardware identity"/><div v-for="sim in recoverySims" :key="sim.slot" class="recovery-sim"><strong>SIM {{sim.slot+1}}</strong><el-form-item label="Full ICCID"><el-input v-model="sim.iccid" inputmode="numeric" maxlength="24"/></el-form-item><el-form-item label="Telebirr number"><el-input v-model="sim.phone_number" placeholder="+2519…"/></el-form-item><el-form-item label="Registered Telebirr name"><el-input v-model="sim.account_name" maxlength="200"/></el-form-item></div></template><el-form-item label="Reason"><el-input v-model="maintenanceReason" type="textarea" :rows="3" maxlength="1000"/></el-form-item><el-form-item label="Your password"><el-input v-model="password" type="password" show-password autocomplete="current-password"/></el-form-item></el-form></template>
      <template #footer><el-button @click="maintenanceDialog=false">{{recoveryResult?'Close':'Cancel'}}</el-button><el-button v-if="!recoveryResult" :type="maintenanceMode==='recover'?'primary':'danger'" :loading="acting" @click="maintainDevice">{{maintenanceMode==='recover'?'Revoke and begin recovery':maintenanceMode==='delete'?'Delete and release SIMs':'Retire device'}}</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.readiness-alert{margin:-5px 0 15px}.diagnostics-body pre{max-height:58vh;overflow:auto;padding:16px;border-radius:10px;background:#111827;color:#d1fae5;font:11px/1.6 Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.summary-strip{display:grid;grid-template-columns:1.4fr repeat(3,1fr);padding:19px 22px;margin-bottom:18px}.summary-strip>div{padding:0 22px;border-left:1px solid var(--line)}.summary-strip>div:first-child{padding-left:0;border-left:0}.summary-strip span,.summary-strip strong{display:block}.summary-strip span{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700}.summary-strip strong{font:700 18px 'Manrope';margin-top:6px}.search{max-width:330px}.push{margin-left:auto}.device-list{border:0}:deep(.el-collapse-item__header){height:auto;min-height:80px;padding:0 20px;border-color:var(--line)}:deep(.el-collapse-item__wrap){border-color:var(--line)}:deep(.el-collapse-item__content){padding:0 20px 20px}.device-head{width:100%;display:grid;grid-template-columns:42px minmax(180px,1.3fr) 1fr .7fr 100px;gap:12px;align-items:center;padding-right:10px}.device-icon{position:relative;width:38px;height:38px;border-radius:10px;background:#f0f1f7;display:grid;place-items:center}.device-icon i{position:absolute;right:-1px;bottom:-1px;width:9px;height:9px;border-radius:50%;border:2px solid #fff}.device-name strong,.device-name span,.device-location span,.device-location strong,.device-seen span,.device-seen strong{display:block}.device-name span,.device-location span,.device-seen span{font-size:10px;color:var(--muted);margin-top:3px}.device-location strong,.device-seen strong{font-size:11px;margin-top:4px}.device-meta{display:flex;align-items:center;gap:16px;padding:12px 14px;background:#f7f8fb;border-radius:10px;margin:5px 0 15px;font-size:10px;color:var(--muted);flex-wrap:wrap}.device-meta b{color:var(--ink);margin-left:4px}.device-meta .ok{color:var(--teal)}.device-meta .bad{color:var(--danger)}.sim-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.sim-card{border:1px solid var(--line);border-radius:12px;padding:15px}.sim-card header,.sim-card footer,.limit>div{display:flex;justify-content:space-between;align-items:center;gap:8px}.slot{font-size:10px;font-weight:800;letter-spacing:.08em;color:var(--primary)}.sim-id{margin:16px 0}.sim-id strong,.sim-id span,.sim-balance span,.sim-balance strong,.sim-balance small{display:block}.sim-id strong{font-size:14px}.sim-id span{color:var(--muted);font-size:11px;margin-top:4px}.sim-balance{padding:12px;background:#f7f8fb;border-radius:9px}.sim-balance span,.limit span,.limit small{font-size:10px;color:var(--muted)}.sim-balance strong{font:700 18px 'Manrope';margin:4px 0}.sim-balance small.stale{color:var(--danger)}.limit{padding:13px 2px}.limit b{font-size:11px}.limit small{display:block;margin-top:6px}.sim-card footer{border-top:1px solid var(--line);padding-top:12px}.recovery-sim{border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0;background:#fafbfc}.recovery-sim strong{display:block;margin-bottom:10px}.recovery-code{padding:18px;border-radius:10px;background:#f1f5f3;margin:16px 0}.recovery-code code{display:block;font-size:24px;letter-spacing:.08em;color:var(--primary);word-break:break-all}.recovery-code small{display:block;color:var(--muted);margin-top:8px}
@media(max-width:900px){.summary-strip{grid-template-columns:1fr 1fr;gap:16px}.summary-strip>div:nth-child(3){border-left:0;padding-left:0}.device-head{grid-template-columns:42px 1fr 90px}.sim-grid{grid-template-columns:1fr}}@media(max-width:600px){.summary-strip{grid-template-columns:1fr}.summary-strip>div{border-left:0!important;padding:8px 0}.device-head{grid-template-columns:38px 1fr 80px}.filters .push{margin-left:0}}
</style>
