<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Download, Refresh, Search } from '@element-plus/icons-vue'
import StatusPill from '../components/StatusPill.vue'
import { deposits, jobs, withdrawals } from '../data/mock'
import { usePlatformStore } from '../stores/platform'
import { ElMessage, ElMessageBox } from 'element-plus'

const props = defineProps<{ kind: 'jobs' | 'deposits' | 'withdrawals' }>()
const platform = usePlatformStore()
const query = ref('')
const status = ref('all')
const data = computed(() => platform.demoMode ? (props.kind === 'deposits' ? deposits : props.kind === 'withdrawals' ? withdrawals : jobs) : platform.operations[props.kind])
const filtered = computed(() => data.value.filter(row => (status.value === 'all' || row.status === status.value || row.p2pStatus === status.value) && JSON.stringify(row).toLowerCase().includes(query.value.toLowerCase())))
const successRate = computed(() => data.value.length ? `${(data.value.filter(row=>row.status==='success').length/data.value.length*100).toFixed(1)}%` : '—')
const reviewCount = computed(() => data.value.filter(row=>['manual_review','unknown'].includes(row.p2pStatus)).length)
const actionJobId = ref('')
const labels = computed(() => ({ jobs: ['Device jobs', 'Prioritized, leased work across the phone fleet.'], deposits: ['Deposits', 'Assigned intents and incoming Telebirr receipts.'], withdrawals: ['Withdrawals', 'Single-SIM payouts and provider confirmations.'] }[props.kind]))
onMounted(()=>platform.loadOperations(props.kind));watch(()=>props.kind,kind=>platform.loadOperations(kind))
function exportCsv(){const q=(value:unknown)=>`"${String(value??'').replace(/"/g,'""')}"`;const keys=['id','merchant','reference','customer','amount','status','p2pStatus','device','age'] as const;const csv=[keys.map(q).join(','),...filtered.value.map(row=>keys.map(key=>q(row[key])).join(','))].join('\r\n');const url=URL.createObjectURL(new Blob([`\uFEFF${csv}`],{type:'text/csv;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=`platform-${props.kind}-${new Date().toISOString().slice(0,10)}.csv`;anchor.click();URL.revokeObjectURL(url);ElMessage.success(`Exported ${filtered.value.length} records`)}
async function executeNow(id:string){actionJobId.value=id;try{const response=await platform.executeDeviceJobNow(id);if(response.execution_requested){ElMessage.success('Job is eligible and moved to the front of the queue')}else{ElMessage.warning('Job is blocked. The backend returned exact diagnostics.');await ElMessageBox.alert(`<pre style="white-space:pre-wrap;word-break:break-word;max-height:55vh;overflow:auto">${escapeHtml(JSON.stringify(response,null,2))}</pre>`,'Execution blocked',{dangerouslyUseHTMLString:true,confirmButtonText:'Close'})}}catch(error){ElMessage.error(error instanceof Error?error.message:'Could not execute job')}finally{actionJobId.value=''}}
function escapeHtml(value:string){return value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[character]??character))}
async function retryJob(id:string){actionJobId.value=id;try{await platform.retryDeviceJob(id);ElMessage.success('Failed job queued for retry')}catch(error){ElMessage.error(error instanceof Error?error.message:'Could not retry job')}finally{actionJobId.value=''}}
</script>
<template>
  <div class="page">
    <div class="page-heading"><div><p class="eyebrow">Money operations</p><h1>{{ labels[0] }}</h1><span class="muted">{{ labels[1] }}</span></div><div class="toolbar"><el-button :icon="Refresh" @click="platform.loadOperations(kind)">Refresh</el-button><el-button :icon="Download" @click="exportCsv">Export CSV</el-button></div></div>
    <section class="grid grid-4 quick-stats">
      <div class="panel"><span>Loaded</span><strong>{{ data.length.toLocaleString() }}</strong><small>latest records</small></div>
      <div class="panel"><span>Success rate</span><strong>{{ successRate }}</strong><small>loaded records</small></div>
      <div class="panel"><span>Environment</span><strong>Live</strong><small>platform operations</small></div>
      <div class="panel warning"><span>Needs review</span><strong>{{ reviewCount }}</strong><small>operator cases</small></div>
    </section>
    <section class="panel">
      <div class="filters"><el-input v-model="query" :prefix-icon="Search" :placeholder="`Search ${kind}, reference, customer…`" clearable class="search"/><el-select v-model="status" style="width:170px"><el-option label="All statuses" value="all"/><el-option label="Pending" value="pending"/><el-option label="Success" value="success"/><el-option label="Manual review" value="manual_review"/><el-option label="Unknown" value="unknown"/></el-select><el-date-picker type="daterange" start-placeholder="Start date" end-placeholder="End date" class="desktop-only"/></div>
      <div class="table-wrap"><el-table :data="filtered" stripe>
        <el-table-column v-if="kind === 'jobs'" type="expand">
          <template #default="s">
            <div class="job-log">
              <strong>Job response log</strong>
              <el-alert v-if="s.row.readiness&&!s.row.readiness.ready" type="error" :closable="false" show-icon title="The phone cannot execute this job with its current state."/>
              <pre v-if="s.row.readiness" class="raw-response">{{JSON.stringify(s.row.readiness,null,2)}}</pre>
              <el-timeline v-if="s.row.log?.length">
                <el-timeline-item v-for="(entry,index) in s.row.log" :key="`${entry.at}-${index}`" :timestamp="new Date(entry.at).toLocaleString()" placement="top">
                  <b>{{ entry.event }}</b><div class="log-detail">{{ entry.detail }}</div>
                </el-timeline-item>
              </el-timeline>
              <span v-else class="muted">No responses received yet.</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="Reference" min-width="145"><template #default="s"><strong>{{ s.row.reference }}</strong><div class="muted small">{{ s.row.id }}</div></template></el-table-column>
        <el-table-column prop="merchant" label="Merchant" min-width="135" />
        <el-table-column :label="kind === 'jobs' ? 'Job type' : 'Customer'" min-width="135"><template #default="s">{{ s.row.customer }}</template></el-table-column>
        <el-table-column v-if="kind !== 'jobs'" label="Amount" width="125"><template #default="s"><span class="amount">ETB {{ s.row.amount.toLocaleString() }}</span></template></el-table-column>
        <el-table-column label="Status" min-width="150"><template #default="s"><StatusPill :status="s.row.p2pStatus" /></template></el-table-column>
        <el-table-column prop="device" label="Assigned SIM" min-width="150" />
        <el-table-column prop="age" label="Age" width="85" />
        <el-table-column v-if="kind === 'jobs'" label="Admin actions" width="150" fixed="right"><template #default="s"><el-button v-if="s.row.canExecuteNow" type="primary" size="small" :loading="actionJobId===s.row.id" @click="executeNow(s.row.id)">Execute now</el-button><el-button v-if="s.row.canRetry" type="warning" size="small" :loading="actionJobId===s.row.id" @click="retryJob(s.row.id)">Retry</el-button><span v-if="!s.row.canExecuteNow&&!s.row.canRetry" class="muted small">—</span></template></el-table-column>
      </el-table></div>
      <div class="pagination"><span class="muted small">Showing {{ filtered.length }} of {{ data.length }} records</span><el-pagination layout="prev, pager, next" :total="data.length" :page-size="10" small/></div>
    </section>
  </div>
</template>
<style scoped>
.job-log{padding:12px 28px 4px}.job-log>strong{display:block;margin-bottom:18px}.log-detail{white-space:pre-wrap;word-break:break-word;margin-top:4px}.raw-response{max-height:320px;overflow:auto;background:#111827;color:#d1fae5;padding:12px;border-radius:8px;font:10px/1.55 Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.quick-stats{margin-bottom:18px}.quick-stats>div{padding:18px 20px}.quick-stats span,.quick-stats small,.quick-stats strong{display:block}.quick-stats span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}.quick-stats strong{font:800 23px 'Manrope';margin:7px 0 3px}.quick-stats small{font-size:10px;color:var(--muted)}.quick-stats .warning strong{color:var(--danger)}.search{max-width:360px}.pagination{display:flex;justify-content:space-between;align-items:center;padding:16px 20px}
</style>
