<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ChatLineRound, Connection, Refresh, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { usePlatformStore, type AdminSupportCase, type AdminSupportStatus } from '../stores/platform'

const platform = usePlatformStore()
const router = useRouter()
const loading = ref(false)
const query = ref('')
const selectedId = ref('')
const statusDialog = ref(false)
const statusForm = reactive({ status: 'investigating' as AdminSupportStatus, reason: '' })
const response = reactive({ message: '', evidenceReference: '', includeProposal: false, proposalKind: 'provider_transaction', proposalReference: '', proposalExplanation: '' })
const canWrite = computed(() => ['admin', 'operator'].includes(platform.identity?.role ?? ''))
const selectedCase = computed(() => platform.supportCases.find((item) => item.id === selectedId.value) ?? null)
const visibleCases = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return needle ? platform.supportCases.filter((item) => [item.subject, item.reference, item.merchant?.name, item.status].some((value) => value?.toLocaleLowerCase().includes(needle))) : platform.supportCases
})

function tagType(status: AdminSupportStatus) {
  if (status === 'resolved' || status === 'closed') return 'success'
  if (status === 'awaiting_merchant') return 'warning'
  if (status === 'investigating') return 'primary'
  return 'info'
}

async function selectCase(item: AdminSupportCase) {
  selectedId.value = item.id
  if (item.messages) return
  loading.value = true
  try { await platform.loadSupportCase(item.id) }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : 'Could not load support case') }
  finally { loading.value = false }
}

async function load() {
  loading.value = true
  try {
    await platform.loadSupportCases()
    if (!selectedId.value && platform.supportCases[0]) await selectCase(platform.supportCases[0])
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'Could not load support cases') }
  finally { loading.value = false }
}

async function sendResponse() {
  if (!selectedCase.value || response.message.trim().length < 2) { ElMessage.warning('Write a response first.'); return }
  if (response.includeProposal && !response.proposalReference.trim()) { ElMessage.warning('Enter a proposed match reference.'); return }
  loading.value = true
  try {
    await platform.addSupportMessage(selectedCase.value.id, {
      message: response.message.trim(),
      ...(response.evidenceReference.trim() ? { evidence_reference: response.evidenceReference.trim() } : {}),
      ...(response.includeProposal ? { proposed_match: { kind: response.proposalKind, reference: response.proposalReference.trim(), ...(response.proposalExplanation.trim() ? { explanation: response.proposalExplanation.trim() } : {}) } } : {}),
    })
    Object.assign(response, { message: '', evidenceReference: '', includeProposal: false, proposalKind: 'provider_transaction', proposalReference: '', proposalExplanation: '' })
    ElMessage.success('Merchant update sent and audited')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'Could not send response') }
  finally { loading.value = false }
}

function openStatus() {
  if (!selectedCase.value) return
  statusForm.status = selectedCase.value.status === 'open' ? 'investigating' : selectedCase.value.status
  statusForm.reason = ''
  statusDialog.value = true
}

async function changeStatus() {
  if (!selectedCase.value || statusForm.reason.trim().length < 10) { ElMessage.warning('Record a reason of at least 10 characters.'); return }
  loading.value = true
  try {
    await platform.changeSupportStatus(selectedCase.value.id, statusForm.status, statusForm.reason.trim())
    statusDialog.value = false
    ElMessage.success('Communication workflow updated; no financial state changed')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'Could not update status') }
  finally { loading.value = false }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-heading"><div><p class="eyebrow">Merchant communication</p><h1>Support cases</h1><span class="muted">Review tenant-scoped notes, evidence references, and match proposals without changing financial records.</span></div><el-button :icon="Refresh" :loading="loading" @click="load">Refresh</el-button></div>
    <el-alert title="Closing or resolving this workflow never posts to the ledger or resolves an unknown payout. Use Reconciliation for separately authenticated financial actions." type="warning" :closable="false" show-icon class="safety" />
    <div class="support-layout">
      <section class="panel case-list" v-loading="loading">
        <div class="filters"><el-input v-model="query" :prefix-icon="Search" clearable placeholder="Merchant, reference, or subject" /></div>
        <button v-for="item in visibleCases" :key="item.id" :class="{ active: selectedId === item.id }" @click="selectCase(item)">
          <div><strong>{{ item.subject }}</strong><span>{{ item.merchant?.name || 'Unknown merchant' }} &middot; {{ item.reference || item.category.replace(/_/g, ' ') }}</span><small>{{ item.message_count }} messages &middot; {{ new Date(item.updated_at).toLocaleString() }}</small></div>
          <el-tag size="small" :type="tagType(item.status)">{{ item.status.replace('_', ' ') }}</el-tag>
        </button>
        <el-empty v-if="!visibleCases.length" :image-size="80" description="No support cases" />
      </section>

      <section v-if="selectedCase" class="panel detail" v-loading="loading">
        <div class="panel-head"><div><p class="eyebrow">{{ selectedCase.merchant?.slug }} &middot; {{ selectedCase.environment }}</p><h2>{{ selectedCase.subject }}</h2><span class="muted small">{{ selectedCase.reference || selectedCase.id }}</span></div><div class="head-actions"><el-tag :type="tagType(selectedCase.status)">{{ selectedCase.status.replace('_', ' ') }}</el-tag><el-button v-if="canWrite" size="small" @click="openStatus">Change workflow</el-button></div></div>
        <div v-if="selectedCase.workflow_note" class="workflow"><strong>Workflow note</strong><span>{{ selectedCase.workflow_note }}</span></div>
        <div class="messages">
          <article v-for="message in selectedCase.messages || []" :key="message.id" :class="message.author.type === 'platform_staff' ? 'platform' : 'merchant'">
            <span>{{ message.author.display_name }} &middot; {{ new Date(message.created_at).toLocaleString() }}</span>
            <p>{{ message.body }}</p>
            <div v-if="message.evidence_reference" class="attachment"><el-icon><Connection /></el-icon>{{ message.evidence_reference }}</div>
            <div v-if="message.proposed_match" class="proposal"><strong>Merchant proposal - unverified</strong><span>{{ message.proposed_match.kind.replace(/_/g, ' ') }}: {{ message.proposed_match.reference }}</span><small v-if="message.proposed_match.explanation">{{ message.proposed_match.explanation }}</small></div>
          </article>
        </div>
        <div v-if="canWrite && selectedCase.status !== 'closed'" class="compose">
          <el-input v-model="response.message" type="textarea" :rows="3" maxlength="5000" show-word-limit placeholder="Reply to the merchant..." />
          <div class="options"><el-input v-model="response.evidenceReference" maxlength="500" placeholder="Evidence reference (optional)"/><el-checkbox v-model="response.includeProposal">Attach staff match proposal</el-checkbox></div>
          <div v-if="response.includeProposal" class="proposal-inputs"><el-select v-model="response.proposalKind"><el-option label="Provider transaction" value="provider_transaction"/><el-option label="Incoming receipt" value="incoming_receipt"/><el-option label="Deposit intent" value="deposit_intent"/><el-option label="Withdrawal" value="withdrawal"/></el-select><el-input v-model="response.proposalReference" placeholder="Reference"/><el-input v-model="response.proposalExplanation" placeholder="Explanation"/></div>
          <div class="actions"><el-button plain @click="router.push('/reconciliation')">Open Reconciliation</el-button><el-button type="primary" :icon="ChatLineRound" :loading="loading" @click="sendResponse">Send response</el-button></div>
        </div>
        <el-alert v-else-if="selectedCase.status === 'closed'" title="This case is closed. Reopen the workflow to continue the conversation." type="success" :closable="false" show-icon class="closed" />
        <el-alert v-else title="Your role can inspect support cases but cannot post or change workflow status." type="info" :closable="false" show-icon class="closed" />
      </section>
      <section v-else class="panel empty-detail"><el-empty description="Select a support case" /></section>
    </div>

    <el-dialog v-model="statusDialog" title="Change support workflow" width="min(500px,94vw)">
      <el-alert title="This changes communication workflow only. It does not resolve any transaction or ledger entry." type="info" :closable="false" show-icon />
      <el-form label-position="top" style="margin-top:16px"><el-form-item label="Status"><el-select v-model="statusForm.status" style="width:100%"><el-option label="Open" value="open"/><el-option label="Investigating" value="investigating"/><el-option label="Awaiting merchant" value="awaiting_merchant"/><el-option label="Resolved (communication)" value="resolved"/><el-option label="Closed" value="closed"/></el-select></el-form-item><el-form-item label="Audited workflow reason"><el-input v-model="statusForm.reason" type="textarea" :rows="3" maxlength="1000" show-word-limit /></el-form-item></el-form>
      <template #footer><el-button @click="statusDialog = false">Cancel</el-button><el-button type="primary" :loading="loading" @click="changeStatus">Update workflow</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.safety{margin-bottom:18px}.support-layout{display:grid;grid-template-columns:minmax(300px,.8fr) minmax(520px,1.6fr);gap:18px}.case-list{overflow:hidden;align-self:start;min-height:500px}.case-list>button{width:100%;border:0;border-top:1px solid var(--line);background:#fff;padding:15px 18px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;text-align:left;cursor:pointer}.case-list>button:hover{background:#fafaff}.case-list>button.active{background:#f1f1ff;border-left:3px solid var(--primary);padding-left:15px}.case-list strong,.case-list span,.case-list small{display:block}.case-list strong{font-size:12px}.case-list span,.case-list small{font-size:10px;color:var(--muted);margin-top:5px}.head-actions{display:flex;gap:8px;align-items:center}.detail{min-height:610px;display:flex;flex-direction:column;overflow:hidden}.workflow{padding:11px 22px;background:#fff7e7;color:#875914;display:flex;gap:9px;font-size:11px}.messages{padding:20px 22px;background:#fbfcfe;flex:1;overflow-y:auto;max-height:510px}.messages article{max-width:82%;margin-bottom:17px}.messages article>span{font-size:10px;color:var(--muted)}.messages article>p{padding:12px 14px;margin:5px 0;background:#eef1f5;border-radius:4px 12px 12px 12px;font-size:12px;line-height:1.55;white-space:pre-wrap}.messages .platform{margin-left:auto}.messages .platform>p{background:#ebebff;border-radius:12px 4px 12px 12px}.attachment,.proposal{margin-top:6px;padding:8px 10px;border:1px solid var(--line);background:#fff;border-radius:8px;color:var(--muted);font-size:10px;display:flex;align-items:center;gap:7px;overflow-wrap:anywhere}.proposal{display:grid;border-color:#ddddff;color:#56587e}.proposal strong{text-transform:uppercase;font-size:9px}.proposal small{font-size:10px}.compose{border-top:1px solid var(--line);padding:16px 20px}.options{display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px;margin-top:10px}.proposal-inputs{display:grid;grid-template-columns:170px 1fr 1fr;gap:8px;margin-top:9px}.actions{display:flex;justify-content:space-between;margin-top:11px}.closed{margin:18px}.empty-detail{min-height:610px;display:grid;place-items:center}@media(max-width:1000px){.support-layout{grid-template-columns:1fr}.case-list{min-height:0;max-height:330px;overflow:auto}.proposal-inputs{grid-template-columns:1fr}}@media(max-width:650px){.options{grid-template-columns:1fr}.head-actions{align-items:flex-end;flex-direction:column}}
</style>
