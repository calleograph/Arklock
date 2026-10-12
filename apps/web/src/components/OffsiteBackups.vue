<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { reauth } from '../services/account';
import { errorMessage } from '../services/helpers';
import { useAuthStore } from '../stores/auth';

const { t } = useI18n();
const auth = useAuthStore();

interface Snapshot {
  configured: boolean;
  type: '' | 's3' | 'smb';
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  host: string;
  share: string;
  user: string;
  auto: boolean;
  keep: number;
  lastAt: string;
  lastResult: string;
  lastFile: string;
  lastError: string;
  listedAt: string;
  listError: string;
  items: { name: string; size: number }[];
}

const snap = ref<Snapshot | null>(null);
const helperAlive = ref(true);
const local = ref<{ name: string; size: number; createdAt: string }[]>([]);
const error = ref('');
const notice = ref('');
const busy = ref(false);
const password = ref('');
let alive = true;
onBeforeUnmount(() => (alive = false));

const form = ref({
  type: 's3' as 's3' | 'smb',
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  prefix: '',
  accessKey: '',
  secretKey: '',
  pathStyle: true,
  caPem: '',
  insecureTls: false,
  allowHttp: false,
  host: '',
  port: 445,
  share: '',
  user: '',
  smbPassword: '',
  domain: '',
  encrypt: true,
  auto: true,
  keep: 14,
});

async function load(): Promise<void> {
  const r = await api<{ helperAlive: boolean; offsite: Snapshot | null }>(
    'GET',
    '/admin/backups/offsite',
  );
  helperAlive.value = r.helperAlive;
  snap.value = r.offsite;
  const s = r.offsite;
  if (s?.configured) {
    form.value.type = s.type === 'smb' ? 'smb' : 's3';
    form.value.endpoint = s.endpoint;
    form.value.region = s.region || form.value.region;
    form.value.bucket = s.bucket;
    form.value.prefix = s.prefix;
    form.value.host = s.host;
    form.value.share = s.share;
    form.value.user = s.user;
    form.value.auto = s.auto;
    form.value.keep = s.keep;
  }
  const l = await api<{ backups: { items: typeof local.value } | null }>('GET', '/admin/backups');
  local.value = l.backups?.items ?? [];
}
onMounted(() => load().catch((e) => (error.value = errorMessage(e, t))));

/** Ждёт завершения операции помощника, как и остальные действия с копиями. */
async function waitOp(requestId: string): Promise<{ ok: boolean; message: string }> {
  const end = Date.now() + 15 * 60_000;
  while (Date.now() < end && alive) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const o = await api<{ status: { requestId: string; state: string; message?: string } }>(
        'GET',
        '/admin/updates',
      );
      if (o.status.requestId === requestId && o.status.state !== 'running')
        return { ok: o.status.state === 'success', message: o.status.message ?? '' };
    } catch {
      /* приложение может быть недоступно — продолжаем ждать */
    }
  }
  return { ok: false, message: t('sys.timeout') };
}

async function token(): Promise<Record<string, string>> {
  if (!auth.user) return {};
  const r = await reauth(auth.user, password.value);
  return { 'X-Reauth-Token': r.token };
}

async function run(
  fn: () => Promise<{ requestId: string }>,
  after?: () => Promise<void>,
): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const r = await fn();
    notice.value = t('sys.running');
    const res = await waitOp(r.requestId);
    if (res.ok) notice.value = res.message || t('sys.done');
    else {
      notice.value = '';
      error.value = res.message || t('error.generic');
    }
    await load();
    if (after) await after();
  } catch (e) {
    notice.value = '';
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

const needPassword = ref(false);
const body = () => {
  const f = form.value;
  const common = { prefix: f.prefix, auto: f.auto, keep: Number(f.keep) };
  return f.type === 's3'
    ? {
        type: 's3',
        endpoint: f.endpoint,
        region: f.region,
        bucket: f.bucket,
        accessKey: f.accessKey,
        secretKey: f.secretKey,
        pathStyle: f.pathStyle,
        caPem: f.caPem,
        insecureTls: f.insecureTls,
        allowHttp: f.allowHttp,
        ...common,
      }
    : {
        type: 'smb',
        host: f.host,
        port: Number(f.port),
        share: f.share,
        user: f.user,
        password: f.smbPassword,
        domain: f.domain,
        encrypt: f.encrypt,
        ...common,
      };
};
const save = () =>
  run(async () => {
    if (!password.value) {
      needPassword.value = true;
      throw new Error(t('offsite.needPassword'));
    }
    const headers = await token();
    needPassword.value = false;
    const r = await api<{ requestId: string }>('PUT', '/admin/backups/offsite', body(), {
      headers,
    });
    form.value.secretKey = '';
    form.value.smbPassword = '';
    return r;
  });

const act = (action: string, file?: string, guarded = false) =>
  run(async () => {
    let headers: Record<string, string> = {};
    if (guarded) {
      if (!password.value) {
        needPassword.value = true;
        throw new Error(t('offsite.needPassword'));
      }
      headers = await token();
      needPassword.value = false;
    }
    return api<{ requestId: string }>(
      'POST',
      '/admin/backups/offsite',
      { action, file },
      { headers },
    );
  });

const fmtSize = (n: number) =>
  n > 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GiB` : `${(n / (1 << 20)).toFixed(1)} MiB`;
const fmtDate = (iso: string) => (iso ? new Date(iso).toLocaleString() : '—');
const remoteNames = computed(() => new Set((snap.value?.items ?? []).map((i) => i.name)));
const where = computed(() => {
  const s = snap.value;
  if (!s?.configured) return '';
  return s.type === 's3'
    ? `${s.endpoint} / ${s.bucket}${s.prefix ? '/' + s.prefix : ''}`
    : `//${s.host}/${s.share}${s.prefix ? '/' + s.prefix : ''}`;
});
</script>

<template>
  <section class="space-y-3" data-testid="offsite">
    <h2 class="text-base font-semibold">{{ t('offsite.title') }}</h2>
    <p class="text-sm text-slate-500">{{ t('offsite.hint') }}</p>
    <p v-if="!helperAlive" class="text-sm text-amber-700">{{ t('offsite.noHelper') }}</p>
    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
      role="alert"
      data-testid="offsite-error"
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      role="status"
      data-testid="offsite-notice"
    >
      {{ notice }}
    </p>

    <div v-if="snap?.configured" class="card space-y-1 p-3 text-sm" data-testid="offsite-status">
      <div>
        <span class="badge">{{ snap.type === 's3' ? 'S3' : 'SMB' }}</span>
        <code class="ml-2 break-all">{{ where }}</code>
      </div>
      <div class="text-xs text-slate-500">
        {{ snap.auto ? t('offsite.autoOn') : t('offsite.autoOff') }} · {{ t('offsite.keepN') }}
        {{ snap.keep }}
      </div>
      <div v-if="snap.lastAt" class="text-xs">
        {{ t('offsite.last') }}: {{ fmtDate(snap.lastAt) }} —
        <span :class="snap.lastResult === 'ok' ? 'text-emerald-600' : 'text-red-600'">{{
          snap.lastResult === 'ok' ? t('offsite.ok') : t('offsite.failed')
        }}</span>
        <span v-if="snap.lastFile" class="text-slate-500"> ({{ snap.lastFile }})</span>
      </div>
    </div>

    <form class="card max-w-2xl space-y-3 p-4 text-sm" @submit.prevent="save">
      <label class="block"
        >{{ t('offsite.type') }}
        <select v-model="form.type" class="input w-auto" data-testid="offsite-type">
          <option value="s3">S3</option>
          <option value="smb">SMB</option>
        </select>
      </label>

      <template v-if="form.type === 's3'">
        <label class="block"
          >{{ t('offsite.endpoint')
          }}<input
            v-model="form.endpoint"
            class="input font-mono"
            placeholder="https://s3.example.com"
            data-testid="offsite-endpoint"
        /></label>
        <div class="flex flex-wrap gap-3">
          <label class="flex-1"
            >{{ t('offsite.region') }}<input v-model="form.region" class="input"
          /></label>
          <label class="flex-1"
            >{{ t('offsite.bucket')
            }}<input v-model="form.bucket" class="input" data-testid="offsite-bucket"
          /></label>
        </div>
        <div class="flex flex-wrap gap-3">
          <label class="flex-1"
            >{{ t('offsite.accessKey')
            }}<input v-model="form.accessKey" class="input font-mono" data-testid="offsite-access"
          /></label>
          <label class="flex-1"
            >{{ t('offsite.secretKey')
            }}<input
              v-model="form.secretKey"
              type="password"
              autocomplete="new-password"
              class="input"
              :placeholder="snap?.configured ? t('offsite.keepSecret') : ''"
              data-testid="offsite-secret"
          /></label>
        </div>
        <details class="text-xs">
          <summary class="cursor-pointer">{{ t('offsite.advanced') }}</summary>
          <label class="mt-2 flex items-center gap-2"
            ><input v-model="form.pathStyle" type="checkbox" /> {{ t('offsite.pathStyle') }}</label
          >
          <label class="mt-2 block"
            >{{ t('offsite.ca') }}
            <textarea v-model="form.caPem" rows="3" class="input font-mono text-xs" />
          </label>
          <label class="mt-2 flex items-center gap-2"
            ><input v-model="form.insecureTls" type="checkbox" />
            {{ t('offsite.insecureTls') }}</label
          >
          <label class="mt-2 flex items-center gap-2"
            ><input v-model="form.allowHttp" type="checkbox" data-testid="offsite-allow-http" />
            {{ t('offsite.allowHttp') }}</label
          >
        </details>
      </template>

      <template v-else>
        <div class="flex flex-wrap gap-3">
          <label class="flex-1"
            >{{ t('offsite.host')
            }}<input v-model="form.host" class="input" data-testid="offsite-host"
          /></label>
          <label class="w-24"
            >{{ t('offsite.port') }}<input v-model.number="form.port" type="number" class="input"
          /></label>
          <label class="flex-1"
            >{{ t('offsite.share')
            }}<input v-model="form.share" class="input" data-testid="offsite-share"
          /></label>
        </div>
        <div class="flex flex-wrap gap-3">
          <label class="flex-1"
            >{{ t('offsite.user')
            }}<input v-model="form.user" class="input" data-testid="offsite-user"
          /></label>
          <label class="flex-1"
            >{{ t('offsite.smbPassword')
            }}<input
              v-model="form.smbPassword"
              type="password"
              autocomplete="new-password"
              class="input"
              :placeholder="snap?.configured ? t('offsite.keepSecret') : ''"
              data-testid="offsite-smb-password"
          /></label>
          <label class="flex-1"
            >{{ t('offsite.domain') }}<input v-model="form.domain" class="input"
          /></label>
        </div>
        <label class="flex items-center gap-2"
          ><input v-model="form.encrypt" type="checkbox" /> {{ t('offsite.smbEncrypt') }}</label
        >
      </template>

      <label class="block"
        >{{ t('offsite.prefix')
        }}<input v-model="form.prefix" class="input" placeholder="arklock/server1"
      /></label>
      <div class="flex flex-wrap items-center gap-4">
        <label class="flex items-center gap-2"
          ><input v-model="form.auto" type="checkbox" data-testid="offsite-auto" />
          {{ t('offsite.auto') }}</label
        >
        <label
          >{{ t('offsite.keep')
          }}<input
            v-model.number="form.keep"
            type="number"
            min="1"
            max="365"
            class="input ml-2 w-24"
        /></label>
      </div>

      <label class="block"
        >{{ t('offsite.confirmPassword') }}
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          class="input"
          :class="needPassword ? 'border-red-500' : ''"
          data-testid="offsite-password"
        />
      </label>
      <div class="flex flex-wrap gap-2">
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="offsite-save">
          {{ t('common.save') }}
        </button>
        <button
          type="button"
          class="btn"
          :disabled="busy || !snap?.configured"
          data-testid="offsite-test"
          @click="act('test')"
        >
          {{ t('offsite.test') }}
        </button>
        <button
          type="button"
          class="btn"
          :disabled="busy || !snap?.configured"
          data-testid="offsite-refresh"
          @click="act('refresh')"
        >
          {{ t('offsite.refresh') }}
        </button>
        <button
          type="button"
          class="btn-danger"
          :disabled="busy || !snap?.configured"
          data-testid="offsite-clear"
          @click="act('clear', undefined, true)"
        >
          {{ t('offsite.clear') }}
        </button>
      </div>
    </form>

    <div v-if="snap?.configured" class="card overflow-x-auto" data-testid="offsite-local">
      <table class="min-w-full text-sm">
        <caption class="p-3 text-left text-xs text-slate-500">
          {{
            t('offsite.localCaption')
          }}
        </caption>
        <tbody>
          <tr
            v-for="b in local"
            :key="b.name"
            class="border-t border-slate-200 dark:border-slate-800"
            data-testid="offsite-local-row"
          >
            <td class="px-3 py-2 font-mono text-xs">{{ b.name }}</td>
            <td class="text-xs">{{ fmtSize(b.size) }}</td>
            <td>
              <span v-if="remoteNames.has(b.name)" class="text-xs text-emerald-600">{{
                t('offsite.there')
              }}</span>
            </td>
            <td class="px-3 text-right">
              <button
                type="button"
                class="btn"
                :disabled="busy"
                :data-testid="`offsite-push-${b.name}`"
                @click="act('push', b.name)"
              >
                {{ t('offsite.push') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!local.length" class="p-3 text-sm text-slate-500">{{ t('sys.backups.empty') }}</p>
    </div>

    <div v-if="snap?.configured" class="card overflow-x-auto" data-testid="offsite-remote">
      <table class="min-w-full text-sm">
        <caption class="p-3 text-left text-xs text-slate-500">
          {{
            t('offsite.remoteCaption')
          }}
          <span v-if="snap.listedAt">· {{ fmtDate(snap.listedAt) }}</span>
          <span v-if="snap.listError" class="text-red-600"> · {{ snap.listError }}</span>
        </caption>
        <tbody>
          <tr
            v-for="b in snap.items"
            :key="b.name"
            class="border-t border-slate-200 dark:border-slate-800"
            data-testid="offsite-remote-row"
          >
            <td class="px-3 py-2 font-mono text-xs">{{ b.name }}</td>
            <td class="text-xs">{{ fmtSize(b.size) }}</td>
            <td class="space-x-1 whitespace-nowrap px-3 text-right">
              <button
                type="button"
                class="btn"
                :disabled="busy"
                :data-testid="`offsite-verify-${b.name}`"
                @click="act('verify', b.name)"
              >
                {{ t('offsite.verify') }}
              </button>
              <button
                type="button"
                class="btn"
                :disabled="busy"
                :data-testid="`offsite-pull-${b.name}`"
                @click="act('pull', b.name, true)"
              >
                {{ t('offsite.pull') }}
              </button>
              <button
                type="button"
                class="btn-danger"
                :disabled="busy"
                :data-testid="`offsite-delete-${b.name}`"
                @click="act('delete', b.name, true)"
              >
                {{ t('offsite.delete') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!snap.items.length" class="p-3 text-sm text-slate-500">{{ t('offsite.empty') }}</p>
    </div>
  </section>
</template>
