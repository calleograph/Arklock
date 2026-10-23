import { computed, ref } from 'vue';
import { api } from './api';
import { checkBreaches, entriesSnapshot, inspect, type Issue, type IssueType } from './inspector';
import { policyFrom } from './policy';
import { useWorkspaceStore } from '../stores/workspace';

/** Проблемы паролей открытого сейфа — одна логика для обзора и для фильтра списка записей. */
export function useVaultIssues() {
  const ws = useWorkspaceStore();
  const policy = ref<Record<string, unknown> | null>(null);
  const policyFailed = ref(false);
  void api<Record<string, unknown>>('GET', '/auth/policy').then(
    (p) => (policy.value = p),
    () => (policyFailed.value = true),
  );
  const active = computed(() => ws.entries.filter((e) => !e.data.archived));
  // результат проверки утечек годится, пока набор записей сейфа тот же
  const breached = computed(() => {
    const b = ws.breaches;
    return b && b.snapshot === entriesSnapshot(ws.currentId, ws.entries) ? b.found : null;
  });
  const issues = computed<Issue[]>(() => {
    const ids = new Set(active.value.map((e) => e.id));
    return [
      ...inspect(active.value, {
        maxAgeDays: policy.value ? Number(policy.value['security.passwordMaxAgeDays'] ?? 365) : 0,
        policy: policy.value ? policyFrom(policy.value) : undefined,
      }),
      ...[...(breached.value ?? [])]
        .filter(([id]) => ids.has(id))
        .map(([entryId, info]) => ({ entryId, type: 'compromised' as const, info })),
    ];
  });
  const idsOf = (type: IssueType) =>
    new Set(issues.value.filter((i) => i.type === type).map((i) => i.entryId));
  const progress = ref<{ done: number; total: number } | null>(null);
  async function runBreachCheck(): Promise<void> {
    const snapshot = entriesSnapshot(ws.currentId, ws.entries);
    progress.value = { done: 0, total: 0 };
    try {
      const found = await checkBreaches(
        ws.entries,
        (done, total) => (progress.value = { done, total }),
      );
      // за время проверки записи могли измениться — тогда итог относится к прежнему набору и не сохраняется
      if (snapshot === entriesSnapshot(ws.currentId, ws.entries)) ws.breaches = { snapshot, found };
    } finally {
      progress.value = null;
    }
  }
  return { policy, policyFailed, active, issues, idsOf, breached, progress, runBreachCheck };
}
