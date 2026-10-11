<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSystemStore } from '../stores/system';

const { t } = useI18n();
const system = useSystemStore();
onMounted(() => void system.load());

const rows = computed(() => {
  const v = system.version;
  const r = system.ready;
  return [
    { label: t('status.version'), value: v ? v.version : '—' },
    { label: t('status.commit'), value: v ? `${v.commit} · ${v.builtAt}` : '—' },
    { label: t('status.channel'), value: v ? v.channel : '—' },
    {
      label: t('status.api'),
      value: system.unreachable ? t('status.fail') : r ? t('status.ok') : '—',
      ok: !system.unreachable && !!r,
    },
    {
      label: t('status.database'),
      value: r ? (r.checks.database === 'ok' ? t('status.ok') : t('status.fail')) : '—',
      ok: r?.checks.database === 'ok',
    },
  ];
});
</script>

<template>
  <section>
    <h1 class="mb-4 text-xl font-semibold">{{ t('status.title') }}</h1>
    <p
      v-if="system.unreachable"
      class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
    >
      {{ t('status.unreachable') }}
    </p>
    <dl
      class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900"
    >
      <div
        v-for="row in rows"
        :key="row.label"
        class="flex items-center justify-between gap-4 px-4 py-3 text-sm"
      >
        <dt class="text-slate-500 dark:text-slate-400">{{ row.label }}</dt>
        <dd
          class="font-medium"
          :class="
            row.ok === true
              ? 'text-emerald-600 dark:text-emerald-400'
              : row.ok === false
                ? 'text-red-600 dark:text-red-400'
                : ''
          "
        >
          {{ system.loading ? t('status.loading') : row.value }}
        </dd>
      </div>
    </dl>
  </section>
</template>
