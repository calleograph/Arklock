<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { parseLog, type LogLevel } from '../services/logLines';
import { when } from '../services/helpers';

/**
 * Журнал служб: поиск (в том числе по коду ошибки и идентификатору операции), уровень, период.
 * Уровень передаётся значком, подписью и цветом одновременно — цвет не единственный носитель смысла.
 */
const props = defineProps<{ text: string }>();
const { t } = useI18n();
const query = ref('');
const level = ref<'' | LogLevel>('');
const period = ref(0);
const open = ref<number | null>(null);
const lines = computed(() => parseLog(props.text));
const counts = computed(() => ({
  error: lines.value.filter((l) => l.level === 'error').length,
  warn: lines.value.filter((l) => l.level === 'warn').length,
}));
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  const from = period.value ? Date.now() - period.value * 3_600_000 : 0;
  return lines.value
    .map((l, i) => ({ ...l, i }))
    .filter(
      (l) =>
        (!level.value || l.level === level.value) &&
        (!q || l.raw.toLowerCase().includes(q)) &&
        (!from || l.at === null || l.at >= from),
    );
});
const ICON: Record<LogLevel, string> = { error: '✖', warn: '⚠', info: 'ℹ' };
const COLOR: Record<LogLevel, string> = {
  error: 'text-red-700 dark:text-red-400',
  warn: 'text-amber-700 dark:text-amber-400',
  info: 'text-slate-500',
};
</script>

<template>
  <div class="space-y-2" data-testid="log-viewer">
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <input
        v-model="query"
        type="search"
        class="input w-full sm:w-72"
        :placeholder="t('sys.logs.search')"
        :aria-label="t('sys.logs.search')"
        data-testid="log-search"
      />
      <select
        v-model="level"
        class="input w-auto"
        :aria-label="t('sys.logs.level')"
        data-testid="log-level"
      >
        <option value="">{{ t('sys.logs.allLevels') }}</option>
        <option value="error">{{ t('sys.logs.error') }} ({{ counts.error }})</option>
        <option value="warn">{{ t('sys.logs.warn') }} ({{ counts.warn }})</option>
        <option value="info">{{ t('sys.logs.info') }}</option>
      </select>
      <select
        v-model.number="period"
        class="input w-auto"
        :aria-label="t('sys.logs.period')"
        data-testid="log-period"
      >
        <option :value="0">{{ t('sys.logs.anyTime') }}</option>
        <option :value="1">{{ t('sys.logs.hour') }}</option>
        <option :value="24">{{ t('sys.logs.day') }}</option>
        <option :value="168">{{ t('sys.logs.week') }}</option>
      </select>
      <span class="text-xs text-slate-500" data-testid="log-count">
        {{ t('sys.logs.shown', { n: shown.length, total: lines.length }) }}
      </span>
    </div>
    <ul
      class="max-h-[60vh] overflow-auto rounded-lg border border-slate-200 bg-white text-xs dark:border-slate-800 dark:bg-slate-900"
      data-testid="log-text"
    >
      <li
        v-for="l in shown"
        :key="l.i"
        class="border-b border-slate-100 last:border-0 dark:border-slate-800"
      >
        <button
          type="button"
          class="flex w-full items-start gap-2 px-2 py-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
          :aria-expanded="open === l.i"
          @click="open = open === l.i ? null : l.i"
        >
          <span class="w-24 shrink-0 font-medium" :class="COLOR[l.level]">
            <span aria-hidden="true">{{ ICON[l.level] }}</span> {{ t(`sys.logs.${l.level}`) }}
          </span>
          <span class="w-36 shrink-0 text-slate-500">{{ l.at ? when(l.at) : '' }}</span>
          <span
            class="min-w-0 flex-1 font-mono"
            :class="open === l.i ? 'whitespace-pre-wrap break-all' : 'truncate'"
            >{{ l.text }}</span
          >
        </button>
        <pre
          v-if="open === l.i"
          class="overflow-x-auto bg-slate-50 px-3 py-2 dark:bg-slate-800/50"
          >{{ l.raw }}</pre>
      </li>
      <li v-if="!shown.length" class="px-3 py-3 text-slate-500">{{ t('sys.logs.empty') }}</li>
    </ul>
  </div>
</template>
