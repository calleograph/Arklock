<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';

const { t } = useI18n();

const form = ref({
  enabled: false,
  host: '',
  port: 514,
  protocol: 'tcp' as 'udp' | 'tcp' | 'tls',
  insecureTls: false,
  prefixes: '',
});
const status = ref<{
  sent: number;
  failed: number;
  lastError: string;
  lastAt: string | null;
} | null>(null);
const error = ref('');
const notice = ref('');
const result = ref('');
const busy = ref(false);

async function load(): Promise<void> {
  const r = await api<Record<string, unknown>>('GET', '/admin/syslog');
  status.value = r.status as typeof status.value;
  if (r.configured) {
    form.value = {
      enabled: r.enabled === true,
      host: String(r.host ?? ''),
      port: Number(r.port ?? 514),
      protocol: (r.protocol as 'udp' | 'tcp' | 'tls') ?? 'tcp',
      insecureTls: r.insecureTls === true,
      prefixes: ((r.prefixes as string[]) ?? []).join(', '),
    };
  }
}
onMounted(() => load().catch((e) => (error.value = errorMessage(e, t))));

const body = () => ({
  enabled: form.value.enabled,
  host: form.value.host,
  port: Number(form.value.port),
  protocol: form.value.protocol,
  insecureTls: form.value.insecureTls,
  prefixes: form.value.prefixes
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
});

async function wrap(fn: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  result.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
const save = () =>
  wrap(async () => {
    await api('PUT', '/admin/syslog', body());
    notice.value = t('admin.saved');
    await load();
  });
const test = () =>
  wrap(async () => {
    const r = await api<{ ok: boolean; message?: string }>('POST', '/admin/syslog/test', body());
    result.value = r.ok ? t('syslog.ok') : `${t('syslog.fail')}: ${r.message ?? ''}`;
  });
</script>

<template>
  <div class="space-y-4" data-testid="syslog-settings">
    <p class="text-sm text-slate-500">{{ t('syslog.hint') }}</p>
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
    <form class="card max-w-xl space-y-3 p-4 text-sm" @submit.prevent="save">
      <label class="flex items-center gap-2"
        ><input v-model="form.enabled" type="checkbox" data-testid="syslog-enabled" />
        {{ t('syslog.enabled') }}</label
      >
      <div class="flex gap-3">
        <label class="flex-1"
          >{{ t('syslog.host')
          }}<input v-model="form.host" required class="input font-mono" data-testid="syslog-host"
        /></label>
        <label class="w-28"
          >{{ t('sys.smtp.port')
          }}<input
            v-model.number="form.port"
            type="number"
            min="1"
            max="65535"
            required
            class="input"
            data-testid="syslog-port"
        /></label>
      </div>
      <label class="block"
        >{{ t('syslog.protocol') }}
        <select v-model="form.protocol" class="input" data-testid="syslog-protocol">
          <option value="udp">UDP</option>
          <option value="tcp">TCP</option>
          <option value="tls">TLS</option>
        </select>
      </label>
      <label v-if="form.protocol === 'tls'" class="flex items-center gap-2"
        ><input v-model="form.insecureTls" type="checkbox" /> {{ t('ldap.insecureTls') }}</label
      >
      <label class="block"
        >{{ t('syslog.prefixes')
        }}<input v-model="form.prefixes" class="input" placeholder="auth., admin."
      /></label>
      <div class="flex gap-2">
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="syslog-save">
          {{ t('common.save') }}
        </button>
        <button type="button" class="btn" :disabled="busy" data-testid="syslog-test" @click="test">
          {{ t('syslog.test') }}
        </button>
      </div>
      <p v-if="result" data-testid="syslog-result">{{ result }}</p>
    </form>
    <div v-if="status" class="card max-w-xl p-4 text-sm" data-testid="syslog-status">
      {{ t('syslog.sent') }}: {{ status.sent }} · {{ t('syslog.failed') }}: {{ status.failed }}
      <span v-if="status.lastError" class="block text-xs text-red-600">{{ status.lastError }}</span>
    </div>
  </div>
</template>
