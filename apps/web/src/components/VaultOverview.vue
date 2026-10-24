<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../services/api';
import { passwordHealth, type IssueType } from '../services/inspector';
import type { useVaultIssues } from '../services/vaultIssues';

/**
 * Сводка сейфа на главном экране. Каждый показатель — переход к отфильтрованному списку записей:
 * число без возможности открыть сами записи не показываем.
 */
const props = defineProps<{ vi: ReturnType<typeof useVaultIssues> }>();
const emit = defineEmits<{ filter: [IssueType] }>();
const { t } = useI18n();
const breachError = ref('');
const count = (type: IssueType) => props.vi.idsOf(type).size;
// округление вниз: «100 %» — только когда проблем действительно нет
const health = computed(() => passwordHealth(props.vi.active.value, props.vi.issues.value));

async function checkLeaks(): Promise<void> {
  breachError.value = '';
  try {
    await props.vi.runBreachCheck();
  } catch (e) {
    // недоступность сервиса не означает «пароли безопасны»
    breachError.value =
      e instanceof ApiError && e.code === 'range_unavailable'
        ? t('inspector.unavailable')
        : t('error.generic');
  }
}
</script>

<template>
  <section class="card space-y-3 p-4" data-testid="vault-overview">
    <div>
      <h2 class="font-semibold">{{ t('corporate.summary') }}</h2>
      <p class="mt-1 text-xs text-slate-500">{{ t('corporate.scope') }}</p>
    </div>
    <dl class="grid grid-cols-2 gap-3 text-sm">
      <div>
        <dt class="text-slate-500">{{ t('corporate.total') }}</dt>
        <dd class="num text-2xl font-semibold">{{ vi.active.value.length }}</dd>
      </div>
      <div>
        <dt class="text-slate-500">{{ t('corporate.favorites') }}</dt>
        <dd class="num text-2xl font-semibold">
          {{ vi.active.value.filter((e) => e.pinned).length }}
        </dd>
      </div>
      <div v-if="health.total" class="col-span-2" data-testid="overview-health">
        <dt class="text-slate-500">{{ t('overview.health') }}</dt>
        <dd class="flex items-baseline gap-2">
          <span
            class="num text-2xl font-semibold"
            :class="
              health.percent >= 90
                ? 'text-emerald-600'
                : health.percent >= 60
                  ? 'text-amber-600'
                  : 'text-red-600'
            "
            >{{ health.percent }}%</span
          >
          <span class="text-xs text-slate-500"
            >{{ t('overview.healthOf', { ok: health.ok, total: health.total }) }}
            <template v-if="!vi.breached.value">· {{ t('overview.healthNoLeaks') }}</template></span
          >
        </dd>
      </div>
    </dl>
    <ul class="space-y-1 border-t border-slate-200 pt-3 text-sm dark:border-slate-800">
      <li v-for="type in ['weak', 'reused', 'old', 'expired', 'compromised'] as const" :key="type">
        <!-- утечки ещё не проверялись: показываем это честно и даём проверить на месте -->
        <div
          v-if="type === 'compromised' && !vi.breached.value"
          class="flex items-center justify-between gap-2 px-2 py-1"
        >
          <span>{{ t(`issue.${type}`) }}</span>
          <button
            type="button"
            class="text-xs font-medium text-brand-600 underline disabled:opacity-60"
            :disabled="!!vi.progress.value"
            data-testid="overview-breach-check"
            @click="checkLeaks"
          >
            {{
              vi.progress.value
                ? t('overview.progress', {
                    done: vi.progress.value.done,
                    total: vi.progress.value.total,
                  })
                : t('overview.checkLeaks')
            }}
          </button>
        </div>
        <div
          v-else-if="type === 'old' && !vi.policy.value"
          class="flex items-center justify-between gap-2 px-2 py-1"
        >
          <span>{{ t(`issue.${type}`) }}</span>
          <span class="text-slate-500">{{ t('corporate.noData') }}</span>
        </div>
        <button
          v-else
          type="button"
          class="flex w-full items-center justify-between gap-2 rounded-[8px] px-2 py-1 text-left hover:bg-slate-100 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-slate-800"
          :disabled="!count(type)"
          :data-testid="`overview-${type}`"
          @click="emit('filter', type)"
        >
          <span>{{ t(`issue.${type}`) }}</span>
          <span
            class="num font-medium"
            :class="count(type) ? (type === 'compromised' ? 'text-red-600' : 'text-amber-600') : ''"
            >{{ count(type) }}</span
          >
        </button>
      </li>
    </ul>
    <p v-if="breachError" class="text-xs text-red-600" role="alert">{{ breachError }}</p>
    <p v-if="vi.policyFailed.value" class="text-xs text-amber-700 dark:text-amber-300" role="alert">
      {{ t('corporate.policyUnavailable') }}
    </p>
    <p class="text-xs text-slate-500">{{ t('corporate.method') }}</p>
    <RouterLink to="/inspector" class="btn w-full">{{ t('corporate.analysis') }}</RouterLink>
  </section>
</template>
