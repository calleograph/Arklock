<script setup lang="ts">
import { vaultLabel } from '../services/helpers';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import {
  checkBreaches as runCheck,
  entriesSnapshot,
  inspect,
  type Issue,
} from '../services/inspector';
import { NO_POLICY, policyFrom, type PasswordPolicy } from '../services/policy';
import { useWorkspaceStore } from '../stores/workspace';

const { t } = useI18n();
const ws = useWorkspaceStore();
const router = useRouter();

const maxAge = ref(365);
const orgPolicy = ref<PasswordPolicy>(NO_POLICY);
const issues = ref<Issue[]>([]);
const checked = ref(false);
const breachChecked = ref(false);
const breachProgress = ref<{ done: number; total: number } | null>(null);
const breachError = ref('');
const reported = ref('');
const busy = ref(false);

const titles = computed(() => new Map(ws.entries.map((e) => [e.id, e])));
const grouped = computed(() => {
  const m = new Map<string, Issue[]>();
  for (const i of issues.value) m.set(i.type, [...(m.get(i.type) ?? []), i]);
  return m;
});
const passwordIds = computed(
  () =>
    new Set(ws.entries.filter((e) => e.data.password && e.data.kind !== 'note').map((e) => e.id)),
);
const total = computed(() => passwordIds.value.size);
const score = computed(() => {
  const bad = new Set(
    issues.value.filter((i) => passwordIds.value.has(i.entryId)).map((i) => i.entryId),
  ).size;
  return total.value ? Math.round(((total.value - bad) / total.value) * 100) : null;
});
watch(
  () =>
    `${ws.currentId}:${ws.entries
      .map((e) => `${e.id}:${e.version}`)
      .sort()
      .join(',')}`,
  () => {
    checked.value = false;
    breachChecked.value = false;
    issues.value = [];
    reported.value = '';
  },
);

function analyze(): void {
  const keepCompromised = issues.value.filter((i) => i.type === 'compromised');
  issues.value = [
    ...inspect(ws.entries, { maxAgeDays: maxAge.value, policy: orgPolicy.value }),
    ...keepCompromised,
  ];
  checked.value = true;
}

onMounted(async () => {
  const policy = await api<Record<string, unknown>>('GET', '/auth/policy').catch(
    () => ({}) as Record<string, unknown>,
  );
  if (typeof policy['security.passwordMaxAgeDays'] === 'number')
    maxAge.value = policy['security.passwordMaxAgeDays'] as number;
  orgPolicy.value = policyFrom(policy);
  if (!ws.vaults.length) await ws.loadVaults();
  if (ws.current?.unlocked && !ws.entries.length) await ws.loadTree();
  analyze();
  // утечки уже проверялись (например, из обзора сейфа) для этого же набора записей — показываем итог
  const b = ws.breaches;
  if (b && b.snapshot === entriesSnapshot(ws.currentId, ws.entries)) {
    issues.value.push(
      ...[...b.found].map(([entryId, info]) => ({ entryId, type: 'compromised' as const, info })),
    );
    breachChecked.value = true;
  }
});

/** Проверка по базе утечек: наружу уходит только префикс SHA-1 из 5 символов; пароли не передаются. */
async function checkBreaches(): Promise<void> {
  breachError.value = '';
  breachChecked.value = false;
  const snapshot = entriesSnapshot(ws.currentId, ws.entries);
  try {
    const found = await runCheck(ws.entries, (done, total) => {
      breachProgress.value = { done, total };
    });
    // записи могли измениться за время проверки — тогда итог относится к прежнему набору
    if (snapshot === entriesSnapshot(ws.currentId, ws.entries)) {
      ws.breaches = { snapshot, found };
      issues.value = [
        ...issues.value.filter((i) => i.type !== 'compromised'),
        ...[...found].map(([entryId, info]) => ({ entryId, type: 'compromised' as const, info })),
      ];
      breachChecked.value = true;
    }
  } catch (e) {
    // Недоступность сервиса не означает «пароли безопасны»
    breachError.value =
      e instanceof ApiError && e.code === 'range_unavailable'
        ? t('inspector.unavailable')
        : t('error.generic');
  } finally {
    breachProgress.value = null;
  }
}

async function report(): Promise<void> {
  const v = ws.current;
  if (!v) return;
  busy.value = true;
  try {
    const map = (type: Issue['type']) => (type === 'old' ? 'expired' : type);
    const items = issues.value
      .filter((i) => i.type !== 'policy')
      .map((i) => ({ entryId: i.entryId, type: map(i.type) }));
    const uniq = [...new Map(items.map((i) => [`${i.entryId}:${i.type}`, i])).values()];
    const res = await api<{ created: number; resolved: number }>(
      'POST',
      `/vaults/${v.id}/signals`,
      {
        items: uniq,
        checkedTypes: [
          'weak',
          'reused',
          'expired',
          ...(breachChecked.value ? ['compromised'] : []),
        ],
      },
    );
    reported.value = t('inspector.reported', res);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h1 class="text-xl font-semibold">
        {{ t('inspector.title') }}:
        {{
          ws.current?.kind === 'locker'
            ? t('vault.locker')
            : ws.current
              ? vaultLabel(ws.current, t)
              : ''
        }}
      </h1>
      <button type="button" class="btn" @click="router.push('/')">{{ t('settings.back') }}</button>
    </div>
    <p class="text-sm text-slate-500">{{ t('inspector.privacy') }}</p>

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="inspector-summary">
      <div class="card p-3 text-center">
        <div class="text-2xl font-semibold" data-testid="score">
          {{ checked && score !== null ? `${score}%` : t('corporate.noData') }}
        </div>
        <div class="text-xs text-slate-500">{{ t('inspector.score') }}</div>
      </div>
      <div
        v-for="type in ['weak', 'reused', 'old', 'expired', 'compromised', 'policy']"
        :key="type"
        class="card p-3 text-center"
      >
        <div class="text-2xl font-semibold" :data-testid="`count-${type}`">
          {{
            type === 'compromised' && !breachChecked
              ? t('corporate.unchecked')
              : !checked && type !== 'compromised'
                ? t('corporate.noData')
                : (grouped.get(type)?.length ?? 0)
          }}
        </div>
        <div class="text-xs text-slate-500">{{ t(`issue.${type}`) }}</div>
      </div>
    </div>
    <p class="text-xs text-slate-500">{{ t('corporate.method') }}</p>

    <div class="flex flex-wrap items-center gap-2">
      <label class="text-sm"
        >{{ t('inspector.maxAge') }}
        <input
          v-model.number="maxAge"
          type="number"
          min="0"
          max="3650"
          class="input inline-block w-24"
      /></label>
      <button type="button" class="btn" data-testid="btn-analyze" @click="analyze">
        {{ t('inspector.analyze') }}
      </button>
      <button
        type="button"
        class="btn"
        :disabled="!!breachProgress"
        data-testid="btn-breach"
        @click="checkBreaches"
      >
        {{ t('inspector.checkBreaches') }}
      </button>
      <button
        v-if="ws.current && ['owner', 'admin', 'editor', 'reader'].includes(ws.current.role)"
        type="button"
        class="btn"
        :disabled="busy || !checked || !!breachProgress"
        data-testid="btn-report"
        @click="report"
      >
        {{ t('inspector.report') }}
      </button>
      <span v-if="breachProgress" class="text-xs"
        >{{ breachProgress.done }} / {{ breachProgress.total }}</span
      >
    </div>
    <p v-if="breachError" class="text-sm text-amber-700" role="alert" data-testid="breach-error">
      {{ breachError }}
    </p>
    <p v-if="reported" class="text-sm text-emerald-700" role="status">{{ reported }}</p>

    <div v-for="[type, list] in grouped" :key="type" class="card">
      <h2 class="border-b border-slate-200 px-3 py-2 font-medium dark:border-slate-800">
        {{ t(`issue.${type}`) }} · {{ list.length }}
      </h2>
      <ul
        class="divide-y divide-slate-200 text-sm dark:divide-slate-800"
        :data-testid="`issues-${type}`"
      >
        <li
          v-for="i in list"
          :key="i.entryId + i.type"
          class="flex items-center justify-between px-3 py-1.5"
        >
          <span class="truncate"
            >{{ titles.get(i.entryId)?.data.title
            }}<span v-if="i.info" class="text-xs text-slate-500"> · {{ i.info }}×</span></span
          >
          <button
            type="button"
            class="btn"
            @click="router.push({ path: '/', query: { entry: i.entryId } })"
          >
            {{ t('inspector.open') }}
          </button>
        </li>
      </ul>
    </div>
    <p v-if="checked && !issues.length" class="text-sm text-emerald-700" data-testid="no-issues">
      {{ t('inspector.clean') }}
    </p>
  </section>
</template>
