<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Download, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { usePlatformStore } from '../stores/platform'

type AuditRow={time:string;timestamp:string;actor:string;action:string;target:string;reason:string;source:string}
const platform=usePlatformStore()
const query=ref('')
const action=ref('all')
const dates=ref<[Date,Date]|null>(null)
const demoRows:AuditRow[]=[
  {timestamp:'2026-07-08T14:33:18Z',time:'08 Jul 2026 · 14:33:18',actor:'Selam A.',action:'reconciliation.resolved',target:'WD-38192',reason:'Provider receipt DG87NDFU4H verified',source:'platform_staff'},
  {timestamp:'2026-07-08T14:30:02Z',time:'08 Jul 2026 · 14:30:02',actor:'System',action:'device.quarantined',target:'AA-Kazanchis-01',reason:'Heartbeat timeout exceeded 180 seconds',source:'system'},
]
const rows=computed<AuditRow[]>(()=>platform.demoMode?demoRows:platform.auditRows.map((item:any)=>({timestamp:item.created_at,time:new Date(item.created_at).toLocaleString(),actor:item.actor_id,action:item.action,target:item.target_id??item.target_type,reason:item.reason??'—',source:item.actor_type})))
const actions=computed(()=>[...new Set(rows.value.map(row=>row.action))].sort())
const filtered=computed(()=>rows.value.filter(row=>{
  if(action.value!=='all'&&row.action!==action.value)return false
  if(query.value&&!JSON.stringify(row).toLowerCase().includes(query.value.toLowerCase()))return false
  if(dates.value){const value=new Date(row.timestamp).valueOf();if(value<dates.value[0].valueOf()||value>dates.value[1].valueOf()+86_399_999)return false}
  return true
}))
function exportCsv(){const q=(value:string)=>`"${value.replace(/"/g,'""')}"`;const csv=[['timestamp','actor','action','target','reason','source'].map(q).join(','),...filtered.value.map(row=>[row.timestamp,row.actor,row.action,row.target,row.reason,row.source].map(q).join(','))].join('\r\n');const url=URL.createObjectURL(new Blob([`\uFEFF${csv}`],{type:'text/csv;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=`platform-audit-${new Date().toISOString().slice(0,10)}.csv`;anchor.click();URL.revokeObjectURL(url);ElMessage.success(`Exported ${filtered.value.length} audit records`)}
onMounted(()=>platform.loadAudit())
</script>
<template><div class="page"><div class="page-heading"><div><p class="eyebrow">Immutable evidence</p><h1>Audit log</h1><span class="muted">Every approval, override, remote session and financial action.</span></div><el-button :icon="Download" @click="exportCsv">Export CSV</el-button></div><section class="panel"><div class="filters"><el-input v-model="query" :prefix-icon="Search" clearable placeholder="Search actor, action or target" style="max-width:360px"/><el-date-picker v-model="dates" type="daterange" start-placeholder="Start" end-placeholder="End"/><el-select v-model="action" style="width:220px"><el-option label="All actions" value="all"/><el-option v-for="item in actions" :key="item" :label="item" :value="item"/></el-select></div><div class="table-wrap"><el-table :data="filtered" stripe><el-table-column prop="time" label="Timestamp" width="185"/><el-table-column label="Actor" width="160"><template #default="scope"><span class="row"><span class="avatar">{{scope.row.actor==='System'?'SY':scope.row.actor.split(' ').map((x:string)=>x[0]).join('').slice(0,2)}}</span><strong>{{scope.row.actor}}</strong></span></template></el-table-column><el-table-column label="Action" min-width="210"><template #default="scope"><code>{{scope.row.action}}</code></template></el-table-column><el-table-column prop="target" label="Target" min-width="160"/><el-table-column prop="reason" label="Reason" min-width="270"/><el-table-column prop="source" label="Actor type" width="150"/></el-table></div><div class="integrity"><span>Append-only operator view backed by retained database and audit backups</span><b>{{filtered.length}} records in this export scope</b></div></section></div></template>
<style scoped>code{font-size:11px;color:#4d4dbc;background:#eeeefe;padding:4px 7px;border-radius:5px}.avatar{width:27px;height:27px;border-radius:8px;font-size:9px}.integrity{display:flex;justify-content:space-between;padding:15px 20px;background:#e9f8f4;color:#087d69;font-size:10px}.integrity b{font-size:10px}@media(max-width:700px){.integrity{flex-direction:column;gap:6px}}</style>
