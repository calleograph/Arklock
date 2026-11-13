<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { describeFinding, renderReportHtml, type Report } from '../services/diagnosticReport';
import { errorMessage } from '../services/helpers';
import { useAuthStore } from '../stores/auth';
import InfoHint from './InfoHint.vue';

/**
 * Отчёт для разбора проблем (главный администратор): недочёты настройки и причины отказов при входе показываются здесь
 * и выгружаются одним файлом HTML. Секретов в отчёте нет.
 */
const { t, te, locale } = useI18n();
const auth = useAuthStore();
const report = ref<Report | null>(null);
const busy = ref(false);
const error = ref('');

async function run(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    report.value = await api<Report>('GET', '/admin/diagnostics/report');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

const counts = computed(() => {
  const c = { fail: 0, warn: 0, info: 0 };
  for (const f of report.value?.findings ?? []) c[f.level] += 1;
  return c;
});
const items = computed(() =>
  (report.value?.findings ?? []).map((f) => ({ ...f, ...describeFinding(f, t, te) })),
);
const LEVEL_CLASS = {
  fail: 'text-red-700 dark:text-red-300',
  warn: 'text-amber-700 dark:text-amber-300',
  info: 'text-brand-700 dark:text-brand-300',
} as const;
const target = (code: string) =>
  code.startsWith('directory.') || code.startsWith('signin.') ? '/admin/ldap' : '';

function download(): void {
  const r = report.value;
  if (!r) return;
  const html = renderReportHtml(r, (k, p) => t(k, p ?? {}), te, locale.value);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `arklock-diagnostics-${r.at.slice(0, 10)}.html`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
</script>

<template>
  <section class="card space-y-3 p-4 text-sm" data-testid="diag-report">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="font-medium">
        {{ t('diagrep.title') }}<InfoHint class="ml-1" :text="t('diagrep.hint')" />
      </h3>
      <div v-if="auth.user?.chief" class="flex flex-wrap gap-2">
        <button type="button" class="btn" :disabled="busy" data-testid="diag-run" @click="run">
          {{ busy ? t('diagrep.running') : t('diagrep.run') }}
        </button>
        <button
          type="button"
          class="btn-primary"
          :disabled="!report"
          data-testid="diag-download"
          @click="download"
        >
          {{ t('diagrep.download') }}
        </button>
      </div>
    </div>
    <p v-if="!auth.user?.chief" class="text-slate-500">{{ t('diagrep.chiefOnly') }}</p>
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
    <template v-if="report">
      <p class="font-medium" data-testid="diag-found">{{ t('diagrep.found', counts) }}</p>
      <p v-if="!items.length" class="text-emerald-700 dark:text-emerald-300">
        {{ t('diagrep.clean') }}
      </p>
      <ul
        v-else
        class="divide-y divide-slate-200 dark:divide-slate-800"
        data-testid="diag-findings"
      >
        <li
          v-for="(f, i) in items"
          :key="i"
          class="space-y-1 py-3"
          :data-testid="`diag-finding-${f.code}`"
        >
          <p>
            <span class="badge mr-2" :class="LEVEL_CLASS[f.level]">{{
              t(`diagrep.level.${f.level}`)
            }}</span
            >{{ f.title }}
          </p>
          <p v-if="f.fix" class="text-xs text-slate-600 dark:text-slate-300">
            <strong>{{ t('diagrep.fix') }}:</strong> {{ f.fix }}
          </p>
          <RouterLink
            v-if="target(f.code)"
            :to="target(f.code)"
            class="inline-flex min-h-11 items-center text-xs font-medium text-brand-600 underline"
            >{{ t('diagrep.open') }} →</RouterLink
          >
        </li>
      </ul>
    </template>
  </section>
</template>
