<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { setupMessages } from '../i18n/setup';
import { loadSetup, type SetupState } from '../services/setup';
import Icon from './Icon.vue';

/**
 * Полоса «первоначальная настройка не закончена»: сколько сделано и куда идти дальше. В рабочей области (place="start")
 * это первое, что видит администратор после установки; там её можно скрыть. Когда всё обязательное сделано, полосы нет.
 */
const props = withDefaults(defineProps<{ place?: 'admin' | 'start' }>(), { place: 'admin' });
const { t } = useI18n({ useScope: 'local', messages: setupMessages });
const KEY = 'arklock.setup.banner.hidden';
const hidden = ref(false);
try {
  hidden.value = props.place === 'start' && localStorage.getItem(KEY) === '1';
} catch {
  /* без хранилища полоса просто показывается */
}
const state = ref<SetupState | null>(null);
onMounted(async () => {
  if (hidden.value) return;
  state.value = await loadSetup().catch(() => null);
});
// в рабочей области полоса только приглашает начать: пока способ входа сотрудников не выбран.
// Дальше о следующих шагах напоминают полосы в администрировании
const next = computed(() =>
  props.place === 'start' && state.value?.signIn ? null : (state.value?.current ?? null),
);
const fresh = computed(() => props.place === 'start');
function hide(): void {
  hidden.value = true;
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* не критично */
  }
}
</script>

<template>
  <section
    v-if="!hidden && next && state"
    class="card grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
    :class="place === 'start' ? 'px-4 py-2' : 'p-4'"
    data-testid="setup-banner"
  >
    <Icon name="check" class="size-5 shrink-0 text-brand-600 dark:text-brand-400" />
    <p class="min-w-0">
      <template v-if="fresh">{{ t('start') }}</template>
      <template v-else>
        <span class="font-medium">{{ t('banner', { n: state.done, m: state.total }) }}</span>
        {{ t('next', { step: `«${t(`step.${next.id}.t`)}»` }) }}
      </template>
    </p>
    <span class="col-start-2 flex flex-wrap gap-2 sm:col-start-auto">
      <RouterLink
        :to="fresh || !next.to ? '/admin/wizards' : next.to"
        class="btn-primary"
        data-testid="setup-banner-continue"
        >{{ fresh ? t('startBtn') : t('continue') }}</RouterLink
      >
      <RouterLink v-if="!fresh" to="/admin/wizards" class="btn" data-testid="setup-banner-all">{{
        t('all')
      }}</RouterLink>
      <button
        v-if="place === 'start'"
        type="button"
        class="btn-ghost"
        data-testid="setup-banner-hide"
        @click="hide"
      >
        {{ t('hide') }}
      </button>
    </span>
  </section>
</template>
