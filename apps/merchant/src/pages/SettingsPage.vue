<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Clock, DocumentChecked } from '@element-plus/icons-vue'
import { useMerchantStore } from '../stores/merchant'

const store = useMerchantStore()
const loading = ref(false)
const dialog = ref(false)
const reason = ref('')
const form = reactive({
  alternate: false,
  minimum: '10.00',
  maximum: '50000.00',
  tolerance: '1.00',
  providerFeeReserve: '25.00',
  gatewayFee: '0.00',
  countdownMinutes: 10,
  lateGraceMinutes: 30,
  difficultyMessage: 'We cannot process this request right now. Please try again shortly.',
})

const latestApproved = computed(() => store.settingChanges.find((item) => item.status === 'approved'))
const pendingCount = computed(() => store.settingChanges.filter((item) => item.status === 'pending').length)
const canEdit = computed(() => store.identity?.user.role === 'owner' || store.identity?.user.role === 'admin')

function applyLatest() {
  const value = store.activePolicy
  form.alternate = Boolean(value.allow_alternate_withdrawal_phone)
  form.minimum = String(value.deposit_minimum ?? form.minimum)
  form.maximum = String(value.deposit_maximum ?? form.maximum)
  form.tolerance = String(value.wrong_amount_tolerance ?? form.tolerance)
  form.providerFeeReserve = String(value.reserve_provider_fee ?? form.providerFeeReserve)
  form.gatewayFee = String(value.gateway_fee_flat ?? form.gatewayFee)
  form.countdownMinutes = Number(value.deposit_countdown_seconds ?? 600) / 60
  form.lateGraceMinutes = Number(value.deposit_late_grace_seconds ?? 1800) / 60
  form.difficultyMessage = String(value.technical_difficulty_message ?? form.difficultyMessage)
}

async function load() {
  loading.value = true
  try {
    await store.loadSettingChanges()
    applyLatest()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not load merchant settings')
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (reason.value.trim().length < 10) {
    ElMessage.warning('Explain the requested change in at least 10 characters.')
    return
  }
  loading.value = true
  try {
    await store.proposeSettings({
      allow_alternate_withdrawal_phone: form.alternate,
      deposit_minimum: form.minimum,
      deposit_maximum: form.maximum,
      wrong_amount_tolerance: form.tolerance,
      reserve_provider_fee: form.providerFeeReserve,
      gateway_fee_flat: form.gatewayFee,
      deposit_countdown_seconds: form.countdownMinutes * 60,
      deposit_late_grace_seconds: form.lateGraceMinutes * 60,
      technical_difficulty_message: form.difficultyMessage,
    }, reason.value)
    dialog.value = false
    reason.value = ''
    ElMessage.success('Change submitted for platform approval')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not submit the change')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">Approval-controlled policy</p>
        <h1>Merchant settings</h1>
        <span class="muted">Changes do not affect live payment behavior until platform staff approve them.</span>
      </div>
      <el-button v-if="canEdit" type="primary" :icon="DocumentChecked" :loading="loading" @click="dialog = true">Submit change</el-button>
    </div>

    <el-alert v-if="!canEdit" title="Your support role has read-only access to settings." type="info" :closable="false" show-icon class="notice" />
    <section class="grid grid-2 summary">
      <article class="panel metric"><span>Active version</span><strong>{{ latestApproved ? `v${latestApproved.version}` : 'Baseline' }}</strong><small>{{ latestApproved?.reviewed_at ? new Date(latestApproved.reviewed_at).toLocaleString() : 'Platform-provisioned merchant policy' }}</small></article>
      <article class="panel metric"><span>Awaiting approval</span><strong>{{ pendingCount }}</strong><small>Platform staff must review each request</small></article>
    </section>

    <section class="panel active-policy">
      <div class="panel-head"><div><h2>Current approved policy</h2><span class="muted small">Values used by the live matching and payout services</span></div></div>
      <div class="policy-grid">
        <div><span>Deposit range</span><strong>ETB {{ form.minimum }} – {{ form.maximum }}</strong></div>
        <div><span>Wrong-amount tolerance</span><strong>ETB {{ form.tolerance }}</strong></div>
        <div><span>Deposit timer</span><strong>{{ form.countdownMinutes }} + {{ form.lateGraceMinutes }} min</strong></div>
        <div><span>Alternate payout number</span><strong>{{ form.alternate ? 'Allowed' : 'Not allowed' }}</strong></div>
        <div><span>Provider fee reserve</span><strong>ETB {{ form.providerFeeReserve }}</strong></div>
        <div><span>Gateway fee</span><strong>ETB {{ form.gatewayFee }}</strong></div>
      </div>
      <div class="message"><span>Customer technical-difficulties message</span><p>{{ form.difficultyMessage }}</p></div>
    </section>

    <section class="panel history">
      <div class="panel-head"><div><h2>Approval history</h2><span class="muted small">Versioned and auditable setting requests</span></div><el-icon><Clock /></el-icon></div>
      <div class="table-wrap"><el-table :data="store.settingChanges" v-loading="loading"><el-table-column prop="version" label="Version" width="90"/><el-table-column label="Submitted" min-width="170"><template #default="scope">{{ new Date(scope.row.created_at).toLocaleString() }}</template></el-table-column><el-table-column prop="proposed_by" label="Requested by" min-width="180"/><el-table-column label="Status" width="130"><template #default="scope"><span :class="`status status-${scope.row.status}`">{{ scope.row.status }}</span></template></el-table-column><el-table-column prop="review_reason" label="Review note" min-width="240"/></el-table></div>
    </section>

    <el-dialog v-model="dialog" title="Propose merchant policy" width="min(660px,94vw)">
      <el-alert title="The active policy remains unchanged until platform approval." type="warning" :closable="false" show-icon />
      <el-form label-position="top" class="form-grid">
        <el-form-item label="Minimum deposit (ETB)"><el-input v-model="form.minimum" inputmode="decimal" /></el-form-item>
        <el-form-item label="Maximum deposit (ETB)"><el-input v-model="form.maximum" inputmode="decimal" /></el-form-item>
        <el-form-item label="Wrong-amount tolerance (ETB)"><el-input v-model="form.tolerance" inputmode="decimal" /></el-form-item>
        <el-form-item label="Provider fee reserve (ETB)"><el-input v-model="form.providerFeeReserve" inputmode="decimal" /></el-form-item>
        <el-form-item label="Gateway flat fee (ETB)"><el-input v-model="form.gatewayFee" inputmode="decimal" /></el-form-item>
        <el-form-item label="Deposit countdown (minutes)"><el-input-number v-model="form.countdownMinutes" :min="1" :max="60" /></el-form-item>
        <el-form-item label="Late grace (minutes)"><el-input-number v-model="form.lateGraceMinutes" :min="0" :max="120" /></el-form-item>
        <el-form-item label="Alternate payout destinations"><el-switch v-model="form.alternate" active-text="Merchant may assert an alternate number" /></el-form-item>
        <el-form-item label="Customer technical-difficulties message" class="wide"><el-input v-model="form.difficultyMessage" type="textarea" :rows="3" maxlength="500" show-word-limit /></el-form-item>
        <el-form-item label="Reason for change" class="wide"><el-input v-model="reason" type="textarea" :rows="3" maxlength="1000" show-word-limit /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialog = false">Cancel</el-button><el-button type="primary" :loading="loading" @click="submit">Submit for approval</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.notice,.summary,.active-policy{margin-bottom:17px}.metric{padding:21px}.metric span,.metric strong,.metric small{display:block}.metric span,.policy-grid span,.message span{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}.metric strong{font:800 25px 'Manrope';margin:7px 0}.metric small{font-size:10px;color:var(--muted)}.policy-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.policy-grid>div{background:#fff;padding:18px 21px}.policy-grid strong{display:block;font-size:12px;margin-top:7px}.message{margin:18px 21px;padding:15px 17px;background:#f5f6fa;border-radius:10px}.message p{font-size:12px;margin:7px 0 0;line-height:1.5}.history{margin-top:17px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px;margin-top:18px}.form-grid .wide{grid-column:1/-1}@media(max-width:800px){.policy-grid,.form-grid{grid-template-columns:1fr}.form-grid .wide{grid-column:auto}}
</style>
