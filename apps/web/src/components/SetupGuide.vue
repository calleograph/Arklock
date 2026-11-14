<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import { setupMessages } from '../i18n/setup';
import { loadSetup, type SetupState, type SetupStep } from '../services/setup';

/**
 * «Первоначальная настройка»: один упорядоченный список от адреса сервера до резервных копий. Шаги отмечаются сами по
 * фактической настройке; «Сейчас» — первый невыполненный обязательный шаг. Способ входа сотрудников выбирается здесь же:
 * от него зависят остальные шаги (каталог или приглашения).
 */
const { t } = useI18n({ useScope: 'local', messages: setupMessages });
const state = ref<SetupState | null>(null);
const error = ref('');
const busy = ref(false);
const changingSignIn = ref(false);
async function load(): Promise<void> {
  try {
    state.value = await loadSetup();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(load);

const GROUPS = ['server', 'signin', 'structure', 'protection'] as const;
const numbered = computed(() => {
  const list = state.value?.steps ?? [];
  return GROUPS.map((g) => ({
    id: g,
    steps: list.filter((s) => s.group === g).map((s) => ({ ...s, n: list.indexOf(s) + 1 })),
  })).filter((g) => g.steps.length);
});
const isNow = (s: SetupStep) => state.value?.current?.id === s.id;

async function chooseSignIn(v: 'directory' | 'local'): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api('PUT', '/admin/settings', { 'setup.signIn': v });
    changingSignIn.value = false;
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-4" data-testid="setup-guide">
    <p v-if="error" class="text-sm text-red-600" role="alert">{{ error }}</p>
    <div v-if="state" class="card space-y-2 p-4" data-testid="setup-progress">
      <p class="text-sm font-medium">
        {{ state.current ? t('progress', { n: state.done, m: state.total }) : t('allDone') }}
      </p>
      <div class="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div
          class="h-full rounded-full bg-brand-500 transition-[width]"
          :style="{ width: `${state.total ? (100 * state.done) / state.total : 0}%` }"
        />
      </div>
    </div>

    <div v-for="g in numbered" :key="g.id" class="card p-4" :data-testid="`setup-group-${g.id}`">
      <h2 class="mb-2 font-semibold">{{ t(`group.${g.id}`) }}</h2>
      <ol class="divide-y divide-slate-200 dark:divide-slate-800">
        <li
          v-for="s in g.steps"
          :key="s.id"
          class="setup-step"
          :class="isNow(s) ? 'setup-step-now' : ''"
          :data-testid="`setup-step-${s.id}`"
          :data-state="s.done ? 'done' : isNow(s) ? 'now' : s.done === null ? 'choice' : 'todo'"
          :aria-current="isNow(s) ? 'step' : undefined"
        >
          <span
            class="setup-mark"
            :class="
              s.done
                ? 'border-emerald-600 bg-emerald-600 text-white'
                : isNow(s)
                  ? 'border-brand-600 text-brand-700 dark:text-brand-300'
                  : 'border-slate-300 text-slate-500 dark:border-slate-600'
            "
            aria-hidden="true"
            >{{ s.done ? '✓' : s.n }}</span
          >
          <div class="min-w-0 space-y-1">
            <h3 class="flex flex-wrap items-center gap-2 font-medium">
              {{ t(`step.${s.id}.t`) }}
              <span v-if="isNow(s)" class="badge-brand text-xs">{{ t('now') }}</span>
              <span v-else-if="!s.done" class="badge text-xs">{{ t(s.kind) }}</span>
            </h3>
            <p class="text-xs text-slate-600 dark:text-slate-300">{{ t(`step.${s.id}.d`) }}</p>
            <ul v-if="s.parts" class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <li
                v-for="p in s.parts"
                :key="p.id"
                :class="p.done ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-500'"
              >
                {{ p.done ? '✓' : '○' }} {{ t(`part.${p.id}`, p.params ?? {}) }}
              </li>
            </ul>
            <p v-if="s.id === 'keys'" class="text-xs text-slate-500">
              {{ t(`keyMode.${s.params?.mode}`) }}
            </p>
            <p v-if="s.id.startsWith('people') && s.params" class="text-xs text-slate-500">
              {{ t('people', s.params) }}
            </p>
            <RouterLink
              v-if="s.id === 'peopleDirectory' && !s.done"
              to="/admin/diagnostics"
              class="inline-flex min-h-11 items-center text-xs font-medium text-brand-600 underline dark:text-brand-400"
              data-testid="setup-why"
              >{{ t('why') }} →</RouterLink
            >
            <p
              v-if="s.id === 'signIn' && state?.signIn"
              class="text-xs text-slate-500"
              data-testid="setup-signin-chosen"
            >
              {{ t(`chosen.${state.signIn}`) }}
            </p>
          </div>
          <!-- выбор способа входа — в той же колонке действий, что и кнопки остальных шагов -->
          <div
            v-if="s.id === 'signIn' && (!state?.signIn || changingSignIn)"
            class="setup-action flex flex-col gap-2"
          >
            <button
              v-for="v in ['directory', 'local'] as const"
              :key="v"
              type="button"
              :class="state?.signIn === v ? 'btn-primary' : 'btn'"
              :disabled="busy"
              :data-testid="`setup-signin-${v}`"
              @click="chooseSignIn(v)"
            >
              {{ v === 'directory' ? t('chooseDirectory') : t('chooseLocal') }}
            </button>
          </div>
          <button
            v-else-if="s.id === 'signIn'"
            type="button"
            class="setup-action btn-ghost"
            data-testid="setup-signin-change"
            @click="changingSignIn = true"
          >
            {{ t('change') }}
          </button>
          <RouterLink
            v-else-if="s.to"
            :to="s.to"
            class="setup-action"
            :class="isNow(s) ? 'btn-primary' : s.done ? 'btn-ghost' : 'btn'"
            :data-testid="`setup-open-${s.id}`"
            >{{ isNow(s) ? t('setUp') : s.done ? t('change') : t('open') }}</RouterLink
          >
          <span v-else />
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.setup-step {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) 10rem;
  align-items: start;
  column-gap: 0.75rem;
  padding: 0.75rem 0.5rem;
}
.setup-step-now {
  border-radius: var(--radius-card);
  background: color-mix(in srgb, var(--color-brand-500) 8%, transparent);
}
.setup-mark {
  display: inline-flex;
  width: 2rem;
  height: 2rem;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  border-width: 1px;
  font-size: 0.75rem;
  font-weight: 500;
}
.setup-action {
  justify-content: center;
  width: 100%;
}
@media (max-width: 639px) {
  .setup-step {
    grid-template-columns: 2rem minmax(0, 1fr);
    row-gap: 0.5rem;
  }
  /* на телефоне кнопки под текстом шага, одной ширины: правые края на одной линии */
  .setup-action {
    grid-column: 2;
    justify-self: start;
    width: 10rem;
  }
  .setup-action:not(div),
  .setup-action > * {
    min-height: 2.75rem;
  }
}
</style>
