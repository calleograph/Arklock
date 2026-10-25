<script setup lang="ts">
import SwitchField from './SwitchField.vue';
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
      intro:
        'Вебхуки позволяют Arklock автоматически уведомлять другие системы о событиях: например, о создании пользователя, изменении прав или ошибке безопасности.',
      howTitle: 'Как настроить и проверить',
      how1: 'В принимающей системе (SIEM, чат, автоматизация) создайте адрес HTTPS, который принимает POST с JSON.',
      how2: 'Нажмите «Добавить вебхук», укажите адрес и, при желании, какие события нужны (например auth., admin.). Секрет подписи показывается один раз — сохраните его в принимающей системе.',
      how3: 'Нажмите «Проверить доставку»: Arklock отправит тестовое событие и покажет ответ получателя. Счётчики «доставлено / не доставлено» и последняя ошибка видны в строке вебхука.',
      how4: 'Принимающая система должна проверить подпись и отбросить сообщения со старой меткой времени.',
      exampleTitle: 'Пример запроса',
      errorsTitle: 'Частые ошибки',
      err1: 'Адрес во внутренней сети или по HTTP отклоняется: допустим только публичный HTTPS.',
      err2: 'Получатель отвечает не 2xx: доставка повторяется три раза (сразу, через 1 и 5 секунд), затем засчитывается как ошибка.',
      err3: 'Подпись не совпала: проверьте, что берётся тело ровно как получено, а секрет — тот, что показан при создании или перевыпуске.',
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
      logTitle: 'Журнал доставки',
      logEmpty: 'Доставок пока не было.',
      logOk: 'доставлено',
      logFail: 'не доставлено',
      logTries: 'попыток: {n}',
      logHint:
        'Последние 50 доставок: время, событие и ответ получателя. Содержимое сообщений не сохраняется.',
    },
    en: {
      hint: 'A webhook sends an external system a signed message about an activity-log event: who did what to which object. Passwords, entries and keys are never included.',
      intro:
        'Webhooks let Arklock automatically notify other systems about events: for example, a user created, permissions changed or a security error.',
      howTitle: 'How to set up and check',
      how1: 'In the receiving system (SIEM, chat, automation) create an HTTPS address that accepts a POST with JSON.',
      how2: 'Press “Add a webhook”, enter the address and, if you like, the events you need (for example auth., admin.). The signing secret is shown once — save it in the receiving system.',
      how3: 'Press “Test delivery”: Arklock sends a test event and shows the receiver’s answer. The delivered / failed counters and the last error are shown in the webhook row.',
      how4: 'The receiving system must verify the signature and drop messages with an old timestamp.',
      exampleTitle: 'Example request',
      errorsTitle: 'Common errors',
      err1: 'An internal-network or HTTP address is rejected: only public HTTPS is allowed.',
      err2: 'The receiver answers with a non-2xx code: delivery is retried three times (at once, after 1 and 5 seconds), then counted as failed.',
      err3: 'The signature does not match: make sure you use the body exactly as received and the secret shown when the webhook was created or reissued.',
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
      logTitle: 'Delivery log',
      logEmpty: 'Nothing has been delivered yet.',
      logOk: 'delivered',
      logFail: 'failed',
      logTries: 'attempts: {n}',
      logHint:
        'The last 50 deliveries: time, event and the receiver’s answer. Message contents are not stored.',
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
interface Delivery {
  at: string;
  event: string;
  ok: boolean;
  code: number | null;
  attempts: number;
  error: string | null;
}
const logs = ref<Record<string, Delivery[]>>({});
async function openLog(h: Hook, e: Event): Promise<void> {
  if (!h.id || !(e.target as HTMLDetailsElement).open) return;
  try {
    logs.value[h.id] = (
      await api<{ deliveries: Delivery[] }>('GET', `/admin/webhooks/${h.id}/deliveries`)
    ).deliveries;
  } catch (err) {
    error.value = errorMessage(err, gt);
  }
}

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
    <div class="space-y-1 text-sm">
      <p class="max-w-prose">{{ t('intro') }}</p>
      <p class="flex items-center gap-1 text-slate-500">
        {{ t('hint') }}<InfoHint :text="t('signHint')" />
      </p>
    </div>
    <details
      class="rounded-md border border-slate-200 p-3 text-sm dark:border-slate-700"
      data-testid="webhook-help"
    >
      <summary class="cursor-pointer font-medium">{{ t('howTitle') }}</summary>
      <ol class="mt-2 list-decimal space-y-1 pl-5">
        <li>{{ t('how1') }}</li>
        <li>{{ t('how2') }}</li>
        <li>{{ t('how3') }}</li>
        <li>{{ t('how4') }}</li>
      </ol>
      <h4 class="mt-3 font-medium">{{ t('exampleTitle') }}</h4>
      <pre class="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-xs dark:bg-slate-800/50">
POST /ваш-адрес HTTP/1.1
X-Arklock-Event: admin.user.create
X-Arklock-Timestamp: 1792400000
X-Arklock-Signature: sha256=3f5c…

{ "id": "…", "type": "admin.user.create", "at": "2026-10-25T09:00:00.000Z",
  "actor": "user:&lt;id&gt;", "target": "user:&lt;id&gt;", "detail": {} }</pre>
      <h4 class="mt-3 font-medium">{{ t('errorsTitle') }}</h4>
      <ul class="mt-1 list-disc space-y-1 pl-5">
        <li>{{ t('err1') }}</li>
        <li>{{ t('err2') }}</li>
        <li>{{ t('err3') }}</li>
      </ul>
    </details>
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
          <SwitchField v-model="h.enabled" :label="t('enabled')" />
          <SwitchField v-if="h.id" v-model="h.newSecret" :label="t('newSecret')" />
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
        <details v-if="h.id" data-testid="webhook-log" @toggle="openLog(h, $event)">
          <summary class="cursor-pointer text-xs font-medium">{{ t('logTitle') }}</summary>
          <p class="mt-1 text-xs text-slate-500">{{ t('logHint') }}</p>
          <p v-if="logs[h.id] && !logs[h.id]!.length" class="mt-1 text-xs">{{ t('logEmpty') }}</p>
          <ul v-else class="mt-1 divide-y divide-slate-200 text-xs dark:divide-slate-800">
            <li
              v-for="(d, k) in logs[h.id] ?? []"
              :key="k"
              class="flex flex-wrap gap-x-3 py-1"
              data-testid="webhook-log-row"
            >
              <time class="tabular-nums text-slate-500">{{ new Date(d.at).toLocaleString() }}</time>
              <span class="font-mono">{{ d.event }}</span>
              <span :class="d.ok ? 'text-emerald-700' : 'text-red-600'">
                {{ d.ok ? t('logOk') : t('logFail') }}{{ d.code ? ` · ${d.code}` : '' }}
              </span>
              <span class="text-slate-500">{{ t('logTries', { n: d.attempts }) }}</span>
              <span v-if="d.error" class="break-all text-red-600">{{ d.error }}</span>
            </li>
          </ul>
        </details>
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
