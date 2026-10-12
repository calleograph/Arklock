<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { errorMessage } from '../services/helpers';

const { t } = useI18n();

interface Inv {
  id: string;
  email: string;
  status: 'pending' | 'used' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
}
const list = ref<Inv[]>([]);
const circles = ref<{ id: string; name: string }[]>([]);
const form = ref({ email: '', days: 7, sendEmail: false, circleIds: [] as string[] });
const created = ref<{ link: string; emailed: boolean } | null>(null);
const error = ref('');
const busy = ref(false);

async function load(): Promise<void> {
  circles.value = await api('GET', '/admin/circles');
  list.value = await api('GET', '/admin/invitations');
}
onMounted(() => load().catch((e) => (error.value = errorMessage(e, t))));

async function create(): Promise<void> {
  error.value = '';
  created.value = null;
  busy.value = true;
  try {
    const r = await api<{ link: string; emailed: boolean }>('POST', '/admin/invitations', {
      email: form.value.email.trim(),
      expiresInDays: Number(form.value.days),
      sendEmail: form.value.sendEmail,
      circleIds: form.value.circleIds,
    });
    created.value = r;
    form.value = { ...form.value, email: '' };
    await load();
  } catch (e) {
    error.value =
      e instanceof ApiError && e.code === 'already_exists'
        ? t('invite.exists')
        : errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

async function revoke(id: string): Promise<void> {
  await api('DELETE', `/admin/invitations/${id}`);
  await load();
}
const copy = () => navigator.clipboard.writeText(created.value?.link ?? '').catch(() => undefined);
const fmt = (s: string) => new Date(s).toLocaleString();
</script>

<template>
  <div class="space-y-4" data-testid="invitations-panel">
    <p class="text-sm text-slate-500">{{ t('invite.hint') }}</p>
    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
      role="alert"
      data-testid="invite-error"
    >
      {{ error }}
    </p>

    <form class="card max-w-xl space-y-3 p-4 text-sm" @submit.prevent="create">
      <label class="block"
        >{{ t('common.email')
        }}<input
          v-model="form.email"
          type="email"
          required
          class="input"
          data-testid="invite-email"
      /></label>
      <div class="flex flex-wrap items-center gap-3">
        <label
          >{{ t('invite.days') }}
          <input v-model.number="form.days" type="number" min="1" max="60" class="input w-20"
        /></label>
        <label class="flex items-center gap-2"
          ><input v-model="form.sendEmail" type="checkbox" data-testid="invite-send" />
          {{ t('invite.send') }}</label
        >
      </div>
      <fieldset v-if="circles.length" class="space-y-1">
        <legend class="text-xs text-slate-500">{{ t('invite.circles') }}</legend>
        <label v-for="c in circles" :key="c.id" class="mr-3 inline-flex items-center gap-1">
          <input v-model="form.circleIds" type="checkbox" :value="c.id" /> {{ c.name }}
        </label>
      </fieldset>
      <button type="submit" class="btn-primary" :disabled="busy" data-testid="invite-create">
        {{ t('invite.create') }}
      </button>
    </form>

    <div v-if="created" class="card max-w-xl space-y-2 p-4 text-sm" data-testid="invite-created">
      <p>{{ t('invite.shownOnce') }}</p>
      <code class="block break-all" data-testid="invite-link">{{ created.link }}</code>
      <p v-if="created.emailed" class="text-emerald-700">{{ t('invite.emailed') }}</p>
      <button type="button" class="btn" @click="copy">{{ t('common.copy') }}</button>
    </div>

    <div class="card overflow-x-auto">
      <table class="min-w-full text-sm" data-testid="invite-table">
        <thead class="text-left text-xs text-slate-500">
          <tr>
            <th class="px-3 py-2">{{ t('common.email') }}</th>
            <th>{{ t('invite.status') }}</th>
            <th>{{ t('invite.expires') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="i in list"
            :key="i.id"
            class="border-t border-slate-200 dark:border-slate-800"
            data-testid="invite-row"
          >
            <td class="px-3 py-2">{{ i.email }}</td>
            <td>{{ t(`invite.st.${i.status}`) }}</td>
            <td class="text-xs">{{ fmt(i.expiresAt) }}</td>
            <td class="px-3 text-right">
              <button
                v-if="i.status === 'pending'"
                type="button"
                class="btn"
                data-testid="invite-revoke"
                @click="revoke(i.id)"
              >
                {{ t('security.revoke') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!list.length" class="p-3 text-sm text-slate-500">{{ t('invite.none') }}</p>
    </div>
  </div>
</template>
