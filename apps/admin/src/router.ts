import { createRouter, createWebHistory } from 'vue-router'
import DashboardPage from './pages/DashboardPage.vue'
import FleetPage from './pages/FleetPage.vue'
import OperationsPage from './pages/OperationsPage.vue'
import ReconciliationPage from './pages/ReconciliationPage.vue'
import MerchantsPage from './pages/MerchantsPage.vue'
import SettingsPage from './pages/SettingsPage.vue'
import AuditPage from './pages/AuditPage.vue'
import AddPhonePage from './pages/AddPhonePage.vue'
import ManualPage from './pages/ManualPage.vue'
import SupportCasesPage from './pages/SupportCasesPage.vue'
import TestPaymentsPage from './pages/TestPaymentsPage.vue'

export default createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardPage, meta: { title: 'Operations overview' } },
    { path: '/fleet', name: 'fleet', component: FleetPage, meta: { title: 'Fleet & liquidity' } },
    { path: '/devices/new', name: 'add-phone', component: AddPhonePage, meta: { title: 'Add phone' } },
    { path: '/devices/manual', name: 'manual', component: ManualPage, meta: { title: 'Phone installation manual', print: true } },
    { path: '/manuals/phone-installation/:lang(en|zh)', name: 'phone-manual', component: ManualPage, meta: { title: 'Phone installation manual', print: true } },
    { path: '/jobs', name: 'jobs', component: OperationsPage, props: { kind: 'jobs' }, meta: { title: 'Device jobs' } },
    { path: '/deposits', name: 'deposits', component: OperationsPage, props: { kind: 'deposits' }, meta: { title: 'Deposits' } },
    { path: '/withdrawals', name: 'withdrawals', component: OperationsPage, props: { kind: 'withdrawals' }, meta: { title: 'Withdrawals' } },
    { path: '/test-payments', name: 'test-payments', component: TestPaymentsPage, meta: { title: 'Live payment test' } },
    { path: '/reconciliation', name: 'reconciliation', component: ReconciliationPage, meta: { title: 'Reconciliation' } },
    { path: '/support-cases', name: 'support-cases', component: SupportCasesPage, meta: { title: 'Merchant support cases' } },
    { path: '/merchants', name: 'merchants', component: MerchantsPage, meta: { title: 'Merchants' } },
    { path: '/settings', name: 'settings', component: SettingsPage, meta: { title: 'Settings & alerts' } },
    { path: '/audit', name: 'audit', component: AuditPage, meta: { title: 'Audit log' } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
