<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { errorMessage } from '../services/helpers';

const { t } = useI18n();

interface Form {
  enabled: boolean;
  url: string;
  startTls: boolean;
  allowPlaintext: boolean;
  insecureTls: boolean;
  caPem: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  userFilter: string;
  emailAttr: string;
  nameAttr: string;
  autoProvision: boolean;
  groups: { dn: string; circleId: string }[];
}
const form = ref<Form>({
  enabled: false,
  url: 'ldaps://',
  startTls: false,
  allowPlaintext: false,
  insecureTls: false,
  caPem: '',
  bindDn: '',
  bindPassword: '',
  baseDn: '',
  userFilter:
    '(&(objectClass=person)(|(uid={u})(mail={u})(sAMAccountName={u})(userPrincipalName={u})))',
  emailAttr: 'mail',
  nameAttr: 'cn',
  autoProvision: true,
  groups: [],
});
const hasBindPassword = ref(false);
const circles = ref<{ id: string; name: string }[]>([]);
const error = ref('');
const notice = ref('');
const result = ref('');
const lookupName = ref('');
const lookupOut = ref<{
  found: boolean;
  user?: { dn: string; email: string; name: string; groups: string[] };
} | null>(null);
const busy = ref(false);

async function load(): Promise<void> {
  circles.value = await api('GET', '/admin/circles');
  const r = await api<Record<string, unknown>>('GET', '/admin/ldap');
  if (r.configured) {
    form.value = { ...form.value, ...(r as Partial<Form>), bindPassword: '' };
    hasBindPassword.value = r.hasBindPassword === true;
  }
}
onMounted(() => load().catch((e) => (error.value = errorMessage(e, t))));

function fail(e: unknown): void {
  error.value =
    e instanceof ApiError && e.code === 'insecure_ldap'
      ? t('ldap.allowPlaintext')
      : errorMessage(e, t);
}

async function wrap(fn: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  result.value = '';
  try {
    await fn();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

const save = () =>
  wrap(async () => {
    await api('PUT', '/admin/ldap', {
      ...form.value,
      bindPassword: form.value.bindPassword === '' ? undefined : form.value.bindPassword,
    });
    notice.value = t('admin.saved');
    await load();
  });

const test = () =>
  wrap(async () => {
    const r = await api<{ ok: boolean; message?: string }>('POST', '/admin/ldap/test');
    result.value = r.ok ? t('ldap.ok') : `${t('ldap.fail')}: ${r.message ?? ''}`;
  });

const lookup = () =>
  wrap(async () => {
    const r = await api<{ ok: boolean; found?: boolean; message?: string; user?: never }>(
      'POST',
      '/admin/ldap/lookup',
      { username: lookupName.value },
    );
    if (!r.ok) result.value = `${t('ldap.fail')}: ${r.message ?? ''}`;
    else lookupOut.value = { found: !!r.found, user: r.user };
  });

const sync = () =>
  wrap(async () => {
    const r = await api<{ total: number; disabled: number; updated: number; errors: string[] }>(
      'POST',
      '/admin/ldap/sync',
    );
    result.value = t('ldap.syncResult', r);
  });
</script>

<template>
  <div class="space-y-4" data-testid="ldap-settings">
    <p class="text-sm text-slate-500">{{ t('ldap.hint') }}</p>
    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
      role="alert"
      data-testid="ldap-error"
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      role="status"
    >
      {{ notice }}
    </p>

    <form class="card max-w-2xl space-y-3 p-4 text-sm" @submit.prevent="save">
      <label class="flex items-center gap-2"
        ><input v-model="form.enabled" type="checkbox" data-testid="ldap-enabled" />
        {{ t('ldap.enabled') }}</label
      >
      <label class="block"
        >{{ t('ldap.url')
        }}<input v-model="form.url" required class="input font-mono" data-testid="ldap-url"
      /></label>
      <div class="flex flex-wrap gap-4">
        <label class="flex items-center gap-2"
          ><input v-model="form.startTls" type="checkbox" /> {{ t('ldap.startTls') }}</label
        >
        <label class="flex items-center gap-2"
          ><input v-model="form.allowPlaintext" type="checkbox" data-testid="ldap-plaintext" />
          {{ t('ldap.allowPlaintext') }}</label
        >
        <label class="flex items-center gap-2"
          ><input v-model="form.insecureTls" type="checkbox" /> {{ t('ldap.insecureTls') }}</label
        >
      </div>
      <label class="block"
        >{{ t('ldap.ca')
        }}<textarea v-model="form.caPem" rows="3" class="input font-mono text-xs" />
      </label>
      <label class="block"
        >{{ t('ldap.bindDn')
        }}<input v-model="form.bindDn" class="input font-mono" data-testid="ldap-binddn"
      /></label>
      <label class="block"
        >{{ t('ldap.bindPassword')
        }}<input
          v-model="form.bindPassword"
          type="password"
          autocomplete="new-password"
          class="input"
          :placeholder="hasBindPassword ? t('sys.smtp.keepPassword') : ''"
          data-testid="ldap-bindpw"
      /></label>
      <label class="block"
        >{{ t('ldap.baseDn')
        }}<input v-model="form.baseDn" required class="input font-mono" data-testid="ldap-basedn"
      /></label>
      <label class="block"
        >{{ t('ldap.userFilter')
        }}<input v-model="form.userFilter" required class="input font-mono text-xs"
      /></label>
      <div class="flex gap-3">
        <label class="flex-1"
          >{{ t('ldap.emailAttr') }}<input v-model="form.emailAttr" class="input"
        /></label>
        <label class="flex-1"
          >{{ t('ldap.nameAttr') }}<input v-model="form.nameAttr" class="input"
        /></label>
      </div>
      <label class="flex items-center gap-2"
        ><input v-model="form.autoProvision" type="checkbox" /> {{ t('ldap.autoProvision') }}</label
      >

      <div class="space-y-2">
        <div class="font-medium">{{ t('ldap.groups') }}</div>
        <div v-for="(g, i) in form.groups" :key="i" class="flex gap-2">
          <input
            v-model="g.dn"
            class="input flex-1 font-mono text-xs"
            :placeholder="t('ldap.groupDn')"
          />
          <select v-model="g.circleId" class="input w-48">
            <option v-for="c in circles" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button type="button" class="btn" @click="form.groups.splice(i, 1)">✕</button>
        </div>
        <button
          type="button"
          class="btn"
          :disabled="!circles.length"
          data-testid="ldap-add-group"
          @click="form.groups.push({ dn: '', circleId: circles[0]!.id })"
        >
          {{ t('ldap.addGroup') }}
        </button>
      </div>
      <button type="submit" class="btn-primary" :disabled="busy" data-testid="ldap-save">
        {{ t('common.save') }}
      </button>
    </form>

    <div class="card max-w-2xl space-y-3 p-4 text-sm">
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn" :disabled="busy" data-testid="ldap-test" @click="test">
          {{ t('ldap.test') }}
        </button>
        <button type="button" class="btn" :disabled="busy" data-testid="ldap-sync" @click="sync">
          {{ t('ldap.sync') }}
        </button>
      </div>
      <form class="flex gap-2" @submit.prevent="lookup">
        <input
          v-model="lookupName"
          required
          class="input"
          :placeholder="t('ldap.lookupName')"
          data-testid="ldap-lookup-name"
        />
        <button type="submit" class="btn" :disabled="busy" data-testid="ldap-lookup">
          {{ t('ldap.lookup') }}
        </button>
      </form>
      <p v-if="result" data-testid="ldap-result">{{ result }}</p>
      <div v-if="lookupOut" data-testid="ldap-lookup-result">
        <p v-if="!lookupOut.found">{{ t('ldap.notFound') }}</p>
        <div v-else>
          <p>
            {{ t('ldap.found') }}: {{ lookupOut.user?.name }} &lt;{{ lookupOut.user?.email }}&gt;
          </p>
          <p class="break-all font-mono text-xs text-slate-500">{{ lookupOut.user?.dn }}</p>
          <ul class="font-mono text-xs">
            <li v-for="g in lookupOut.user?.groups" :key="g">{{ g }}</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
