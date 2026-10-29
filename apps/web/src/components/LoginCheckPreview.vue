<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { findNumber } from '../services/captcha';
import { errorMessage } from '../services/helpers';

/**
 * Пробная проверка входа для администратора: настоящее задание сервера решается в браузере так же, как при входе,
 * и проверяется тем же кодом. Счётчики ошибок и блокировки не затрагиваются. Рядом — макет формы входа, чтобы
 * видеть строку состояния так, как её видит сотрудник (в том числе на экране телефона).
 */
const { t } = useI18n();
const emit = defineEmits<{ close: [] }>();
interface Challenge {
  id: string;
  salt: string;
  bits: number;
  exp: number;
  sig: string;
}
const state = ref<'idle' | 'working' | 'ok' | 'rejected' | 'failed'>('idle');
const message = ref('');
const bits = ref(0);
const elapsed = ref(0);
const phone = ref(false);
let timer = 0;
let started = 0;
const seconds = computed(() => elapsed.value.toFixed(1));

async function run(wrong: boolean): Promise<void> {
  if (state.value === 'working') return;
  state.value = 'working';
  message.value = '';
  started = performance.now();
  elapsed.value = 0;
  clearInterval(timer);
  timer = window.setInterval(() => (elapsed.value = (performance.now() - started) / 1000), 100);
  try {
    const r = await api<{ challenge: Challenge; bits: number }>(
      'GET',
      '/admin/shield/login/preview',
    );
    bits.value = r.bits;
    // «Показать ошибку»: решение заведомо неверное, отвечает настоящий сервер
    const number = wrong ? 0 : await findNumber(r.challenge);
    const v = await api<{ ok: boolean }>('POST', '/admin/shield/login/preview/verify', {
      solution: { ...r.challenge, number: wrong ? Number.MAX_SAFE_INTEGER - 1 : number },
    });
    elapsed.value = (performance.now() - started) / 1000;
    state.value = v.ok ? 'ok' : 'rejected';
  } catch (e) {
    message.value = errorMessage(e, t);
    state.value = 'failed';
  } finally {
    clearInterval(timer);
  }
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  clearInterval(timer);
});
</script>

<template>
  <div
    class="modal-scrim flex items-center justify-center p-4"
    role="dialog"
    aria-modal="true"
    :aria-label="t('shield.login.preview.title')"
    data-testid="login-preview"
    @click.self="emit('close')"
  >
    <div class="modal max-h-[92dvh] w-full max-w-2xl space-y-3 overflow-y-auto p-4 text-sm">
      <h2 class="text-base font-semibold">{{ t('shield.login.preview.title') }}</h2>
      <p class="text-xs text-slate-500">{{ t('shield.login.preview.intro') }}</p>
      <p class="text-xs text-slate-500" data-testid="preview-mechanism">
        {{ t('shield.login.preview.mechanism', { bits: bits || '…' }) }}
      </p>
      <label class="flex items-center gap-2 text-xs">
        <input v-model="phone" type="checkbox" data-testid="preview-phone" />
        {{ t('shield.login.preview.mobile') }}
      </label>

      <!-- макет формы входа: строка состояния — та же, что на странице входа -->
      <div
        class="mx-auto space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700"
        :class="phone ? 'w-[22rem] max-w-full' : 'w-full max-w-md'"
        data-testid="preview-form"
      >
        <label class="block"
          ><span class="field-label">{{ t('shield.login.preview.mockEmail') }}</span>
          <input class="input" disabled value="employee@example.com"
        /></label>
        <label class="block"
          ><span class="field-label">{{ t('shield.login.preview.mockPassword') }}</span>
          <input class="input" type="password" disabled value="••••••••••"
        /></label>
        <p
          v-if="state === 'rejected'"
          class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          role="alert"
          data-testid="preview-error"
        >
          {{ t('shield.login.preview.rejected') }}
        </p>
        <p
          v-else-if="state === 'failed'"
          class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          role="alert"
          data-testid="preview-error"
        >
          {{ t('shield.login.preview.failed', { message }) }}
        </p>
        <p
          v-if="state === 'working'"
          class="text-center text-xs text-slate-500"
          role="status"
          aria-live="polite"
          data-testid="preview-working"
        >
          {{ t('shield.login.preview.working', { s: seconds }) }}
        </p>
        <p
          v-else-if="state === 'ok'"
          class="text-center text-xs text-emerald-700 dark:text-emerald-300"
          role="status"
          data-testid="preview-ok"
        >
          {{ t('shield.login.preview.ok', { s: seconds }) }}
        </p>
        <p
          v-else-if="state === 'idle'"
          class="text-center text-xs text-slate-500"
          data-testid="preview-idle"
        >
          {{ t('shield.login.preview.idle') }}
        </p>
        <button type="button" class="btn-primary min-h-10 w-full" disabled>
          {{ t('shield.login.preview.mockSubmit') }}
        </button>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="btn-primary"
          :disabled="state === 'working'"
          data-testid="preview-start"
          @click="run(false)"
        >
          {{ state === 'idle' ? t('shield.login.preview.start') : t('shield.login.preview.again') }}
        </button>
        <button
          type="button"
          class="btn"
          :disabled="state === 'working'"
          data-testid="preview-wrong"
          @click="run(true)"
        >
          {{ t('shield.login.preview.error') }}
        </button>
        <button
          type="button"
          class="btn ml-auto"
          data-testid="preview-close"
          @click="emit('close')"
        >
          {{ t('shield.login.preview.close') }}
        </button>
      </div>
      <p class="text-xs text-slate-500">{{ t('shield.login.preview.reproduce') }}</p>
    </div>
  </div>
</template>
