<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { i18n } from '../i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import InfoHint from './InfoHint.vue';

const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      hint: 'Вебхук отправляет во внешнюю систему подписанное сообщение о событии журнала: кто, что и над каким объектом сделал. Пароли, записи и ключи в сообщения не попадают.',
      add: 'Добавить вебхук',
      name: 'Название',
      url: 'Адрес получателя (HTTPS)',
      prefixes: 'События (начало названия через запятую; пусто — все)',
      enabled: 'Включён',
      newSecret: 'Выпустить новый секрет подписи',
      remove: 'Удалить',
      test: 'Проверить доставку',
      testOk: 'Получатель ответил: {s}',
      testFail: 'Не удалось: {r}',
      secretTitle: 'Секрет подписи показан один раз. Сохраните его в принимающей системе:',
      stats: 'Доставлено: {s} · не доставлено: {f}',
      signHint:
        'Подпись: заголовок X-Arklock-Signature = sha256=HMAC-SHA256(секрет, «метка.тело»), метка — в X-Arklock-Timestamp. Получатель должен проверять подпись и отбрасывать старые метки.',
      saveFirst: 'Сначала сохраните изменения, затем проверяйте доставку.',
      limit: 'До десяти вебхуков.',
    },
    en: {
      hint: 'A webhook sends an external system a signed message about an activity-log event: who did what to which object. Passwords, entries and keys are never included.',
      add: 'Add a webhook',
      name: 'Name',
      url: 'Receiver address (HTTPS)',
      prefixes: 'Events (start of the name, comma-separated; empty — all)',
      enabled: 'Enabled',
      newSecret: 'Issue a new signing secret',
      remove: 'Delete',
      test: 'Test delivery',
      testOk: 'The receiver answered: {s}',
      testFail: 'Failed: {r}',
      secretTitle: 'The signing secret is shown once. Save it in the receiving system:',
      stats: 'Delivered: {s} · failed: {f}',
      signHint:
        'Signature: header X-Arklock-Signature = sha256=HMAC-SHA256(secret, "timestamp.body"), the timestamp is in X-Arklock-Timestamp. The receiver must verify the signature and drop old timestamps.',
      saveFirst: 'Save your changes first, then test the delivery.',
      limit: 'Up to ten webhooks.',
    },
  },
});
const gt = i18n.global.t as (k: string) => string;

interface Hook {
  id?: string;
  name: string;
  url: string;
  prefixes: string;
  enabled: boolean;
  newSecret?: boolean;
  status?: { sent: number; failed: number; lastError: string };
}
const hooks = ref<Hook[]>([]);
const secrets = ref<{ name: string; secret: string }[]>([]);
const error = ref('');
const notice = ref('');
const results = ref<Record<number, string>>({});
const busy = ref(false);

async function load(): Promise<void> {
  const r = await api<{
    hooks: (Omit<Hook, 'prefixes'> & { prefixes: string[] })[];
  }>('GET', '/admin/webhooks');
  hooks.value = r.hooks.map((h) => ({ ...h, prefixes: h.prefixes.join(', ') }));
}
onMounted(() => load().catch((e) => (error.value = errorMessage(e, gt))));

const add = () => void hooks.value.push({ name: '', url: 'https://', prefixes: '', enabled: true });

async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const r = await api<{ issuedSecrets: Record<string, string> }>('PUT', '/admin/webhooks', {
      hooks: hooks.value.map((h) => ({
        id: h.id,
        name: h.name,
        url: h.url,
        enabled: h.enabled,
        newSecret: h.newSecret || undefined,
        prefixes: h.prefixes
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      })),
    });
    // новые записи не имеют id до сохранения: сопоставляем выпущенные секреты после перезагрузки списка
    const before = new Set(hooks.value.map((h) => h.id).filter(Boolean));
    await load();
    secrets.value = hooks.value
      .filter((h) => h.id && r.issuedSecrets[h.id])
      .map((h) => ({
        name: h.name || (before.has(h.id) ? h.id! : h.url),
        secret: r.issuedSecrets[h.id!]!,
      }));
    notice.value = gt('admin.saved');
  } catch (e) {
    error.value = errorMessage(e, gt);
  } finally {
    busy.value = false;
  }
}

async function test(h: Hook, i: number): Promise<void> {
  if (!h.id) return;
  try {
    const r = await api<{ ok: boolean; status?: number; reason?: string }>(
      'POST',
      `/admin/webhooks/${h.id}/test`,
    );
    results.value[i] = r.ok
      ? t('testOk', { s: r.status ?? 0 })
      : t('testFail', { r: r.reason ?? `HTTP ${r.status}` });
  } catch (e) {
    results.value[i] = errorMessage(e, gt);
  }
}
</script>

<template>
  <div class="space-y-4" data-testid="webhook-settings">
    <p class="flex items-center gap-1 text-sm text-slate-500">
      {{ t('hint') }}<InfoHint :text="t('signHint')" />
    </p>
    <p v-if="error" class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      role="status"
    >
      {{ notice }}
    </p>
    <div
      v-if="secrets.length"
      class="card space-y-1 border-amber-300 p-4 text-sm"
      data-testid="webhook-secrets"
    >
      <p class="font-medium">{{ t('secretTitle') }}</p>
      <p v-for="s in secrets" :key="s.secret" class="break-all font-mono text-xs">
        {{ s.name }}: {{ s.secret }}
      </p>
    </div>
    <form class="space-y-3" @submit.prevent="save">
      <div
        v-for="(h, i) in hooks"
        :key="h.id ?? i"
        class="card max-w-2xl space-y-2 p-4 text-sm"
        data-testid="webhook-row"
      >
        <label class="block"
          >{{ t('name')
          }}<input
            v-model="h.name"
            required
            maxlength="100"
            class="input"
            data-testid="webhook-name"
        /></label>
        <label class="block"
          >{{ t('url')
          }}<input v-model="h.url" required class="input font-mono" data-testid="webhook-url"
        /></label>
        <label class="block"
          >{{ t('prefixes') }}<input v-model="h.prefixes" class="input" placeholder="auth., admin."
        /></label>
        <div class="flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2"
            ><input v-model="h.enabled" type="checkbox" /> {{ t('enabled') }}</label
          >
          <label v-if="h.id" class="flex items-center gap-2"
            ><input v-model="h.newSecret" type="checkbox" /> {{ t('newSecret') }}</label
          >
          <button type="button" class="btn-danger" @click="hooks.splice(i, 1)">
            {{ t('remove') }}
          </button>
          <button v-if="h.id" type="button" class="btn" @click="test(h, i)">
            {{ t('test') }}
          </button>
          <span v-else class="text-xs text-slate-500">{{ t('saveFirst') }}</span>
        </div>
        <p v-if="h.status" class="text-xs text-slate-500">
          {{ t('stats', { s: h.status.sent, f: h.status.failed }) }}
          <span v-if="h.status.lastError" class="text-red-600">· {{ h.status.lastError }}</span>
        </p>
        <p v-if="results[i]" class="text-xs" role="status">{{ results[i] }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn"
          :disabled="hooks.length >= 10"
          data-testid="webhook-add"
          @click="add"
        >
          {{ t('add') }}
        </button>
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="webhook-save">
          {{ gt('common.save') }}
        </button>
        <span v-if="hooks.length >= 10" class="text-xs text-slate-500">{{ t('limit') }}</span>
      </div>
    </form>
  </div>
</template>
