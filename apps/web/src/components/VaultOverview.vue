<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkspaceStore } from '../stores/workspace';
import { api } from '../services/api';
import { inspect } from '../services/inspector';
import { policyFrom } from '../services/policy';

const { t } = useI18n();
const ws = useWorkspaceStore();
const policy = ref<Record<string, unknown> | null>(null);
const policyFailed = ref(false);
onMounted(async () => {
  try {
    policy.value = await api('GET', '/auth/policy');
  } catch {
    policyFailed.value = true;
  }
});
const active = computed(() => ws.entries.filter((e) => !e.data.archived));
const issues = computed(() =>
  inspect(active.value, {
    maxAgeDays: policy.value ? Number(policy.value['security.passwordMaxAgeDays'] ?? 365) : 0,
    policy: policy.value ? policyFrom(policy.value) : undefined,
  }),
);
const count = (type: string) => issues.value.filter((i) => i.type === type).length;
</script>

<template>
  <section class="card space-y-4 p-4" data-testid="vault-overview">
    <div>
      <h2 class="font-semibold">{{ t('corporate.summary') }}</h2>
      <p class="mt-1 text-xs text-slate-500">{{ t('corporate.scope') }}</p>
    </div>
    <dl class="grid grid-cols-2 gap-3 text-sm">
      <div>
        <dt class="text-slate-500">{{ t('corporate.total') }}</dt>
        <dd class="num text-2xl font-semibold">{{ active.length }}</dd>
      </div>
      <div>
        <dt class="text-slate-500">{{ t('corporate.favorites') }}</dt>
        <dd class="num text-2xl font-semibold">{{ active.filter((e) => e.pinned).length }}</dd>
      </div>
    </dl>
    <dl class="space-y-2 border-t border-slate-200 pt-3 text-sm dark:border-slate-800">
      <div
        v-for="type in ['weak', 'reused', 'old', 'compromised']"
        :key="type"
        class="flex items-center justify-between gap-2"
      >
        <dt>{{ t(`issue.${type}`) }}</dt>
        <dd class="num font-medium">
          {{
            type === 'compromised'
              ? t('corporate.unchecked')
              : type === 'old' && !policy
                ? t('corporate.noData')
                : count(type)
          }}
        </dd>
      </div>
    </dl>
    <p v-if="policyFailed" class="text-xs text-amber-700 dark:text-amber-300" role="alert">
      {{ t('corporate.policyUnavailable') }}
    </p>
    <p class="text-xs text-slate-500">{{ t('corporate.method') }}</p>
    <RouterLink to="/inspector" class="btn w-full">{{ t('corporate.analysis') }}</RouterLink>
  </section>
</template>
