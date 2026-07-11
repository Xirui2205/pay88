<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Money, Promotion, RefreshRight } from '@element-plus/icons-vue'
import { usePlatformStore } from '../stores/platform'
import { ApiError } from '../api/client'

const platform = usePlatformStore()
const depositLoading = ref(false)
const withdrawalLoading = ref(false)
const depositResult = ref<any>(null)
const withdrawalResult = ref<any>(null)
const deposit = ref({ merchant_id: '', amount: '10.00', first_name: 'Test', last_name: 'Customer', phone_number: '' })
const withdrawal = ref({ merchant_id: '', amount: '10.00', account_number: '', expected_name: '' })
const merchantOptions = computed(() => platform.merchants.filter((merchant) => merchant.status === 'active'))

onMounted(async () => {
  await platform.loadMerchants()
  const first = merchantOptions.value[0]?.id ?? ''
  deposit.value.merchant_id = first
  withdrawal.value.merchant_id = first
})

async function runDeposit() {
  depositLoading.value = true
  depositResult.value = null
  try {
    depositResult.value = await platform.createTestDeposit(deposit.value)
    ElMessage.success('Live deposit instruction created')
  } catch (error) { depositResult.value = { api_error: error instanceof ApiError ? error.body : { message: error instanceof Error ? error.message : 'Unknown error' } }; ElMessage.error(error instanceof Error ? error.message : 'Could not create deposit') }
  finally { depositLoading.value = false }
}

async function runWithdrawal() {
  try {
    await ElMessageBox.confirm(
      `Send ETB ${withdrawal.value.amount} of real money to ${withdrawal.value.account_number}?`,
      'Confirm live withdrawal',
      { confirmButtonText: 'Send real money', cancelButtonText: 'Cancel', type: 'warning' },
    )
  } catch { return }
  withdrawalLoading.value = true
  withdrawalResult.value = null
  try {
    withdrawalResult.value = await platform.createTestWithdrawal(withdrawal.value)
    ElMessage.success('Live withdrawal queued')
  } catch (error) { withdrawalResult.value = { api_error: error instanceof ApiError ? error.body : { message: error instanceof Error ? error.message : 'Unknown error' } }; ElMessage.error(error instanceof Error ? error.message : 'Could not create withdrawal') }
  finally { withdrawalLoading.value = false }
}

function open(url:string) { window.open(url, '_blank', 'noopener,noreferrer') }
</script>

<template>
  <div class="page test-page">
    <div class="page-heading"><div><p class="eyebrow">Admin tools</p><h1>Live payment test</h1><span class="muted">Create real deposits and withdrawals without calling the API yourself.</span></div></div>
    <el-alert title="These tests use the live phone fleet and real ETB. A withdrawal sends money immediately." type="warning" :closable="false" show-icon class="warning"/>
    <div class="test-grid">
      <section class="panel test-card">
        <div class="panel-head"><div><h2><el-icon><Money/></el-icon> Test a deposit</h2><span class="muted small">Create the instruction, open it, then send real Telebirr money to the displayed number.</span></div></div>
        <el-form label-position="top" class="panel-body">
          <el-form-item label="Merchant"><el-select v-model="deposit.merchant_id" style="width:100%"><el-option v-for="merchant in merchantOptions" :key="merchant.id" :label="merchant.name" :value="merchant.id"/></el-select></el-form-item>
          <el-form-item label="Amount (ETB)"><el-input v-model="deposit.amount" inputmode="decimal"/></el-form-item>
          <div class="two"><el-form-item label="First name"><el-input v-model="deposit.first_name"/></el-form-item><el-form-item label="Last name"><el-input v-model="deposit.last_name"/></el-form-item></div>
          <el-form-item label="Sender phone number"><el-input v-model="deposit.phone_number" placeholder="09… or +2519…"/></el-form-item>
          <el-button type="primary" :icon="Promotion" :loading="depositLoading" :disabled="!deposit.merchant_id" @click="runDeposit">Create live deposit</el-button>
        </el-form>
        <div v-if="depositResult" class="result"><template v-if="depositResult.tx_ref"><span>Reference</span><strong>{{depositResult.tx_ref}}</strong><span>Status</span><strong>{{depositResult.p2p_status}}</strong><span>Amount</span><strong>ETB {{depositResult.amount}}</strong><el-button type="primary" @click="open(depositResult.checkout_url)">Open payment instructions</el-button></template><details open><summary>Full API response</summary><pre>{{JSON.stringify(depositResult.api_response??depositResult.api_error??depositResult,null,2)}}</pre></details></div>
      </section>

      <section class="panel test-card">
        <div class="panel-head"><div><h2><el-icon><RefreshRight/></el-icon> Test a withdrawal</h2><span class="muted small">This queues a real USSD transfer from one online fleet SIM.</span></div></div>
        <el-form label-position="top" class="panel-body">
          <el-form-item label="Merchant"><el-select v-model="withdrawal.merchant_id" style="width:100%"><el-option v-for="merchant in merchantOptions" :key="merchant.id" :label="merchant.name" :value="merchant.id"/></el-select></el-form-item>
          <el-form-item label="Amount (ETB)"><el-input v-model="withdrawal.amount" inputmode="decimal"/></el-form-item>
          <el-form-item label="Receiver Telebirr number"><el-input v-model="withdrawal.account_number" placeholder="09… or +2519…"/></el-form-item>
          <el-form-item label="Receiver name"><el-input v-model="withdrawal.expected_name"/></el-form-item>
          <el-button type="danger" :icon="Promotion" :loading="withdrawalLoading" :disabled="!withdrawal.merchant_id" @click="runWithdrawal">Send live withdrawal</el-button>
        </el-form>
        <div v-if="withdrawalResult" class="result"><template v-if="withdrawalResult.reference"><span>Reference</span><strong>{{withdrawalResult.reference}}</strong><span>Status</span><strong>{{withdrawalResult.p2p_status}}</strong><span>Amount</span><strong>ETB {{withdrawalResult.amount}}</strong><el-button @click="open(withdrawalResult.status_url)">Open withdrawal status</el-button></template><details open><summary>Full API response</summary><pre>{{JSON.stringify(withdrawalResult.api_response??withdrawalResult.api_error??withdrawalResult,null,2)}}</pre></details></div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.test-page{max-width:1100px}.warning{margin-bottom:18px}.test-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.test-card{overflow:hidden}.panel-head h2{display:flex;align-items:center;gap:8px}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.result{display:grid;grid-template-columns:100px 1fr;gap:9px 12px;margin:0 20px 20px;padding:17px;border-radius:11px;background:#f5f7fa}.result span{font-size:10px;color:var(--muted);text-transform:uppercase}.result strong{font-size:12px;word-break:break-all}.result .el-button,.result details{grid-column:1/-1;margin-top:8px}.result summary{cursor:pointer;font-weight:700}.result pre{max-height:360px;overflow:auto;background:#111827;color:#d1fae5;padding:12px;border-radius:8px;font:10px/1.55 Consolas,monospace;white-space:pre-wrap;word-break:break-word}@media(max-width:850px){.test-grid{grid-template-columns:1fr}.two{grid-template-columns:1fr}}
</style>
