<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, when } from '../services/helpers';
import { confirmStepUp } from '../services/stepup';
import { useAuthStore } from '../stores/auth';
import SwitchField from './SwitchField.vue';

/**
 * Автоматические проверки и плановая установка. Проверка по умолчанию включена (каждые 30 минут), установка — только по явному
 * согласию администратора с повторным вводом пароля: она запускается без человека.
 */
const props = defineProps<{
  auto: { check: boolean; install: boolean; at: string; lastDay: string | null } | undefined;
  checkedAt: string | null;
}>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n();
const auth = useAuthStore();
const check = ref(true);
const install = ref(false);
const at = ref('00:00');
const password = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');
watch(
  () => props.auto,
  (a) => {
    if (!a) return;
    check.value = a.check;
    install.value = a.install;
    at.value = a.at;
  },
  { immediate: true },
);
// пароль нужен, когда установка включается или меняется время
const needsPassword = computed(
  () => install.value && (!props.auto?.install || props.auto.at !== at.value),
);
const next = computed(() => {
  if (!check.value) return null;
  const last = props.checkedAt ? Date.parse(props.checkedAt) : Date.now();
  return new Date(Math.max(last + 30 * 60_000, Date.now())).toISOString();
});

async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const headers =
      needsPassword.value && auth.user ? await confirmStepUp(auth.user, password.value) : undefined;
    await api(
      'PUT',
      '/admin/updates/auto',
      { check: check.value, install: install.value, at: at.value },
      headers ? { headers } : undefined,
    );
    password.value = '';
    notice.value = t('autoUpdate.saved');
    emit('saved');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section
    class="space-y-2 rounded-lg border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900"
    data-testid="auto-update"
  >
    <h2 class="font-medium">{{ t('autoUpdate.title') }}</h2>
    <form class="space-y-2" @submit.prevent="save">
      <SwitchField
        v-model="check"
        :label="t('autoUpdate.check')"
        :hint="t('autoUpdate.checkHint')"
        data-testid="auto-check"
      />
      <p v-if="check" class="text-xs text-slate-500" data-testid="auto-next">
        {{ t('autoUpdate.last', { at: checkedAt ? when(checkedAt) : '—' }) }}
        <span v-if="next"> · {{ t('autoUpdate.next', { at: when(next) }) }}</span>
      </p>
      <SwitchField
        v-model="install"
        :label="t('autoUpdate.install')"
        :hint="t('autoUpdate.installHint')"
        :details="t('autoUpdate.installDetails')"
        data-testid="auto-install"
      />
      <div v-if="install" class="flex flex-wrap items-end gap-3">
        <label class="block">
          <span class="field-label">{{ t('autoUpdate.at') }}</span>
          <input v-model="at" type="time" required class="input w-32" data-testid="auto-at" />
        </label>
        <label v-if="needsPassword" class="block">
          <span class="field-label">{{ t('autoUpdate.password') }}</span>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            class="input w-56"
            data-testid="auto-password"
          />
        </label>
      </div>
      <p v-if="install" class="text-xs text-slate-500">{{ t('autoUpdate.policy') }}</p>
      <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
      <p v-if="notice" class="text-emerald-700" role="status">{{ notice }}</p>
      <button type="submit" class="btn-primary" :disabled="busy" data-testid="auto-save">
        {{ t('common.save') }}
      </button>
    </form>
  </section>
</template>
