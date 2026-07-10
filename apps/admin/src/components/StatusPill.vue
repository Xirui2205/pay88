<script setup lang="ts">
const props = defineProps<{ status: string }>()
const normalized = props.status.toLowerCase().replace(/\s+/g, '_')
</script>
<template><span :class="['pill', `pill-${normalized}`]"><i />{{ status.replace(/_/g, ' ') }}</span></template>
<style scoped>
.pill { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; padding: 5px 9px; border-radius: 20px; font-size: 11px; font-weight: 700; color: #596175; background: #f0f2f6; text-transform: capitalize; }
.pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill-healthy,.pill-success,.pill-confirmed { color: #087d69; background: #e5f7f2; }
.pill-warning,.pill-pending,.pill-running,.pill-queued,.pill-device_started,.pill-late_grace { color: #a9640f; background: #fff3dd; }
.pill-offline,.pill-failed,.pill-expired { color: #c43e53; background: #ffe9ed; }
.pill-unknown,.pill-manual_review,.pill-quarantined { color: #7046ad; background: #f0e8fb; }
.pill-awaiting_payment,.pill-assigned { color: #4141b8; background: #ececff; }
</style>
