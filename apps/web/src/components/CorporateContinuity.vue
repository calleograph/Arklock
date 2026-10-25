<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, vaultLabel } from '../services/helpers';
const { t } = useI18n();
const vaults = ref<
  | { id: string; name: string; custodians: { userId: string; name: string }[]; recovery: string }[]
  | null
>(null);
const error = ref('');
const showAll = ref(false);
type Row = { custodians: unknown[]; recovery: string };
// уровень риска: без хранителя — высокий, один хранитель — средний; готовое корпоративное восстановление понижает на ступень
const level = (v: Row): 'riskHigh' | 'riskMedium' | 'riskLow' | null =>
  v.custodians.length >= 2
    ? null
    : v.recovery === 'ready'
      ? 'riskLow'
      : v.custodians.length === 0
        ? 'riskHigh'
        : 'riskMedium';
const risky = computed(() => (vaults.value ?? []).filter((v) => level(v)));
const shown = computed(() =>
  showAll.value || !risky.value.length ? (vaults.value ?? []) : risky.value,
);
onMounted(async () => {
  try {
    vaults.value = await api('GET', '/admin/continuity');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});
</script>

<template>
  <section
    class="card space-y-3 p-4 sm:col-span-2 lg:col-span-3"
    data-testid="corporate-continuity"
  >
    <h2 class="font-semibold">{{ t('corporate.continuity') }}</h2>
    <p class="max-w-prose text-sm text-slate-500">{{ t('corporate.continuityHint') }}</p>
    <p v-if="error" class="text-sm text-red-600" role="alert">{{ error }}</p>
    <p v-else-if="!vaults" class="text-sm text-slate-500" aria-busy="true">
      {{ t('common.loading') }}
    </p>
    <p v-else-if="!vaults.length" class="text-sm text-slate-500">{{ t('corporate.noVaults') }}</p>
    <template v-else>
      <p
        class="text-sm font-medium"
        :class="
          risky.length
            ? 'text-amber-700 dark:text-amber-300'
            : 'text-emerald-700 dark:text-emerald-300'
        "
        data-testid="continuity-summary"
      >
        {{
          risky.length
            ? t('corporate.atRisk', { n: risky.length, total: vaults.length })
            : t('corporate.riskNone')
        }}
      </p>
      <div class="flex flex-wrap gap-2">
        <RouterLink
          v-if="risky.length"
          to="/admin/organization"
          class="btn"
          data-testid="continuity-vaults"
        >
          {{ t('corporate.showVaults') }}
        </RouterLink>
        <RouterLink
          to="/admin/settings?section=security"
          class="btn"
          data-testid="continuity-recovery"
        >
          {{ t('corporate.setupRecovery') }}
        </RouterLink>
      </div>
      <ul class="divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <li
          v-for="v in shown"
          :key="v.id"
          class="flex flex-wrap items-center justify-between gap-2 py-2"
          data-testid="continuity-row"
        >
          <div class="min-w-0 flex-1">
            <p class="break-words font-medium">{{ vaultLabel(v, t) }}</p>
            <p v-if="level(v)" class="text-amber-700 dark:text-amber-300">
              {{ t(`corporate.${level(v)}`) }} ·
              {{ t(v.custodians.length ? 'corporate.reasonOne' : 'corporate.reasonNone') }}
            </p>
            <p v-else class="text-slate-500">{{ t('corporate.enoughCustodians') }}</p>
            <p class="text-xs text-slate-500">{{ v.custodians.map((u) => u.name).join(', ') }}</p>
            <p
              class="mt-0.5 text-xs"
              :class="
                v.recovery === 'ready' ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500'
              "
            >
              {{ t(`corporate.recoveryStatus.${v.recovery}`) }}
            </p>
          </div>
        </li>
      </ul>
      <button
        v-if="!showAll && vaults.length > risky.length && risky.length"
        type="button"
        class="btn-ghost text-xs"
        @click="showAll = true"
      >
        {{ t('corporate.hideOk', { n: vaults.length - risky.length }) }}
      </button>
    </template>
    <p class="text-xs text-slate-500">{{ t('corporate.continuityLimit') }}</p>
  </section>
</template>
