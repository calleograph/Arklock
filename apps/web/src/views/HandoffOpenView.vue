<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { openHandoff } from '@arklock/crypto';
import Icon from '../components/Icon.vue';
import { api, ApiError } from '../services/api';
import { when } from '../services/helpers';

/**
 * Публичная страница получения секрета по ссылке. Ключ — во фрагменте адреса (после «#»), серверу он не передаётся.
 * Фрагмент сразу убирается из адресной строки и истории и держится в памяти вкладки (sessionStorage): обновление
 * страницы его не теряет, закрытие вкладки — стирает. Квиток получения позволяет повторить запрос после обрыва связи
 * или обновления, не расходуя открытие; после расшифровки страница подтверждает получение и сервер всё уничтожает.
 */
const { t } = useI18n();
const route = useRoute();
const id = String(route.params.id);

interface Payload {
  title: string;
  person?: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  fields: { name: string; value: string }[];
}

const store = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(`arklock.handoff.${id}.${k}`) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string) => {
    try {
      sessionStorage.setItem(`arklock.handoff.${id}.${k}`, v);
    } catch {
      /* без хранилища вкладки обновление страницы потеряет ключ — это безопаснее, чем ошибка */
    }
  },
  clear: () => {
    try {
      for (const k of ['key', 'claim']) sessionStorage.removeItem(`arklock.handoff.${id}.${k}`);
    } catch {
      /* нечего стирать */
    }
  },
};
const fromUrl = location.hash.replace(/^#/, '');
if (fromUrl) {
  store.set('key', fromUrl);
  // ключ не остаётся в адресной строке, истории браузера и при копировании адреса со страницы
  history.replaceState(history.state, '', location.pathname);
}
const fragment = fromUrl || store.get('key');

const state = ref<'loading' | 'ready' | 'open' | 'gone' | 'bad'>('loading');
const hasPassphrase = ref(false);
const remaining = ref(0);
const expiresAt = ref('');
const passphrase = ref('');
const payload = ref<Payload | null>(null);
const error = ref('');
const busy = ref(false);
const show = ref(false);
const copied = ref('');
const notice = ref('');
const windowMinutes = ref<number | null>(null);
// полученный шифртекст: при неверном коде получатель вводит его снова, не расходуя ещё одно открытие
let ciphertext = '';

function claimToken(): string {
  let c = store.get('claim');
  if (!c) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    c = btoa(String.fromCharCode(...b))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    store.set('claim', c);
  }
  return c;
}

onMounted(async () => {
  if (!fragment) {
    // ключа нет: либо ссылку скопировали не целиком, либо её уже открыли в этой вкладке (ключ стёрт после получения)
    const known = await api('GET', `/handoffs/${id}/meta`, undefined, { auth: false }).then(
      () => true,
      () => false,
    );
    state.value = known ? 'bad' : 'gone';
    return;
  }
  // страницу обновили после получения: тот же квиток возвращает содержимое без нового открытия
  if (store.get('claim')) {
    await fetchContent();
    return;
  }
  try {
    const meta = await api<{
      hasPassphrase: boolean;
      remainingViews: number;
      expiresAt?: string;
      notice?: string;
      openWindowMinutes?: number | null;
    }>('GET', `/handoffs/${id}/meta`, undefined, { auth: false });
    hasPassphrase.value = meta.hasPassphrase;
    remaining.value = meta.remainingViews;
    expiresAt.value = meta.expiresAt ?? '';
    notice.value = meta.notice ?? '';
    windowMinutes.value = meta.openWindowMinutes ?? null;
    state.value = 'ready';
  } catch {
    store.clear();
    state.value = 'gone';
  }
});

async function fetchContent(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    const res = await api<{ ciphertext: string; remainingViews: number; hasPassphrase: boolean }>(
      'POST',
      `/handoffs/${id}/open`,
      { claim: claimToken() },
      { auth: false },
    );
    ciphertext = res.ciphertext;
    remaining.value = res.remainingViews;
    hasPassphrase.value = res.hasPassphrase;
    await decrypt();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      store.clear();
      state.value = 'gone';
    } else {
      // нет связи или сервер недоступен: открытие не потеряно, квиток позволит повторить
      state.value = 'ready';
      error.value = t('handoff.offline');
    }
  } finally {
    busy.value = false;
  }
}

async function decrypt(): Promise<void> {
  try {
    payload.value = await openHandoff<Payload>(
      id,
      ciphertext,
      fragment,
      passphrase.value || undefined,
    );
    ciphertext = '';
    state.value = 'open';
    const claim = store.get('claim');
    store.clear();
    // получено: квиток гасится, после последнего открытия сервер уничтожает содержимое сразу
    void api('POST', `/handoffs/${id}/ack`, { claim }, { auth: false }).catch(() => undefined);
  } catch {
    state.value = 'ready';
    error.value = hasPassphrase.value ? t('handoff.wrongCode') : t('handoff.wrongKey');
  }
}

async function open(): Promise<void> {
  if (ciphertext) await decrypt();
  else await fetchContent();
}

async function copy(key: string, v: string): Promise<void> {
  await navigator.clipboard.writeText(v).catch(() => undefined);
  copied.value = key;
  setTimeout(() => {
    if (copied.value === key) copied.value = '';
  }, 2000);
}
// уходя со страницы, содержимое не остаётся в памяти вкладки
onBeforeUnmount(() => {
  payload.value = null;
  ciphertext = '';
});
const rows = () => {
  const p = payload.value;
  if (!p) return [];
  return [
    { key: 'person', label: t('handoff.person'), value: p.person ?? '', secret: false },
    { key: 'username', label: t('vault.username'), value: p.username, secret: false },
    { key: 'password', label: t('vault.password'), value: p.password, secret: true },
    { key: 'url', label: t('vault.url'), value: p.url, secret: false },
    ...p.fields.map((f, i) => ({ key: `f${i}`, label: f.name, value: f.value, secret: false })),
  ].filter((r) => r.value);
};
</script>

<template>
  <section class="mx-auto max-w-lg space-y-4" data-testid="handoff-page">
    <h1 class="text-xl font-semibold">{{ t('handoff.title') }}</h1>
    <p v-if="state === 'loading'" class="text-sm text-slate-500">{{ t('common.working') }}</p>
    <p v-else-if="state === 'bad'" class="notice notice-error text-sm" data-testid="handoff-bad">
      {{ t('handoff.bad') }}
    </p>
    <p v-else-if="state === 'gone'" class="notice notice-warn text-sm" data-testid="handoff-gone">
      {{ t('handoff.gone') }}
    </p>

    <div v-else-if="state === 'ready'" class="card space-y-4 p-4">
      <p class="text-sm">{{ t('handoff.intro', { n: remaining }) }}</p>
      <p v-if="expiresAt" class="text-xs text-slate-500" data-testid="handoff-expires">
        {{ t('handoff.until', { at: when(expiresAt) }) }}
      </p>
      <p v-if="windowMinutes" class="text-xs text-slate-500" data-testid="handoff-window">
        {{ t('handoff.window', { n: windowMinutes }) }}
      </p>
      <p v-if="notice" class="notice notice-warn text-sm" data-testid="handoff-notice">
        {{ notice }}
      </p>
      <label v-if="hasPassphrase" class="block text-sm">
        {{ t('handoff.code') }}
        <input
          v-model="passphrase"
          type="password"
          autocomplete="off"
          class="input"
          data-testid="handoff-pass"
          @keydown.enter="open"
        />
      </label>
      <button
        type="button"
        class="btn-primary tap-target"
        :disabled="busy || (hasPassphrase && !passphrase)"
        data-testid="handoff-open"
        @click="open"
      >
        <Icon name="eye" /> {{ t('handoff.open') }}
      </button>
      <p v-if="error" class="field-error" role="alert" data-testid="handoff-error">
        {{ error }}
      </p>
    </div>

    <div v-else-if="payload" class="card space-y-4 p-4 text-sm" data-testid="handoff-content">
      <h2 v-if="payload.title" class="text-lg font-semibold">{{ payload.title }}</h2>
      <div v-for="r in rows()" :key="r.key" class="space-y-1">
        <div class="text-xs text-slate-500">{{ r.label }}</div>
        <div class="flex items-center justify-between gap-2">
          <span
            class="min-w-0 break-words"
            :class="r.secret ? 'font-mono' : ''"
            :data-testid="`handoff-${r.key}`"
            >{{ r.secret && !show ? '••••••••••' : r.value }}</span
          >
          <span class="flex shrink-0 gap-2">
            <button
              v-if="r.secret"
              type="button"
              class="btn tap-target"
              data-testid="handoff-show"
              @click="show = !show"
            >
              {{ show ? t('common.hide') : t('common.show') }}
            </button>
            <button
              type="button"
              class="btn tap-target"
              :data-testid="`handoff-copy-${r.key}`"
              @click="copy(r.key, r.value)"
            >
              <Icon :name="copied === r.key ? 'check' : 'copy'" />
              {{ copied === r.key ? t('handoff.copied') : t('common.copy') }}
            </button>
          </span>
        </div>
      </div>
      <div v-if="payload.notes" class="space-y-1">
        <div class="text-xs text-slate-500">{{ t('handoff.notes') }}</div>
        <div class="whitespace-pre-wrap break-words" data-testid="handoff-notes">
          {{ payload.notes }}
        </div>
      </div>
      <p class="notice notice-warn text-xs" data-testid="handoff-after">
        {{ remaining > 0 ? t('handoff.leftViews', { n: remaining }) : t('handoff.lastView') }}
      </p>
    </div>
  </section>
</template>
