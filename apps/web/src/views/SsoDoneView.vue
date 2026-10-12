<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import { takeVerifier } from '../services/ssoBinding';

/** Возврат от провайдера SSO. Результат пришёл во фрагменте адреса (в журналы сервера он не попадает) и сразу стирается из адресной строки. */
const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const error = ref('');
const KNOWN_ERRORS = [
  'state',
  'jwt',
  'claims',
  'token',
  'discovery',
  'denied',
  'account_exists',
  'not_provisioned',
  'disabled',
  // SAML
  'signature',
  'expired',
  'audience',
  'issuer',
  'in_response_to',
  'weak_algorithm',
  'replay',
  'domain',
  'not_in_group',
  'idp_status',
  'idp_authn_failed',
  'idp_denied',
  'idp_cert_expired',
  'invalid_response',
  'decrypt',
  'too_many_attempts',
  'sso_disabled',
  'sso_unavailable',
];

onMounted(async () => {
  const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
  history.replaceState(null, '', location.pathname);
  const code = frag.get('error');
  const ticket = frag.get('ticket');
  if (code || !ticket) {
    error.value = t(`sso.error.${code && KNOWN_ERRORS.includes(code) ? code : 'other'}`);
    return;
  }
  try {
    const next = await auth.exchangeSso(ticket, takeVerifier());
    if (next === 'unlock') await router.replace('/unlock');
    else await router.replace({ path: '/login', query: { external: next } });
  } catch {
    error.value = t('sso.error.other');
  }
});
</script>

<template>
  <section class="mx-auto max-w-md space-y-4">
    <h1 class="text-xl font-semibold">{{ t('sso.title') }}</h1>
    <p v-if="!error" class="text-sm text-slate-500">{{ t('common.working') }}</p>
    <template v-else>
      <p
        class="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        role="alert"
        data-testid="sso-error"
      >
        {{ error }}
      </p>
      <RouterLink to="/login" class="text-sm underline" data-testid="sso-back">{{
        t('sso.back')
      }}</RouterLink>
    </template>
  </section>
</template>
