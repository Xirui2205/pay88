<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { CirclePlus, Link, Promotion, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useMerchantStore, type PortalSupportCase, type SupportCaseCategory, type SupportProposedMatch } from '../stores/merchant'

const store = useMerchantStore()
const loading = ref(false)
const sending = ref(false)
const query = ref('')
const selectedId = ref('')
const createDialog = ref(false)
const includeProposal = ref(false)
const includeReplyProposal = ref(false)

const createForm = reactive({
  category: 'withdrawal_outcome' as SupportCaseCategory,
  subject: '',
  reference: '',
  message: '',
  evidenceReference: '',
  proposalKind: 'provider_transaction' as SupportProposedMatch['kind'],
  proposalReference: '',
  proposalExplanation: '',
})
const reply = reactive({ message: '', evidenceReference: '', proposalKind: 'provider_transaction' as SupportProposedMatch['kind'], proposalReference: '', proposalExplanation: '' })

const visibleCases = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return needle
    ? store.supportCases.filter((item) => [item.subject, item.reference, item.id, item.status].some((value) => value?.toLocaleLowerCase().includes(needle)))
    : store.supportCases
})
const selectedCase = computed(() => store.supportCases.find((item) => item.id === selectedId.value) ?? null)
const canReply = computed(() => selectedCase.value && selectedCase.value.status !== 'closed')

const categories: Array<{ value: SupportCaseCategory; label: string }> = [
  { value: 'transaction_match', label: 'Deposit or receipt match' },
  { value: 'withdrawal_outcome', label: 'Withdrawal outcome' },
  { value: 'topup', label: 'Merchant top-up' },
  { value: 'settlement', label: 'Settlement request' },
  { value: 'webhook', label: 'Webhook delivery' },
  { value: 'api', label: 'API integration' },
  { value: 'other', label: 'Other' },
]

function statusType(status: PortalSupportCase['status']) {
  if (status === 'resolved' || status === 'closed') return 'success'
  if (status === 'awaiting_merchant') return 'warning'
  if (status === 'investigating') return 'primary'
  return 'info'
}

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`
  return new Date(value).toLocaleDateString()
}

function proposal(enabled: boolean, kind: SupportProposedMatch['kind'], reference: string, explanation: string): SupportProposedMatch | undefined {
  if (!enabled || !reference.trim()) return undefined
  return { kind, reference: reference.trim(), ...(explanation.trim() ? { explanation: explanation.trim() } : {}) }
}

async function choose(item: PortalSupportCase) {
  selectedId.value = item.id
  if (item.messages) return
  loading.value = true
  try {
    await store.loadSupportCase(item.id)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not load this support case')
  } finally {
    loading.value = false
  }
}

async function load() {
  loading.value = true
  try {
    await store.loadSupportCases()
    if (!selectedId.value && store.supportCases[0]) await choose(store.supportCases[0])
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not load support cases')
  } finally {
    loading.value = false
  }
}

async function createCase() {
  if (createForm.subject.trim().length < 3 || createForm.message.trim().length < 2) {
    ElMessage.warning('Add a subject and a clear initial message.')
    return
  }
  if (includeProposal.value && !createForm.proposalReference.trim()) {
    ElMessage.warning('Enter the proposed match reference.')
    return
  }
  sending.value = true
  try {
    const created = await store.createSupportCase({
      category: createForm.category,
      subject: createForm.subject.trim(),
      ...(createForm.reference.trim() ? { reference: createForm.reference.trim() } : {}),
      message: createForm.message.trim(),
      ...(createForm.evidenceReference.trim() ? { evidence_reference: createForm.evidenceReference.trim() } : {}),
      proposed_match: proposal(includeProposal.value, createForm.proposalKind, createForm.proposalReference, createForm.proposalExplanation),
    })
    selectedId.value = created.id
    createDialog.value = false
    Object.assign(createForm, { category: 'withdrawal_outcome', subject: '', reference: '', message: '', evidenceReference: '', proposalKind: 'provider_transaction', proposalReference: '', proposalExplanation: '' })
    includeProposal.value = false
    ElMessage.success('Support case opened')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not open the case')
  } finally {
    sending.value = false
  }
}

async function sendReply() {
  if (!selectedCase.value || reply.message.trim().length < 2) {
    ElMessage.warning('Write a short update before sending.')
    return
  }
  if (includeReplyProposal.value && !reply.proposalReference.trim()) {
    ElMessage.warning('Enter the proposed match reference.')
    return
  }
  sending.value = true
  try {
    await store.addSupportMessage(selectedCase.value.id, {
      message: reply.message.trim(),
      ...(reply.evidenceReference.trim() ? { evidence_reference: reply.evidenceReference.trim() } : {}),
      proposed_match: proposal(includeReplyProposal.value, reply.proposalKind, reply.proposalReference, reply.proposalExplanation),
    })
    Object.assign(reply, { message: '', evidenceReference: '', proposalKind: 'provider_transaction', proposalReference: '', proposalExplanation: '' })
    includeReplyProposal.value = false
    ElMessage.success('Update sent to platform support')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not send the update')
  } finally {
    sending.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">Assisted resolution</p>
        <h1>Support cases</h1>
        <span class="muted">Share evidence and proposed matches while platform staff retain financial resolution authority.</span>
      </div>
      <el-button type="primary" :icon="CirclePlus" @click="createDialog = true">Open case</el-button>
    </div>

    <el-alert title="A resolved support case records communication workflow only. It never credits a deposit, retries a payout, or changes the ledger." type="info" :closable="false" show-icon class="scope-alert" />

    <div class="support-grid">
      <section class="panel list" v-loading="loading">
        <div class="filters"><el-input v-model="query" :prefix-icon="Search" clearable placeholder="Search cases" /></div>
        <div v-if="!visibleCases.length" class="empty-list"><el-empty :image-size="72" description="No support cases" /></div>
        <button v-for="item in visibleCases" :key="item.id" :class="{ active: selectedId === item.id }" @click="choose(item)">
          <div class="case-row"><strong>{{ item.subject }}</strong><el-tag size="small" :type="statusType(item.status)" effect="light">{{ item.status.replace('_', ' ') }}</el-tag></div>
          <span>{{ item.reference || item.category.replace(/_/g, ' ') }}</span>
          <small>{{ item.message_count }} update{{ item.message_count === 1 ? '' : 's' }} &middot; {{ relativeTime(item.updated_at) }}</small>
        </button>
      </section>

      <section v-if="selectedCase" class="panel conversation" v-loading="loading">
        <div class="panel-head case-head">
          <div>
            <p class="eyebrow">{{ selectedCase.id.slice(0, 8).toUpperCase() }}</p>
            <h2>{{ selectedCase.subject }}</h2>
            <span class="muted small">{{ selectedCase.reference || selectedCase.category.replace(/_/g, ' ') }} &middot; {{ selectedCase.environment.toUpperCase() }}</span>
          </div>
          <el-tag :type="statusType(selectedCase.status)" effect="light">{{ selectedCase.status.replace('_', ' ') }}</el-tag>
        </div>
        <div v-if="selectedCase.workflow_note" class="workflow-note"><strong>Platform workflow note</strong><span>{{ selectedCase.workflow_note }}</span></div>
        <div class="messages">
          <article v-for="message in selectedCase.messages || []" :key="message.id" :class="message.author.type === 'merchant_user' ? 'merchant' : 'support'">
            <span>{{ message.author.display_name }} &middot; {{ new Date(message.created_at).toLocaleString() }}</span>
            <p>{{ message.body }}</p>
            <div v-if="message.evidence_reference" class="evidence"><el-icon><Link /></el-icon><span>{{ message.evidence_reference }}</span></div>
            <div v-if="message.proposed_match" class="proposal">
              <strong>Proposed match only</strong>
              <span>{{ message.proposed_match.kind.replace(/_/g, ' ') }}: {{ message.proposed_match.reference }}</span>
              <small v-if="message.proposed_match.explanation">{{ message.proposed_match.explanation }}</small>
            </div>
          </article>
          <el-empty v-if="!selectedCase.messages?.length" :image-size="70" description="No updates yet" />
        </div>
        <div v-if="canReply" class="compose">
          <el-input v-model="reply.message" type="textarea" :rows="3" maxlength="5000" show-word-limit placeholder="Add evidence or a note..." />
          <div class="reply-options">
            <el-input v-model="reply.evidenceReference" :prefix-icon="Link" maxlength="500" placeholder="Secure evidence reference (optional)" />
            <el-checkbox v-model="includeReplyProposal">Propose a match</el-checkbox>
          </div>
          <div v-if="includeReplyProposal" class="proposal-fields">
            <el-select v-model="reply.proposalKind"><el-option label="Provider transaction" value="provider_transaction"/><el-option label="Incoming receipt" value="incoming_receipt"/><el-option label="Deposit intent" value="deposit_intent"/><el-option label="Withdrawal" value="withdrawal"/></el-select>
            <el-input v-model="reply.proposalReference" placeholder="Reference" maxlength="128" />
            <el-input v-model="reply.proposalExplanation" placeholder="Why these records may match" maxlength="1000" />
          </div>
          <div class="compose-actions"><span class="muted small">Platform staff verify all evidence before any separate financial action.</span><el-button type="primary" :icon="Promotion" :loading="sending" @click="sendReply">Send update</el-button></div>
        </div>
        <el-alert v-else title="This case is closed. Platform support must reopen it before more updates can be added." type="success" :closable="false" show-icon class="closed-note" />
      </section>
      <section v-else class="panel no-selection"><el-empty description="Choose a case or open a new one" /></section>
    </div>

    <el-dialog v-model="createDialog" title="Open support case" width="min(650px,94vw)">
      <el-form label-position="top" class="case-form">
        <div class="two-col">
          <el-form-item label="Category"><el-select v-model="createForm.category" style="width:100%"><el-option v-for="item in categories" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
          <el-form-item label="Transaction or provider reference"><el-input v-model="createForm.reference" maxlength="128" placeholder="Optional" /></el-form-item>
        </div>
        <el-form-item label="Subject"><el-input v-model="createForm.subject" maxlength="200" show-word-limit /></el-form-item>
        <el-form-item label="What happened?"><el-input v-model="createForm.message" type="textarea" :rows="4" maxlength="5000" show-word-limit /></el-form-item>
        <el-form-item label="Secure evidence reference"><el-input v-model="createForm.evidenceReference" :prefix-icon="Link" maxlength="500" placeholder="Optional evidence ID or approved object reference" /></el-form-item>
        <el-checkbox v-model="includeProposal">Include a proposed record match</el-checkbox>
        <div v-if="includeProposal" class="proposal-fields create-proposal">
          <el-select v-model="createForm.proposalKind"><el-option label="Provider transaction" value="provider_transaction"/><el-option label="Incoming receipt" value="incoming_receipt"/><el-option label="Deposit intent" value="deposit_intent"/><el-option label="Withdrawal" value="withdrawal"/></el-select>
          <el-input v-model="createForm.proposalReference" maxlength="128" placeholder="Reference" />
          <el-input v-model="createForm.proposalExplanation" maxlength="1000" placeholder="Why these records may match" />
        </div>
      </el-form>
      <template #footer><el-button @click="createDialog = false">Cancel</el-button><el-button type="primary" :loading="sending" @click="createCase">Open case</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.scope-alert{margin-bottom:17px}.support-grid{display:grid;grid-template-columns:330px minmax(0,1fr);gap:17px}.list{overflow:hidden;align-self:start;min-height:460px}.list>button{width:100%;padding:15px 17px;border:0;border-top:1px solid var(--line);background:#fff;text-align:left;cursor:pointer;transition:background .16s,border-color .16s}.list>button:hover{background:#fafaff}.list>button.active{background:#f2f2ff;border-left:3px solid var(--primary);padding-left:14px}.case-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.list button strong,.list button span,.list button small{display:block}.list button strong{font-size:11px;line-height:1.4}.list button>span,.list button>small{font-size:9px;color:var(--muted);margin-top:5px;text-transform:capitalize}.empty-list{padding:30px 0}.conversation{min-height:590px;display:flex;flex-direction:column;overflow:hidden}.case-head{border-bottom:1px solid var(--line)}.workflow-note{display:flex;gap:8px;padding:10px 21px;background:#fff8e9;color:#8b5c12;font-size:10px}.workflow-note strong{white-space:nowrap}.messages{padding:18px 22px;flex:1;max-height:530px;overflow-y:auto;background:#fcfcfe}.messages article{max-width:80%;margin-bottom:16px}.messages article>span{font-size:9px;color:var(--muted)}.messages article>p{font-size:11px;line-height:1.58;margin:5px 0;padding:12px 14px;background:#f0f2f6;border-radius:3px 12px 12px 12px;white-space:pre-wrap}.messages .merchant{margin-left:auto}.messages .merchant>p{background:#eeeeff;border-radius:12px 3px 12px 12px}.messages .support>p{background:#e8f7f3}.evidence,.proposal{display:flex;gap:7px;align-items:center;margin-top:6px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;font-size:9px;color:var(--muted);overflow-wrap:anywhere}.proposal{display:grid;gap:3px;border-color:#dcdcff;color:#505376}.proposal strong{text-transform:uppercase;font-size:8px;letter-spacing:.08em}.proposal small{font-size:9px}.compose{border-top:1px solid var(--line);padding:16px 20px;background:#fff}.reply-options{display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px;margin-top:10px}.proposal-fields{display:grid;grid-template-columns:170px minmax(140px,.7fr) 1fr;gap:8px;margin-top:10px}.compose-actions{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:11px}.closed-note{margin:15px 20px}.no-selection{display:grid;place-items:center;min-height:590px}.case-form .two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px}.create-proposal{margin:13px 0 4px}@media(max-width:900px){.support-grid{grid-template-columns:1fr}.list{max-height:300px;overflow:auto;min-height:0}.proposal-fields{grid-template-columns:1fr}.conversation{min-height:520px}}@media(max-width:620px){.case-form .two-col,.reply-options{grid-template-columns:1fr}.messages article{max-width:92%}.compose-actions{align-items:flex-end}.compose-actions span{max-width:60%}}
</style>
