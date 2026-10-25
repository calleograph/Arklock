<script setup lang="ts">
import { computed } from 'vue';

/**
 * Круговой индикатор использования ресурса. Состояние дублируется подписью (нормально / предупреждение / критично):
 * цвет не единственный носитель смысла.
 */
const props = defineProps<{
  pct: number;
  level: 'ok' | 'warn' | 'fail';
  label: string;
  sub?: string;
  state: string;
}>();
const R = 34;
const C = 2 * Math.PI * R;
const dash = computed(() => `${(Math.min(100, Math.max(0, props.pct)) / 100) * C} ${C}`);
const stroke = computed(() =>
  props.level === 'ok'
    ? 'stroke-emerald-600'
    : props.level === 'warn'
      ? 'stroke-amber-500'
      : 'stroke-red-600',
);
</script>

<template>
  <figure
    class="flex items-center gap-3"
    role="group"
    :aria-label="`${label}: ${Math.round(pct)}%, ${state}`"
  >
    <svg viewBox="0 0 80 80" class="size-20 shrink-0" aria-hidden="true">
      <circle
        cx="40"
        cy="40"
        :r="R"
        fill="none"
        stroke="currentColor"
        stroke-width="8"
        class="text-slate-200 dark:text-slate-700"
      />
      <circle
        cx="40"
        cy="40"
        :r="R"
        fill="none"
        :class="stroke"
        stroke-width="8"
        stroke-linecap="round"
        :stroke-dasharray="dash"
        transform="rotate(-90 40 40)"
      />
      <text x="40" y="45" text-anchor="middle" font-size="17" font-weight="600" fill="currentColor">
        {{ Math.round(pct) }}%
      </text>
    </svg>
    <figcaption class="min-w-0 text-sm">
      <div class="font-medium">{{ label }}</div>
      <div v-if="sub" class="truncate text-xs text-slate-500">{{ sub }}</div>
      <div
        class="text-xs font-medium"
        :class="
          level === 'ok'
            ? 'text-emerald-700 dark:text-emerald-400'
            : level === 'warn'
              ? 'text-amber-700 dark:text-amber-400'
              : 'text-red-700 dark:text-red-400'
        "
      >
        {{ state }}
      </div>
    </figcaption>
  </figure>
</template>
