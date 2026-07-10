<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ label: string; value: string; detail: string; tone?: 'primary' | 'teal' | 'amber' | 'red'; progress?: number }>()
const color = computed(() => ({ primary: '#5c5ce2', teal: '#159786', amber: '#d18a24', red: '#d94c61' }[props.tone || 'primary']))
</script>
<template>
  <article class="metric panel">
    <div class="bar" :style="{ background: color }" />
    <span>{{ label }}</span>
    <strong>{{ value }}</strong>
    <div class="detail"><i :style="{ background: color }" />{{ detail }}</div>
    <el-progress v-if="progress !== undefined" :percentage="progress" :show-text="false" :stroke-width="4" :color="color" />
  </article>
</template>
<style scoped>
.metric { padding: 20px; position: relative; overflow: hidden; min-height: 137px; }
.bar { position: absolute; left: 0; top: 20px; width: 3px; height: 31px; border-radius: 0 4px 4px 0; }
.metric > span { display: block; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.metric > strong { display: block; font: 800 27px 'Manrope'; letter-spacing: -.04em; margin: 8px 0 6px; }
.detail { color: var(--muted); font-size: 11px; display: flex; align-items: center; gap: 7px; }
.detail i { width: 6px; height: 6px; border-radius: 50%; }
.el-progress { margin-top: 12px; }
</style>
