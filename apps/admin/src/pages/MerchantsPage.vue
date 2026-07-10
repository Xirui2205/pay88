<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { CirclePlus, CopyDocument, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import StatusPill from '../components/StatusPill.vue'
import { usePlatformStore } from '../stores/platform'

const platform = usePlatformStore()
const query = ref('')
const dialog = ref(false)
const loading = ref(false)
const password = ref('')
const form = reactive({ name:'', slug:'', owner_email:'', initial_test_balance:'0.00' })
const credentials = ref<{owner_invitation:{email:string;token:string;expires_at:string};keys:Array<{environment:string;secret_key:string}>}|null>(null)
const policyDialog=ref(false),policyMerchantId=ref(''),policyMerchantName=ref(''),policyPassword=ref('')
const fleetGroups=ref<Array<{id:string;label:string}>>([])
const policy=reactive({group_id:'',dedicated:false,priority:100,reason:''})
const demoMerchants = [
  { name:'AsterBet', initials:'AB', id:'mrc_2f84a1', mode:'Live', policy:'Shared A', volume:'ETB 8.21M', available:'ETB 4.18M', users:8, health:'healthy' },
  { name:'Blue Nile Play', initials:'BN', id:'mrc_9b26d3', mode:'Live', policy:'Shared A', volume:'ETB 6.44M', available:'ETB 2.92M', users:5, health:'healthy' },
  { name:'Lucy Games', initials:'LG', id:'mrc_118ca9', mode:'Live', policy:'Merchant North', volume:'ETB 3.77M', available:'ETB 1.04M', users:4, health:'warning' },
  { name:'Pilot Sandbox', initials:'PS', id:'mrc_test_01', mode:'Test', policy:'Simulator', volume:'—', available:'ETB 0.00', users:2, health:'healthy' },
]
const merchants = computed(() => platform.demoMode ? demoMerchants : platform.merchants.map((merchant) => ({name:merchant.name,initials:merchant.name.split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase(),id:merchant.id,mode:'Live',policy:merchant.fleet_policies.map(x=>x.group).join(', ')||'Shared',volume:'—',available:`ETB ${merchant.available}`,users:merchant.user_count,health:merchant.status==='active'?'healthy':'warning'})))
watch(() => form.name, (name) => { if (!form.slug) form.slug = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80) })

async function create() {
  if (platform.demoMode) { ElMessage.warning('Merchant creation is disabled in demo mode'); return }
  loading.value = true
  try {
    credentials.value = await platform.createMerchant({slug:form.slug,name:form.name,owner_email:form.owner_email,...(form.initial_test_balance && form.initial_test_balance !== '0.00' ? {initial_test_balance:form.initial_test_balance}: {})},password.value)
    dialog.value = false
    password.value = ''
    ElMessage.success('Merchant created; copy the one-time credentials now')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'Could not create merchant') }
  finally { loading.value = false }
}

async function copy(value:string) { await navigator.clipboard.writeText(value); ElMessage.success('Secret copied') }
async function openPolicy(merchantId:string,merchantName:string){if(platform.demoMode){ElMessage.warning('Fleet policy changes require an authenticated platform session');return}policyMerchantId.value=merchantId;policyMerchantName.value=merchantName;if(!fleetGroups.value.length){const tree=await platform.fleetTree();fleetGroups.value=tree.flatMap((location:any)=>location.groups.map((group:any)=>({id:group.id,label:`${location.name} · ${group.name}`})))}policy.group_id=fleetGroups.value[0]?.id??'';loadPolicyDefaults();policy.reason='';policyPassword.value='';policyDialog.value=true}
function loadPolicyDefaults(){const existing=platform.merchants.find(item=>item.id===policyMerchantId.value)?.fleet_policies.find(item=>item.group_id===policy.group_id);policy.dedicated=existing?.dedicated??false;policy.priority=existing?.priority??100}
async function savePolicy(){if(!policy.group_id||policy.reason.trim().length<10||!policyPassword.value){ElMessage.warning('Select a group, provide an audited reason and reauthenticate');return}loading.value=true;try{await platform.upsertMerchantGroupPolicy({group_id:policy.group_id,merchant_id:policyMerchantId.value,dedicated:policy.dedicated,priority:Number(policy.priority),reason:policy.reason.trim()},policyPassword.value);policyDialog.value=false;ElMessage.success('Merchant fleet policy activated')}catch(error){ElMessage.error(error instanceof Error?error.message:'Could not update fleet policy')}finally{loading.value=false}}
async function removePolicy(){const existing=platform.merchants.find(item=>item.id===policyMerchantId.value)?.fleet_policies.some(item=>item.group_id===policy.group_id);if(!existing){ElMessage.info('This merchant has no explicit policy for the selected group');return}if(policy.reason.trim().length<10||!policyPassword.value){ElMessage.warning('Provide an audited reason and reauthenticate');return}loading.value=true;try{await platform.removeMerchantGroupPolicy({group_id:policy.group_id,merchant_id:policyMerchantId.value,reason:policy.reason.trim()},policyPassword.value);policyDialog.value=false;ElMessage.success('Explicit policy removed; shared-group rules now apply')}catch(error){ElMessage.error(error instanceof Error?error.message:'Could not remove fleet policy')}finally{loading.value=false}}
onMounted(() => platform.loadMerchants())
</script>

<template>
  <div class="page">
    <div class="page-heading"><div><p class="eyebrow">Tenant administration</p><h1>Merchants</h1><span class="muted">Accounts, configuration approvals and aggregate liquidity.</span></div><el-button type="primary" :icon="CirclePlus" @click="dialog=true">Create merchant</el-button></div>
    <el-alert v-if="credentials" title="One-time merchant credentials" type="warning" :closable="false" show-icon class="credentials"><p>Owner invitation for {{credentials.owner_invitation.email}}, expires {{new Date(credentials.owner_invitation.expires_at).toLocaleString()}}</p><div class="secret"><code>{{credentials.owner_invitation.token}}</code><el-button :icon="CopyDocument" @click="copy(credentials.owner_invitation.token)">Copy invitation</el-button></div><div v-for="key in credentials.keys" :key="key.environment" class="secret"><b>{{key.environment}}</b><code>{{key.secret_key}}</code><el-button :icon="CopyDocument" @click="copy(key.secret_key)">Copy key</el-button></div></el-alert>
    <div class="panel"><div class="filters"><el-input v-model="query" :prefix-icon="Search" placeholder="Search merchant or ID" class="search" clearable/></div><div class="merchant-grid"><article v-for="merchant in merchants.filter(item=>JSON.stringify(item).toLowerCase().includes(query.toLowerCase()))" :key="merchant.id"><header><div :class="['logo', merchant.mode.toLowerCase()]">{{merchant.initials}}</div><div><strong>{{merchant.name}}</strong><span>{{merchant.id}} · {{merchant.mode}}</span></div><StatusPill :status="merchant.health"/></header><dl><div><dt>24h volume</dt><dd>{{merchant.volume}}</dd></div><div><dt>Available ledger</dt><dd>{{merchant.available}}</dd></div><div><dt>Fleet policy</dt><dd>{{merchant.policy}}</dd></div><div><dt>Users</dt><dd>{{merchant.users}}</dd></div></dl><footer><el-button size="small" @click="openPolicy(merchant.id,merchant.name)">Fleet policy</el-button><code>{{merchant.id}}</code></footer></article></div></div>
    <el-dialog v-model="dialog" title="Create merchant" width="min(560px,94vw)"><el-alert title="Test and live secret keys plus the owner invitation are displayed once." type="warning" :closable="false" show-icon/><el-form label-position="top" class="create-form"><el-form-item label="Merchant name"><el-input v-model="form.name" maxlength="200"/></el-form-item><el-form-item label="Slug"><el-input v-model="form.slug" maxlength="80"/></el-form-item><el-form-item label="Owner email"><el-input v-model="form.owner_email" type="email" maxlength="320"/></el-form-item><el-form-item label="Initial test balance (optional)"><el-input v-model="form.initial_test_balance" inputmode="decimal"/></el-form-item><el-form-item label="Your password"><el-input v-model="password" type="password" show-password autocomplete="current-password"/></el-form-item></el-form><template #footer><el-button @click="dialog=false">Cancel</el-button><el-button type="primary" :loading="loading" @click="create">Create and issue credentials</el-button></template></el-dialog>
    <el-dialog v-model="policyDialog" :title="`Fleet policy · ${policyMerchantName}`" width="min(560px,94vw)"><el-alert title="A dedicated group is excluded from merchants without an explicit policy. This change is immediate and audited." type="warning" :closable="false" show-icon/><el-form label-position="top" class="create-form"><el-form-item label="Fleet group"><el-select v-model="policy.group_id" style="width:100%" @change="loadPolicyDefaults"><el-option v-for="group in fleetGroups" :key="group.id" :label="group.label" :value="group.id"/></el-select></el-form-item><el-form-item label="Assignment priority"><el-input-number v-model="policy.priority" :min="1" :max="1000"/></el-form-item><el-form-item label="Dedicated access"><el-switch v-model="policy.dedicated"/><span class="muted small policy-note">Exclude unassigned merchants from this group</span></el-form-item><el-form-item label="Audited reason"><el-input v-model="policy.reason" type="textarea" :rows="3" maxlength="1000"/></el-form-item><el-form-item label="Your password"><el-input v-model="policyPassword" type="password" show-password autocomplete="current-password"/></el-form-item></el-form><template #footer><el-button type="danger" plain :loading="loading" @click="removePolicy">Remove explicit policy</el-button><el-button @click="policyDialog=false">Cancel</el-button><el-button type="primary" :loading="loading" @click="savePolicy">Save policy</el-button></template></el-dialog>
  </div>
</template>

<style scoped>
.search{max-width:350px}.credentials{margin-bottom:17px}.credentials p{font-size:11px}.secret{display:grid;grid-template-columns:70px 1fr auto;gap:10px;align-items:center;margin-top:9px}.secret code{overflow-wrap:anywhere;font-size:9px;background:#fff7e8;padding:8px;border-radius:7px}.merchant-grid{padding:18px;display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.merchant-grid article{border:1px solid var(--line);border-radius:13px;padding:17px}.merchant-grid header{display:grid;grid-template-columns:42px 1fr auto;gap:11px;align-items:center}.logo{width:42px;height:42px;border-radius:11px;background:#ececff;color:var(--primary);display:grid;place-items:center;font:800 12px 'Manrope'}.logo.test{background:#e9f7f4;color:var(--teal)}header strong,header span{display:block}header strong{font:700 13px 'Manrope'}header span{font-size:10px;color:var(--muted);margin-top:4px}dl{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin:20px 0}dl div{padding:11px;background:#f7f8fb;border-radius:8px}dt{font-size:9px;color:var(--muted);text-transform:uppercase}dd{font-size:12px;font-weight:700;margin:5px 0 0}.merchant-grid footer{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding-top:12px}.merchant-grid footer code{font-size:8px;color:var(--muted)}.create-form{margin-top:17px}.policy-note{margin-left:10px}@media(max-width:800px){.merchant-grid{grid-template-columns:1fr}.secret{grid-template-columns:1fr}.secret b{display:none}}
</style>
