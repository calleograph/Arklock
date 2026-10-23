<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { openHandoff } from '@arklock/crypto';
import { api, ApiError } from '../services/api';

/** Публичная страница получения секрета по ссылке. Ключ находится во фрагменте адреса и серверу не передаётся. */
const { t } = useI18n();
const route = useRoute();
const id = String(route.params.id);
const fragment = location.hash.replace(/^#/, '');

interface Payload {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  fields: { name: string; value: string }[];
}

const state = ref<'loading' | 'ready' | 'open' | 'gone' | 'bad'>('loading');
const hasPassphrase = ref(false);
const remaining = ref(0);
const passphrase = ref('');
const payload = ref<Payload | null>(null);
const error = ref('');
const show = ref(false);
const left = computed(() => remaining.value);
// примечание организации и окно после первого открытия — из сведений о ссылке
const notice = ref('');
const windowMinutes = ref<number | null>(null);

onMounted(async () => {
  if (!fragment) {
    state.value = 'bad';
    return;
  }
  try {
    const meta = await api<{
      hasPassphrase: boolean;
      remainingViews: number;
      notice?: string;
      openWindowMinutes?: number | null;
    }>('GET', `/handoffs/${id}/meta`, undefined, { auth: false });
    hasPassphrase.value = meta.hasPassphrase;
    remaining.value = meta.remainingViews;
    notice.value = meta.notice ?? '';
    windowMinutes.value = meta.openWindowMinutes ?? null;
    state.value = 'ready';
  } catch {
    state.value = 'gone';
  }
});

async function open(): Promise<void> {
  error.value = '';
  try {
    const res = await api<{ ciphertext: string; remainingViews: number }>(
      'POST',
      `/handoffs/${id}/open`,
      {},
      { auth: false },
    );
    remaining.value = res.remainingViews;
    try {
      payload.value = await openHandoff<Payload>(
        id,
        res.ciphertext,
        fragment,
        passphrase.value || undefined,
      );
      state.value = 'open';
    } catch {
      // Просмотр уже израсходован: честно сообщаем, что ключ или фраза неверны.
      error.value = t('handoff.wrongKey');
    }
  } catch (e) {
    state.value = e instanceof ApiError && e.status === 404 ? 'gone' : 'ready';
    if (state.value === 'ready') error.value = t('error.generic');
  }
}
async function copy(v: string): Promise<void> {
  await navigator.clipboard.writeText(v).catch(() => undefined);
}
</script>

<template>
  <section class="mx-auto max-w-lg space-y-4">
    <h1 class="text-xl font-semibold">{{ t('handoff.title') }}</h1>
    <p v-if="state === 'loading'" class="text-sm text-slate-500">{{ t('common.working') }}</p>
    <p
      v-else-if="state === 'bad'"
      class="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      data-testid="handoff-bad"
    >
      {{ t('handoff.bad') }}
    </p>
    <p
      v-else-if="state === 'gone'"
      class="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
      data-testid="handoff-gone"
    >
      {{ t('handoff.gone') }}
    </p>

    <div v-else-if="state === 'ready'" class="card space-y-3 p-4">
      <p class="text-sm">{{ t('handoff.intro', { n: left }) }}</p>
      <p v-if="windowMinutes" class="text-xs text-slate-500" data-testid="handoff-window">
        {{ t('handoff.window', { n: windowMinutes }) }}
      </p>
      <p v-if="notice" class="notice notice-warn text-sm" data-testid="handoff-notice">
        {{ notice }}
      </p>
      <input
        v-if="hasPassphrase"
        v-model="passphrase"
        type="password"
        autocomplete="off"
        class="input"
        :placeholder="t('handoff.passphrase')"
        data-testid="handoff-pass"
      />
      <button type="button" class="btn-primary" data-testid="handoff-open" @click="open">
        {{ t('handoff.open') }}
      </button>
      <p v-if="error" class="text-sm text-red-600" role="alert" data-testid="handoff-error">
        {{ error }}
      </p>
    </div>

    <div v-else-if="payload" class="card space-y-3 p-4 text-sm" data-testid="handoff-content">
      <h2 class="text-lg font-semibold">{{ payload.title }}</h2>
      <div v-if="payload.username">
        <div class="text-xs text-slate-500">{{ t('vault.username') }}</div>
        <div class="flex justify-between gap-2">
          <span class="break-all" data-testid="handoff-username">{{ payload.username }}</span
          ><button type="button" class="btn" @click="copy(payload.username)">
            {{ t('common.copy') }}
          </button>
        </div>
      </div>
      <div v-if="payload.password">
        <div class="text-xs text-slate-500">{{ t('vault.password') }}</div>
        <div class="flex justify-between gap-2">
          <span class="break-all font-mono" data-testid="handoff-password">{{
            show ? payload.password : '••••••••••'
          }}</span
          ><span class="flex gap-1"
            ><button type="button" class="btn" @click="show = !show">
              {{ show ? t('common.hide') : t('common.show') }}</button
            ><button type="button" class="btn" @click="copy(payload.password)">
              {{ t('common.copy') }}
            </button></span
          >
        </div>
      </div>
      <div v-if="payload.url">
        <div class="text-xs text-slate-500">{{ t('vault.url') }}</div>
        <div class="break-all">{{ payload.url }}</div>
      </div>
      <div v-for="f in payload.fields" :key="f.name">
        <div class="text-xs text-slate-500">{{ f.name }}</div>
        <div class="break-all">{{ f.value }}</div>
      </div>
      <div v-if="payload.notes" class="whitespace-pre-wrap">{{ payload.notes }}</div>
      <p class="text-xs text-slate-500">
        {{ remaining > 0 ? t('handoff.leftViews', { n: remaining }) : t('handoff.lastView') }}
      </p>
    </div>
  </section>
</template>
