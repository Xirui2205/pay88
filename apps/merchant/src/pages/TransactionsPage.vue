<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Download, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useMerchantStore } from '../stores/merchant'

type Row = { ref:string; kind:'Deposit'|'Withdrawal'; customer:string; amount:string; credited:string|null; status:string; detail:string; created:string; createdAt:string }

const store = useMerchantStore()
const tab = ref<'all'|'Deposit'|'Withdrawal'>('all')
const query = ref('')
const status = ref('all')
const dates = ref<[Date, Date] | null>(null)
const selected = ref<Row | null>(null)

const demoRows: Row[] = [
  { ref:'AB-249142',kind:'Deposit',customer:'091••••8988',amount:'ETB 2,000.00',credited:'ETB 2,000.00',status:'success',detail:'success',created:'08 Jul · 14:30',createdAt:'2026-07-08T14:30:00Z' },
  { ref:'WD-38210',kind:'Withdrawal',customer:'092••••4697',amount:'ETB 1,500.00',credited:null,status:'success',detail:'success',created:'08 Jul · 14:29',createdAt:'2026-07-08T14:29:00Z' },
  { ref:'BN-981234',kind:'Deposit',customer:'092••••5510',amount:'ETB 750.00',credited:null,status:'pending',detail:'awaiting payment',created:'08 Jul · 14:27',createdAt:'2026-07-08T14:27:00Z' },
]

const rows = computed<Row[]>(() => store.demoMode ? demoRows : store.transactions.map((item) => ({
  ref: item.reference,
  kind: item.kind === 'deposit' ? 'Deposit' : 'Withdrawal',
  customer: item.customer_phone,
  amount: `ETB ${item.amount}`,
  credited: item.credited_amount ? `ETB ${item.credited_amount}` : null,
  status: item.status,
  detail: item.p2p_status.replace(/_/g, ' '),
  created: new Date(item.created_at).toLocaleString(),
  createdAt: item.created_at,
})))

const filtered = computed(() => rows.value.filter((row) => {
  if (tab.value !== 'all' && row.kind !== tab.value) return false
  if (status.value !== 'all' && row.status !== status.value) return false
  const needle = query.value.trim().toLocaleLowerCase()
  if (needle && !`${row.ref} ${row.customer}`.toLocaleLowerCase().includes(needle)) return false
  if (dates.value) {
    const timestamp = new Date(row.createdAt).valueOf()
    if (timestamp < dates.value[0].valueOf() || timestamp > dates.value[1].valueOf() + 86_399_999) return false
  }
  return true
}))

function exportCsv() {
  const quote = (value: string | null) => `"${String(value ?? '').replace(/"/g, '""')}"`
  const csv = [
    ['reference','kind','customer','amount','credited_amount','status','p2p_status','created_at'].map(quote).join(','),
    ...filtered.value.map((row) => [row.ref,row.kind,row.customer,row.amount,row.credited,row.status,row.detail,row.createdAt].map(quote).join(',')),
  ].join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type:'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `telebirr-${store.environment}-transactions-${new Date().toISOString().slice(0,10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
  ElMessage.success(`Exported ${filtered.value.length} transaction${filtered.value.length === 1 ? '' : 's'}`)
}

onMounted(() => store.loadTransactions())
</script>

<template>
  <div class="page">
    <div class="page-heading"><div><p class="eyebrow">Payment history</p><h1>Transactions</h1><span class="muted">Verify deposits and withdrawals without exposing fleet details.</span></div><el-button :icon="Download" @click="exportCsv">Export CSV</el-button></div>
    <section class="panel">
      <div class="tabs"><button v-for="item in [['all','All'],['Deposit','Deposits'],['Withdrawal','Withdrawals']]" :key="item[0]" :class="{active:tab===item[0]}" @click="tab=item[0] as typeof tab">{{ item[1] }}</button></div>
      <div class="filters"><el-input v-model="query" :prefix-icon="Search" clearable placeholder="Search reference or customer" style="max-width:340px"/><el-select v-model="status" style="width:150px"><el-option label="All statuses" value="all"/><el-option label="Pending" value="pending"/><el-option label="Success" value="success"/><el-option label="Failed" value="failed"/></el-select><el-date-picker v-model="dates" type="daterange" start-placeholder="Start" end-placeholder="End" class="desktop-only"/></div>
      <div class="table-wrap"><el-table :data="filtered" stripe><el-table-column label="Reference" min-width="150"><template #default="scope"><b>{{scope.row.ref}}</b><div class="muted small">{{scope.row.kind}}</div></template></el-table-column><el-table-column prop="customer" label="Customer" min-width="140"/><el-table-column label="Amount" width="145"><template #default="scope"><b class="amount">{{scope.row.amount}}</b></template></el-table-column><el-table-column label="Status" width="145"><template #default="scope"><span :class="`status status-${scope.row.status}`">{{scope.row.detail}}</span></template></el-table-column><el-table-column prop="created" label="Created" width="180"/><el-table-column width="80"><template #default="scope"><el-button link type="primary" @click="selected=scope.row">Verify</el-button></template></el-table-column></el-table></div>
      <div class="pagination"><span class="muted small">Showing {{filtered.length}} transactions</span></div>
    </section>

    <el-dialog :model-value="Boolean(selected)" title="Verified merchant record" width="min(520px,92vw)" @close="selected=null">
      <el-alert title="This information was read from the authenticated, merchant-scoped gateway record." type="success" :closable="false" show-icon/>
      <dl v-if="selected" class="verification"><div><dt>Reference</dt><dd>{{selected.ref}}</dd></div><div><dt>Type</dt><dd>{{selected.kind}}</dd></div><div><dt>Requested amount</dt><dd>{{selected.amount}}</dd></div><div v-if="selected.credited"><dt>Actually credited</dt><dd>{{selected.credited}}</dd></div><div><dt>Detailed status</dt><dd><span :class="`status status-${selected.status}`">{{selected.detail}}</span></dd></div><div><dt>Customer</dt><dd>{{selected.customer}}</dd></div><div><dt>Created</dt><dd>{{new Date(selected.createdAt).toLocaleString()}}</dd></div></dl>
      <template #footer><el-button type="primary" @click="selected=null">Done</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.tabs{display:flex;padding:0 19px;border-bottom:1px solid var(--line)}.tabs button{border:0;background:transparent;padding:16px 13px 12px;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent}.tabs button.active{color:var(--primary);font-weight:700;border-bottom-color:var(--primary)}.pagination{display:flex;justify-content:space-between;align-items:center;padding:15px 19px}.verification{margin:18px 0 0}.verification>div{display:flex;justify-content:space-between;gap:20px;padding:12px 0;border-bottom:1px solid var(--line)}.verification dt{font-size:10px;color:var(--muted)}.verification dd{font-size:11px;font-weight:700;margin:0;text-align:right}
</style>
