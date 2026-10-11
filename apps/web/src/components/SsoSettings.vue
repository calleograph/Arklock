<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';

const { t } = useI18n();

const form = ref({
  enabled: false,
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid email profile',
  emailClaim: 'email',
  nameClaim: 'name',
  buttonText: 'SSO',
  domains: '',
  allowInsecure: false,
  autoProvision: true,
});
const hasSecret = ref(false);
const redirectUri = ref<string | null>(null);
const error = ref('');
const notice = ref('');
const result = ref('');
const busy = ref(false);

async function load(): Promise<void> {
  const r = await api<Record<string, unknown>>('GET', '/admin/sso');
  redirectUri.value = (r.redirectUri as string | null) ?? null;
  if (r.configured) {
    form.value = {
      ...form.value,
      enabled: r.enabled === true,
      issuer: String(r.issuer ?? ''),
      clientId: String(r.clientId ?? ''),
      scopes: String(r.scopes ?? form.value.scopes),
      emailClaim: String(r.emailClaim ?? 'email'),
      nameClaim: String(r.nameClaim ?? 'name'),
      buttonText: String(r.buttonText ?? 'SSO'),
      domains: ((r.allowedDomains as string[]) ?? []).join(', '),
      allowInsecure: r.allowInsecure === true,
      autoProvision: r.autoProvision !== false,
      clientSecret: '',
    };
    hasSecret.value = r.hasClientSecret === true;
  }
}
onMounted(() => load().catch((e) => (error.value = errorMessage(e, t))));

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
    const f = form.value;
    await api('PUT', '/admin/sso', {
      enabled: f.enabled,
      issuer: f.issuer,
      clientId: f.clientId,
      clientSecret: f.clientSecret === '' ? undefined : f.clientSecret,
      scopes: f.scopes,
      emailClaim: f.emailClaim,
      nameClaim: f.nameClaim,
      buttonText: f.buttonText,
      allowedDomains: f.domains
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      allowInsecure: f.allowInsecure,
      autoProvision: f.autoProvision,
    });
    notice.value = t('admin.saved');
    await load();
  });

const test = () =>
  wrap(async () => {
    const r = await api<{ ok: boolean; message?: string }>('POST', '/admin/sso/test');
    result.value = r.ok ? t('sso.ok') : `${t('sso.fail')}: ${r.message ?? ''}`;
  });
</script>

<template>
  <div class="space-y-4" data-testid="sso-settings">
    <p class="text-sm text-slate-500">{{ t('sso.hint') }}</p>
    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
      role="alert"
      data-testid="sso-admin-error"
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

    <div class="card max-w-2xl space-y-1 p-4 text-sm">
      <div class="text-xs text-slate-500">{{ t('sso.redirectUri') }}</div>
      <code v-if="redirectUri" class="break-all" data-testid="sso-redirect">{{ redirectUri }}</code>
      <p v-else class="text-amber-700">{{ t('sso.redirectMissing') }}</p>
    </div>

    <form class="card max-w-2xl space-y-3 p-4 text-sm" @submit.prevent="save">
      <label class="flex items-center gap-2"
        ><input v-model="form.enabled" type="checkbox" data-testid="sso-enabled" />
        {{ t('sso.enabled') }}</label
      >
      <label class="block"
        >{{ t('sso.issuer')
        }}<input v-model="form.issuer" required class="input font-mono" data-testid="sso-issuer"
      /></label>
      <label class="block"
        >{{ t('sso.clientId')
        }}<input v-model="form.clientId" required class="input font-mono" data-testid="sso-client"
      /></label>
      <label class="block"
        >{{ t('sso.clientSecret')
        }}<input
          v-model="form.clientSecret"
          type="password"
          autocomplete="new-password"
          class="input"
          :placeholder="hasSecret ? t('sys.smtp.keepPassword') : ''"
          data-testid="sso-secret"
      /></label>
      <label class="block"
        >{{ t('sso.scopes') }}<input v-model="form.scopes" class="input font-mono"
      /></label>
      <div class="flex gap-3">
        <label class="flex-1"
          >{{ t('sso.emailClaim') }}<input v-model="form.emailClaim" class="input"
        /></label>
        <label class="flex-1"
          >{{ t('sso.nameClaim') }}<input v-model="form.nameClaim" class="input"
        /></label>
      </div>
      <label class="block"
        >{{ t('sso.button')
        }}<input v-model="form.buttonText" class="input" data-testid="sso-button-text"
      /></label>
      <label class="block"
        >{{ t('sso.domains')
        }}<input v-model="form.domains" class="input" placeholder="example.com, corp.example.com"
      /></label>
      <label class="flex items-center gap-2"
        ><input v-model="form.autoProvision" type="checkbox" /> {{ t('sso.autoProvision') }}</label
      >
      <label class="flex items-center gap-2"
        ><input v-model="form.allowInsecure" type="checkbox" data-testid="sso-insecure" />
        {{ t('sso.allowInsecure') }}</label
      >
      <div class="flex gap-2">
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="sso-save">
          {{ t('common.save') }}
        </button>
        <button type="button" class="btn" :disabled="busy" data-testid="sso-test" @click="test">
          {{ t('sso.test') }}
        </button>
      </div>
      <p v-if="result" data-testid="sso-result">{{ result }}</p>
    </form>
  </div>
</template>
