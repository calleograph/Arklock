<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, vaultLabel } from '../services/helpers';
const { t } = useI18n();
const vaults = ref<
  | { id: string; name: string; custodians: { userId: string; name: string }[]; recovery: string }[]
  | null
>(null);
const error = ref('');
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
    <p class="text-sm text-slate-500">{{ t('corporate.continuityHint') }}</p>
    <p v-if="error" class="text-sm text-red-600" role="alert">{{ error }}</p>
    <p v-else-if="!vaults" class="text-sm text-slate-500" aria-busy="true">{{ t('ui.loading') }}</p>
    <p v-else-if="!vaults.length" class="text-sm text-slate-500">{{ t('corporate.noVaults') }}</p>
    <ul v-else class="divide-y divide-slate-200 text-sm dark:divide-slate-800">
      <li
        v-for="v in vaults"
        :key="v.id"
        class="flex flex-wrap items-center justify-between gap-2 py-3"
      >
        <div class="min-w-0 flex-1">
          <p class="break-words font-medium">{{ vaultLabel(v, t) }}</p>
          <p
            :class="
              v.custodians.length < 2 ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500'
            "
          >
            {{
              t(
                `corporate.${!v.custodians.length ? 'noCustodian' : v.custodians.length === 1 ? 'oneCustodian' : 'enoughCustodians'}`,
              )
            }}
          </p>
          <p class="text-xs text-slate-500">{{ v.custodians.map((u) => u.name).join(', ') }}</p>
          <p
            class="mt-1 text-xs"
            :class="
              v.recovery === 'ready' ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500'
            "
          >
            {{ t(`corporate.recoveryStatus.${v.recovery}`) }}
          </p>
        </div>
      </li>
    </ul>
    <p class="text-xs text-slate-500">{{ t('corporate.continuityLimit') }}</p>
  </section>
</template>
