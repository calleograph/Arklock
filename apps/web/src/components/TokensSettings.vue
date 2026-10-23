<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ApiTokenInfo } from '@arklock/contracts';
import { api, ApiError } from '../services/api';
import { authKeyFor } from '../services/account';
import { errorMessage, when } from '../services/helpers';
import { useAuthStore } from '../stores/auth';

const { t } = useI18n();
const auth = useAuthStore();

const tokens = ref<ApiTokenInfo[]>([]);
const form = ref({ name: '', scope: 'read' as 'read' | 'write', days: 90, password: '', code: '' });
const created = ref('');
const error = ref('');
const busy = ref(false);
const mfaOn = ref(false);

async function load(): Promise<void> {
  tokens.value = await api('GET', '/auth/tokens');
  mfaOn.value = (await api<{ enabled: boolean }>('GET', '/auth/mfa')).enabled;
}
onMounted(() => load().catch((e) => (error.value = errorMessage(e, t))));

async function create(): Promise<void> {
  if (!auth.user) return;
  error.value = '';
  busy.value = true;
  try {
    const res = await api<{ token: string }>('POST', '/auth/tokens', {
      name: form.value.name.trim(),
      scope: form.value.scope,
      expiresInDays: Number(form.value.days),
      authKey: await authKeyFor(auth.user, form.value.password),
      code: form.value.code.trim() || undefined,
    });
    created.value = res.token;
    form.value = { name: '', scope: 'read', days: 90, password: '', code: '' };
    await load();
  } catch (e) {
    error.value =
      e instanceof ApiError && e.code === 'invalid_credentials'
        ? t('security.wrongPassword')
        : e instanceof ApiError && e.code === 'invalid_code'
          ? t('mfa.invalidCode')
          : errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

async function revoke(id: string): Promise<void> {
  await api('DELETE', `/auth/tokens/${id}`);
  await load();
}
const fmt = (s: string | null) => (s ? when(s) : '—');
</script>

<template>
  <div class="max-w-xl space-y-3" data-testid="tokens-section">
    <h2 class="font-medium">{{ t('tokens.title') }}</h2>
    <p class="text-sm text-slate-500">{{ t('tokens.hint') }}</p>

    <div
      v-if="created"
      class="space-y-2 rounded-md border border-slate-300 p-3 text-sm dark:border-slate-700"
    >
      <p>{{ t('tokens.shownOnce') }}</p>
      <code class="block break-all font-mono" data-testid="token-value">{{ created }}</code>
      <button type="button" class="btn" data-testid="token-saved" @click="created = ''">
        {{ t('mfa.saved') }}
      </button>
    </div>

    <ul
      v-if="tokens.length"
      class="divide-y divide-slate-200 rounded-lg border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800"
      data-testid="token-list"
    >
      <li v-for="k in tokens" :key="k.id" class="flex items-center justify-between gap-3 px-3 py-2">
        <div class="min-w-0">
          <div class="truncate">
            {{ k.name }} <span class="font-mono text-xs text-slate-500">{{ k.prefix }}…</span>
            <span class="ml-1 rounded bg-slate-100 px-1.5 text-xs dark:bg-slate-800">{{
              k.scope === 'read' ? t('tokens.read') : t('tokens.write')
            }}</span>
          </div>
          <div class="text-xs text-slate-500">
            {{ t('tokens.expires') }}: {{ k.expiresAt ? fmt(k.expiresAt) : t('tokens.never') }} ·
            {{ t('tokens.lastUsed') }}: {{ fmt(k.lastUsedAt) }}
          </div>
        </div>
        <button
          type="button"
          class="btn"
          :data-testid="`token-revoke-${k.name}`"
          @click="revoke(k.id)"
        >
          {{ t('security.revoke') }}
        </button>
      </li>
    </ul>

    <form class="space-y-2" @submit.prevent="create">
      <input
        v-model="form.name"
        required
        maxlength="100"
        class="field"
        :placeholder="t('tokens.name')"
        data-testid="token-name"
      />
      <div class="flex flex-wrap gap-2">
        <select v-model="form.scope" class="field w-auto" data-testid="token-scope">
          <option value="read">{{ t('tokens.read') }}</option>
          <option value="write">{{ t('tokens.write') }}</option>
        </select>
        <label class="flex items-center gap-1 text-sm"
          >{{ t('tokens.days') }}
          <input v-model.number="form.days" type="number" min="0" max="3650" class="field w-24"
        /></label>
      </div>
      <input
        v-model="form.password"
        type="password"
        required
        autocomplete="current-password"
        class="field"
        :placeholder="t('common.password')"
        data-testid="token-password"
      />
      <input
        v-if="mfaOn"
        v-model="form.code"
        required
        autocomplete="one-time-code"
        class="field font-mono"
        :placeholder="t('mfa.code')"
        data-testid="token-code"
      />
      <button type="submit" class="btn-primary" :disabled="busy" data-testid="token-create">
        {{ t('tokens.create') }}
      </button>
    </form>
    <p v-if="error" class="text-sm text-red-600" role="alert" data-testid="token-error">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.field {
  width: 100%;
  border-radius: 0.375rem;
  border: 1px solid rgb(203 213 225);
  background: transparent;
  padding: 0.4rem 0.6rem;
}
:global(html.dark) .field {
  border-color: rgb(51 65 85);
}
</style>
