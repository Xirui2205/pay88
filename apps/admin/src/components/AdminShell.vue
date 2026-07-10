<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Bell, ChatLineRound, Coin, Connection, DataAnalysis, Document, Fold, Grid, HelpFilled, Histogram,
  Menu as MenuIcon, Operation, Setting, Shop, Tickets, UserFilled, Wallet,
} from '@element-plus/icons-vue'
import { usePlatformStore } from '../stores/platform'

const route = useRoute()
const router = useRouter()
const platform = usePlatformStore()
const collapsed = ref(false)
const mobileOpen = ref(false)
const isPrint = computed(() => Boolean(route.meta.print))

const nav = [
  { path: '/', label: 'Overview', icon: DataAnalysis },
  { path: '/fleet', label: 'Fleet & liquidity', icon: Connection, badge: '1' },
  { path: '/jobs', label: 'Device jobs', icon: Operation, badge: '2' },
  { path: '/deposits', label: 'Deposits', icon: Coin },
  { path: '/withdrawals', label: 'Withdrawals', icon: Wallet, badge: '1' },
  { path: '/reconciliation', label: 'Reconciliation', icon: Tickets, badge: '3' },
  { path: '/support-cases', label: 'Support cases', icon: ChatLineRound },
  { path: '/merchants', label: 'Merchants', icon: Shop },
  { path: '/settings', label: 'Settings & alerts', icon: Setting },
  { path: '/audit', label: 'Audit log', icon: Document },
]

function navigate(path: string) {
  mobileOpen.value = false
  router.push(path)
}

async function signOut() { await platform.logout() }
function openHandbook() { router.push('/devices/manual') }
function openAlerts() { router.push('/settings') }
</script>

<template>
  <router-view v-if="isPrint" />
  <div v-else class="shell">
    <div v-if="mobileOpen" class="overlay" @click="mobileOpen = false" />
    <aside :class="['sidebar', { collapsed, open: mobileOpen }]">
      <div class="brand" @click="navigate('/')">
        <div class="brand-mark"><Histogram /></div>
        <div v-if="!collapsed" class="brand-type"><strong>OrbitPay</strong><span>Operations</span></div>
      </div>
      <div v-if="!collapsed" class="environment"><span /> Live environment</div>
      <nav>
        <button v-for="item in nav" :key="item.path" :class="{ active: route.path === item.path }" @click="navigate(item.path)">
          <el-icon><component :is="item.icon" /></el-icon>
          <span v-if="!collapsed">{{ item.label }}</span>
          <em v-if="item.badge && !collapsed">{{ item.badge }}</em>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <button @click="openHandbook"><el-icon><HelpFilled /></el-icon><span v-if="!collapsed">Operations handbook</span></button>
        <button class="collapse" @click="collapsed = !collapsed"><el-icon><Fold /></el-icon><span v-if="!collapsed">Collapse</span></button>
      </div>
    </aside>
    <main :class="['main', { expanded: collapsed }]">
      <header class="topbar">
        <button class="icon-button mobile-only" aria-label="Open navigation" @click="mobileOpen = true"><el-icon><MenuIcon /></el-icon></button>
        <div class="breadcrumbs desktop-only"><Grid /> <span>Platform</span><b>/</b><strong>{{ route.meta.title }}</strong></div>
        <div class="top-actions">
          <el-tooltip :content="`${platform.alerts.length} active alert${platform.alerts.length === 1 ? '' : 's'}`"><button class="icon-button alert" aria-label="Open alert settings" @click="openAlerts"><el-icon><Bell /></el-icon><i v-if="platform.alerts.length">{{ Math.min(platform.alerts.length, 99) }}</i></button></el-tooltip>
          <div class="operator desktop-only"><div class="avatar">{{ platform.identity?.display_name.slice(0,2).toUpperCase() }}</div><div><strong>{{ platform.identity?.display_name }}</strong><span>Platform {{ platform.identity?.role }}</span></div></div>
          <el-dropdown>
            <button class="icon-button"><el-icon><UserFilled /></el-icon></button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item>Profile</el-dropdown-item><el-dropdown-item @click="signOut">Sign out</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </div>
      </header>
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; }
.sidebar { position: fixed; z-index: 30; inset: 0 auto 0 0; width: 248px; padding: 20px 13px; background: var(--sidebar); color: #c9cfdd; display: flex; flex-direction: column; transition: width .2s ease, transform .2s ease; }
.sidebar.collapsed { width: 76px; }
.brand { height: 48px; display: flex; align-items: center; gap: 11px; padding: 0 9px; margin-bottom: 14px; cursor: pointer; }
.brand-mark { width: 37px; height: 37px; flex: none; border-radius: 11px; display: grid; place-items: center; color: #fff; background: linear-gradient(145deg, #7474f2, #4e4ec6); box-shadow: 0 9px 24px #111426; }
.brand-mark :deep(svg) { width: 21px; }
.brand-type { display: flex; flex-direction: column; line-height: 1.1; }
.brand-type strong { color: white; font: 800 17px 'Manrope'; letter-spacing: -.03em; }
.brand-type span { font-size: 10px; color: #8992aa; text-transform: uppercase; letter-spacing: .14em; margin-top: 5px; }
.environment { margin: 0 10px 20px; padding: 8px 10px; border: 1px solid #32394f; border-radius: 8px; font-size: 11px; }
.environment span { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #2ac09f; margin-right: 6px; }
nav { display: flex; flex-direction: column; gap: 4px; }
nav button, .sidebar-bottom button { width: 100%; min-height: 42px; display: flex; align-items: center; gap: 12px; color: #aeb6c9; border: 0; border-radius: 9px; background: transparent; text-align: left; cursor: pointer; padding: 0 12px; transition: .15s ease; }
nav button:hover, .sidebar-bottom button:hover { background: #22283b; color: white; }
nav button.active { background: #303653; color: white; box-shadow: inset 3px 0 #7777ee; }
nav button .el-icon, .sidebar-bottom .el-icon { font-size: 17px; flex: none; }
nav button span, .sidebar-bottom span { flex: 1; white-space: nowrap; }
nav em { font-style: normal; font-size: 10px; padding: 2px 7px; border-radius: 20px; background: #4e4ec6; color: white; }
.sidebar-bottom { margin-top: auto; border-top: 1px solid #2b3144; padding-top: 12px; }
.main { margin-left: 248px; min-height: 100vh; transition: margin .2s ease; }
.main.expanded { margin-left: 76px; }
.topbar { height: 68px; padding: 0 30px; display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,.92); border-bottom: 1px solid var(--line); position: sticky; z-index: 20; top: 0; backdrop-filter: blur(14px); }
.breadcrumbs { color: #949bae; font-size: 12px; display: flex; align-items: center; gap: 9px; }
.breadcrumbs svg { width: 14px; }.breadcrumbs b { font-weight: 400; color: #c2c7d2; }.breadcrumbs strong { color: #353d51; }
.top-actions { display: flex; align-items: center; gap: 10px; margin-left: auto; }
.icon-button { width: 36px; height: 36px; border: 1px solid var(--line); border-radius: 9px; background: #fff; color: #555f75; display: grid; place-items: center; cursor: pointer; position: relative; }
.alert i { position: absolute; right: -4px; top: -5px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #d84c60; color: white; font: normal 700 9px 'DM Sans'; display: grid; place-items: center; border: 2px solid white; }
.operator { display: flex; gap: 9px; align-items: center; padding-left: 8px; margin-left: 4px; border-left: 1px solid var(--line); }
.operator strong, .operator span { display: block; }.operator strong { font-size: 12px; }.operator span { color: var(--muted); font-size: 10px; margin-top: 2px; }
.overlay { display: none; }
@media (max-width: 760px) {
  .sidebar { transform: translateX(-105%); width: 248px !important; box-shadow: 18px 0 40px rgba(20,26,42,.18); }
  .sidebar.open { transform: translateX(0); }
  .main, .main.expanded { margin-left: 0; }
  .topbar { padding: 0 16px; height: 60px; }
  .overlay { display: block; position: fixed; z-index: 25; inset: 0; background: rgba(12,16,27,.45); }
}
</style>
