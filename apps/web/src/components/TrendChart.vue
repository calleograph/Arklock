<script setup lang="ts">
import { computed } from 'vue';

/** Линейный график 0–100 % по точкам из истории ресурсов; подписаны границы и последнее значение. */
const props = defineProps<{
  title: string;
  values: number[];
  from?: string;
  to?: string;
}>();
const W = 240;
const H = 60;
const points = computed(() => {
  const v = props.values;
  if (v.length < 2) return '';
  return v
    .map(
      (x, i) =>
        `${((i / (v.length - 1)) * W).toFixed(1)},${(H - (Math.min(100, x) / 100) * H).toFixed(1)}`,
    )
    .join(' ');
});
const last = computed(() => props.values[props.values.length - 1]);
const max = computed(() => (props.values.length ? Math.max(...props.values) : 0));
</script>

<template>
  <figure class="space-y-1">
    <figcaption class="flex items-baseline justify-between text-xs">
      <span class="font-medium">{{ title }}</span>
      <span v-if="values.length" class="text-slate-500">{{ last }}% · max {{ max }}%</span>
    </figcaption>
    <svg
      v-if="values.length >= 2"
      :viewBox="`0 0 ${W} ${H}`"
      class="h-16 w-full"
      preserveAspectRatio="none"
      role="img"
      :aria-label="`${title}: ${last}%`"
    >
      <line
        x1="0"
        :y1="H * 0.1"
        :x2="W"
        :y2="H * 0.1"
        stroke="currentColor"
        stroke-dasharray="3 3"
        class="text-slate-300 dark:text-slate-700"
      />
      <polyline
        :points="points"
        fill="none"
        class="stroke-brand-500"
        stroke-width="1.6"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <p v-else class="text-xs text-slate-500">—</p>
    <div v-if="from && values.length >= 2" class="flex justify-between text-[10px] text-slate-500">
      <span>{{ from }}</span
      ><span>{{ to }}</span>
    </div>
  </figure>
</template>
