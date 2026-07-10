<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { CopyDocument, Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useMerchantStore } from '../stores/merchant'

const store = useMerchantStore()
const dialog = ref(false)
const loading = ref(false)
const email = ref('')
const role = ref<'admin'|'support'>('support')
const invitationToken = ref('')

async function invite() {
  loading.value = true
  try {
    invitationToken.value = store.demoMode ? 'mi_demo_invitation_token' : (await store.inviteUser(email.value, role.value)).invitation_token
    dialog.value = false
    ElMessage.success('Invitation created; deliver the token through an approved channel')
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'Could not create invitation') }
  finally { loading.value = false }
}

async function copyToken() { await navigator.clipboard.writeText(invitationToken.value); ElMessage.success('Invitation token copied') }
onMounted(() => store.loadTeam().catch((error) => ElMessage.error(error instanceof Error ? error.message : 'Could not load team')))
</script>

<template>
  <div class="page">
    <div class="page-heading"><div><p class="eyebrow">Access control</p><h1>Merchant team</h1><span class="muted">Owners and administrators invite users; support access cannot change keys or policy.</span></div><el-button type="primary" :icon="Plus" @click="dialog=true">Invite user</el-button></div>
    <el-alert v-if="invitationToken" title="Invitation secret shown once" type="warning" :closable="false" show-icon class="token"><div class="token-row"><code>{{invitationToken}}</code><el-button :icon="CopyDocument" @click="copyToken">Copy</el-button></div></el-alert>
    <section class="panel"><div class="panel-head"><div><h2>Active users</h2><span class="muted small">Merchant-scoped roles and recent access</span></div></div><div class="table-wrap"><el-table :data="store.team"><el-table-column label="User" min-width="220"><template #default="scope"><b>{{scope.row.display_name}}</b><div class="muted small">{{scope.row.email}}</div></template></el-table-column><el-table-column prop="role" label="Role" width="120"/><el-table-column label="Status" width="120"><template #default="scope"><span :class="`status status-${scope.row.status}`">{{scope.row.status}}</span></template></el-table-column><el-table-column label="Last sign-in" min-width="180"><template #default="scope">{{scope.row.last_login_at?new Date(scope.row.last_login_at).toLocaleString():'Never'}}</template></el-table-column></el-table></div></section>
    <section class="panel invitations"><div class="panel-head"><div><h2>Pending invitations</h2><span class="muted small">Unaccepted, unexpired invitations</span></div></div><div class="table-wrap"><el-table :data="store.invitations" empty-text="No pending invitations"><el-table-column prop="email" label="Email" min-width="230"/><el-table-column prop="role" label="Role" width="120"/><el-table-column label="Expires" min-width="180"><template #default="scope">{{new Date(scope.row.expires_at).toLocaleString()}}</template></el-table-column></el-table></div></section>
    <el-dialog v-model="dialog" title="Invite merchant user" width="min(500px,92vw)"><el-form label-position="top"><el-form-item label="Email"><el-input v-model="email" type="email" autocomplete="off"/></el-form-item><el-form-item label="Role"><el-select v-model="role" style="width:100%"><el-option label="Administrator" value="admin"/><el-option label="Support" value="support"/></el-select></el-form-item></el-form><el-alert title="The token is displayed once and must be delivered through an approved channel." type="info" :closable="false" show-icon/><template #footer><el-button @click="dialog=false">Cancel</el-button><el-button type="primary" :loading="loading" @click="invite">Create invitation</el-button></template></el-dialog>
  </div>
</template>

<style scoped>.token,.invitations{margin-bottom:17px}.token-row{display:flex;align-items:center;gap:12px;margin-top:9px}.token-row code{flex:1;overflow-wrap:anywhere;background:#fff7e8;border:1px solid #f1d9a8;border-radius:8px;padding:10px;font-size:10px}</style>
