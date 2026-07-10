<script setup lang="ts">import {onMounted} from 'vue';import AdminShell from './components/AdminShell.vue';import LoginPage from './components/LoginPage.vue';import {usePlatformStore} from './stores/platform';const store=usePlatformStore();onMounted(()=>store.restore());</script>
<template><AdminShell v-if="store.authenticated"/><LoginPage v-else/></template>
