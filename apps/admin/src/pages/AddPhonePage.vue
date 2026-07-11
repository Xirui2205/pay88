<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Check, CopyDocument, Download, Printer, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { usePlatformStore } from '../stores/platform'

const platform = usePlatformStore()
const route = useRoute()
const router = useRouter()
const active = ref(0)
const language = ref<'en'|'zh'>('en')
const loading = ref(false)
const online = ref(false)
const groups = ref<Array<{id:string;label:string}>>([])
const locations = ref<Array<{id:string;label:string}>>([])
const structureDialog = ref(false)
const structureMode = ref<'location'|'group'>('group')
const structure = ref({ locationId: '', code: '', name: '' })
const form = ref({
  name: '', groupId: '', model: 'TECNO CAMON 18 Premier',
  sims: [
    { slot: 0, iccid: '', phone_number: '', account_name: '' },
    { slot: 1, iccid: '', phone_number: '', account_name: '' },
  ],
})
const created = ref<any>(null)
const code = computed(() => String(created.value?.activation_code ?? ''))
const expires = computed(() => created.value?.activation_expires_at ? new Date(created.value.activation_expires_at).toLocaleTimeString() : '—')
const fieldManualUrl = computed(() => language.value === 'en' ? '/manuals/telebirr-field-phone-installation-en.pdf' : '/manuals/telebirr-field-phone-installation-zh-CN.pdf')

async function loadFleetOptions() {
  if (platform.demoMode) return
  const tree = await platform.fleetTree()
  locations.value = tree.map((location:any) => ({ id: location.id, label: location.name }))
  groups.value = tree.flatMap((location:any) => location.groups.map((group:any) => ({ id: group.id, label: `${location.name} · ${group.name}` })))
  if (!groups.value.some((item) => item.id === form.value.groupId)) form.value.groupId = groups.value[0]?.id ?? ''
}

function routeDeviceId() {
  const value = Array.isArray(route.query.device) ? route.query.device[0] : route.query.device
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : ''
}

async function resumeFromRoute() {
  const deviceId = routeDeviceId()
  if (!deviceId || platform.demoMode) return
  loading.value = true
  try {
    created.value = await platform.getDevice(deviceId)
    form.value.name = created.value.name
    online.value = created.value.status === 'online'
    active.value = created.value.activation_consumed ? 2 : 1
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not load phone')
  } finally { loading.value = false }
}

onMounted(async () => { await loadFleetOptions(); await resumeFromRoute() })

function openStructure(mode:'location'|'group') {
  structureMode.value = mode
  structure.value = { locationId: locations.value[0]?.id ?? '', code: '', name: '' }
  structureDialog.value = true
}

async function saveStructure() {
  if (!structure.value.code.trim() || !structure.value.name.trim() || (structureMode.value === 'group' && !structure.value.locationId)) {
    ElMessage.warning('Complete the required fields')
    return
  }
  loading.value = true
  try {
    if (structureMode.value === 'location') await platform.createLocation({ code: structure.value.code.trim(), name: structure.value.name.trim() })
    else await platform.createGroup({ location_id: structure.value.locationId, code: structure.value.code.trim(), name: structure.value.name.trim() })
    await loadFleetOptions()
    structureDialog.value = false
    ElMessage.success('Created')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'Could not create') }
  finally { loading.value = false }
}

async function createRecord() {
  if (!form.value.name.trim() || !form.value.groupId || form.value.sims.some((sim) => !sim.iccid.trim() || !sim.phone_number || !sim.account_name.trim())) {
    ElMessage.warning('Fill in the phone and SIM details')
    return
  }
  loading.value = true
  try {
    created.value = await platform.createDevice({
      group_id: form.value.groupId, name: form.value.name.trim(), model: form.value.model,
      sims: form.value.sims.map((sim) => ({ ...sim, iccid: sim.iccid.replace(/\s/g, '') })),
    })
    await router.replace({ name: 'add-phone', query: { device: created.value.id } })
    active.value = 1
    ElMessage.success('Phone added')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'Could not add phone') }
  finally { loading.value = false }
}

async function regenerate() {
  if (!created.value?.id) return
  loading.value = true
  try { created.value = { ...created.value, ...await platform.regenerateActivationCode(created.value.id) }; ElMessage.success('New activation code created') }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : 'Could not create activation code') }
  finally { loading.value = false }
}

function copy() { navigator.clipboard?.writeText(code.value); ElMessage.success('Activation code copied') }

async function updateOnline(value:boolean|string|number) {
  if (!created.value?.id) return
  loading.value = true
  try {
    const result = await platform.setDeviceOnline(created.value.id, Boolean(value))
    created.value = { ...created.value, ...result }
    online.value = result.status === 'online'
    ElMessage.success(online.value ? 'Phone is online' : 'Phone is offline')
  } catch (error) {
    online.value = !Boolean(value)
    ElMessage.error(error instanceof Error ? error.message : 'Could not change phone status')
  } finally { loading.value = false }
}

function next() {
  if (active.value === 0) return createRecord()
  if (active.value === 1) active.value = 2
}
</script>

<template>
  <div class="page add-page">
    <div class="page-heading"><div><p class="eyebrow">Fleet</p><h1>Add phone</h1><span class="muted">Add the SIM details, install the app, then set the phone online.</span></div><el-button @click="$router.push('/fleet')">Close</el-button></div>
    <el-steps :active="active" finish-status="success" simple class="steps"><el-step title="Phone details"/><el-step title="Install app"/><el-step title="Online status"/></el-steps>

    <section v-if="active===0" class="panel wizard">
      <div class="panel-head"><div><h2>1. Phone details</h2></div><div class="toolbar"><el-button size="small" @click="openStructure('location')">New location</el-button><el-button size="small" @click="openStructure('group')">New group</el-button></div></div>
      <div class="panel-body form-grid">
        <el-form-item label="Phone name"><el-input v-model="form.name" placeholder="AA-Bole-04"/></el-form-item>
        <el-form-item label="Group"><el-select v-model="form.groupId" style="width:100%"><el-option v-for="group in groups" :key="group.id" :label="group.label" :value="group.id"/></el-select></el-form-item>
        <el-form-item label="Model"><el-input v-model="form.model"/></el-form-item>
        <article v-for="sim in form.sims" :key="sim.slot" class="sim-form"><header>SIM {{sim.slot+1}}</header><el-form-item label="ICCID"><el-input v-model="sim.iccid"/></el-form-item><el-form-item label="Telebirr number"><el-input v-model="sim.phone_number" placeholder="09… or +2519…"/></el-form-item><el-form-item label="Telebirr name"><el-input v-model="sim.account_name"/></el-form-item></article>
      </div>
    </section>

    <section v-else-if="active===1" class="panel wizard">
      <div class="panel-head"><div><h2>2. Install and activate</h2><span class="muted small">{{created?.name}}</span></div><el-radio-group v-model="language" size="small"><el-radio-button value="en">English</el-radio-button><el-radio-button value="zh">中文</el-radio-button></el-radio-group></div>
      <div class="activation-grid panel-body">
        <div class="activation"><template v-if="code"><span>Activation code</span><strong>{{code}}</strong><small>Expires {{expires}}</small><div class="toolbar"><el-button :icon="CopyDocument" @click="copy">Copy</el-button><el-button :icon="Refresh" :loading="loading" @click="regenerate">New code</el-button></div></template><template v-else><p>The code was already displayed. Create a new one if the phone is not activated yet.</p><el-button type="primary" :icon="Refresh" @click="regenerate">Create new code</el-button></template></div>
        <div class="manual-card"><span>Phone instructions</span><strong>{{language==='en'?'Simple English setup guide':'简体中文安装指南'}}</strong><p>Give this guide to the person installing the phone.</p><div class="toolbar"><el-button tag="a" :href="fieldManualUrl" target="_blank" :icon="Printer">Open</el-button><el-button tag="a" :href="fieldManualUrl" download :icon="Download">Download PDF</el-button></div></div>
      </div>
    </section>

    <section v-else class="panel wizard status-panel">
      <div class="done"><el-icon><Check/></el-icon></div><h2>{{created?.name}}</h2><p>Switch this phone on when it is ready to receive deposits and send withdrawals.</p>
      <div class="online-control"><span>Status</span><el-switch v-model="online" :loading="loading" size="large" active-text="Online" inactive-text="Offline" @change="updateOnline"/></div>
      <el-button type="primary" @click="$router.push('/fleet')">Open fleet</el-button>
    </section>

    <div v-if="active<2" class="wizard-actions"><el-button v-if="active===1" @click="active=0">Back</el-button><el-button type="primary" :loading="loading" @click="next">{{active===0?'Add phone':'Continue'}}</el-button></div>
    <el-dialog v-model="structureDialog" :title="structureMode==='location'?'Create location':'Create group'" width="min(500px,92vw)"><el-form label-position="top"><el-form-item v-if="structureMode==='group'" label="Location"><el-select v-model="structure.locationId" style="width:100%"><el-option v-for="location in locations" :key="location.id" :label="location.label" :value="location.id"/></el-select></el-form-item><el-form-item label="Code"><el-input v-model="structure.code"/></el-form-item><el-form-item label="Name"><el-input v-model="structure.name"/></el-form-item></el-form><template #footer><el-button @click="structureDialog=false">Cancel</el-button><el-button type="primary" :loading="loading" @click="saveStructure">Create</el-button></template></el-dialog>
  </div>
</template>

<style scoped>
.add-page{max-width:1050px}.steps{margin-bottom:18px;border:1px solid var(--line);background:#fff}.wizard{min-height:360px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 20px}.sim-form{border:1px solid var(--line);border-radius:12px;padding:15px}.sim-form header{font-weight:800;color:var(--primary);margin-bottom:12px}.wizard-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.activation-grid{display:grid;grid-template-columns:1fr;gap:20px}.activation{padding:24px;background:#f7f8fb;border-radius:12px}.activation>span,.activation>strong,.activation>small,.manual-card>span{display:block}.activation>span,.manual-card>span{font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:700}.activation>strong{font:800 30px 'Manrope';letter-spacing:.12em;margin:9px 0}.activation>small{font-size:10px;color:var(--muted);margin:-4px 0 12px}.activation p,.manual-card p{font-size:11px;color:var(--muted);line-height:1.6}.manual-card{padding:18px;background:#f6f6ff;border-radius:11px}.manual-card strong{display:block;margin-top:7px}.status-panel{text-align:center;padding:65px 20px}.done{width:58px;height:58px;border-radius:50%;display:grid;place-items:center;background:#e7f7f3;color:var(--teal);font-size:28px;margin:0 auto 15px}.status-panel p{color:var(--muted);font-size:12px}.online-control{display:flex;align-items:center;justify-content:center;gap:22px;padding:22px;margin:24px auto;max-width:390px;background:#f7f8fb;border-radius:12px}.online-control span{font-weight:700}@media(max-width:850px){.form-grid{grid-template-columns:1fr}}
</style>
