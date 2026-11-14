<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { email } from '@arklock/contracts';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { errorMessage, when } from '../services/helpers';
import BulkInvitations from './BulkInvitations.vue';
import DirectoryInvite from './DirectoryInvite.vue';

const { t } = useI18n();

interface Inv {
  id: string;
  email: string;
  displayName: string | null;
  role: 'admin' | 'member';
  status: 'pending' | 'used' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
}
const list = ref<Inv[]>([]);
const circles = ref<{ id: string; name: string }[]>([]);
const empty = () => ({
  name: '',
  email: '',
  role: 'member' as 'admin' | 'member',
  days: 7,
  sendEmail: false,
  circleIds: [] as string[],
});
const form = ref(empty());
const circleFilter = ref('');
const shownCircles = computed(() => {
  const q = circleFilter.value.trim().toLowerCase();
  return circles.value.filter(
    (c) => form.value.circleIds.includes(c.id) || !q || c.name.toLowerCase().includes(q),
  );
});
const canEmail = computed(() => email.safeParse(form.value.email).success);
watch(canEmail, (allowed) => {
  if (!allowed) form.value.sendEmail = false;
});
/** Код активации показывается один раз — сразу после создания учётной записи. */
const created = ref<{
  code: string;
  emailed: boolean;
  name: string;
  login: string;
  until: string;
} | null>(null);
const copied = ref('');
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
    const r = await api<{ code: string; emailed: boolean }>('POST', '/admin/invitations', {
      email: form.value.email.trim(),
      displayName: form.value.name.trim(),
      role: form.value.role,
      expiresInDays: Number(form.value.days),
      sendEmail: form.value.sendEmail,
      circleIds: form.value.circleIds,
    });
    created.value = {
      ...r,
      name: form.value.name.trim(),
      login: form.value.email.trim(),
      until: when(new Date(Date.now() + Number(form.value.days) * 86_400_000).toISOString()),
    };
    form.value = empty();
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
// готовый текст для сотрудника: адрес, что нажать, логин и код — администратору не нужно объяснять своими словами
const message = computed(() =>
  created.value
    ? t('invite.message', {
        name: created.value.name,
        url: window.location.origin,
        login: created.value.login,
        code: created.value.code,
        until: created.value.until,
      })
    : '',
);
function copy(what: 'code' | 'message'): void {
  const text = what === 'code' ? (created.value?.code ?? '') : message.value;
  navigator.clipboard
    .writeText(text)
    .then(() => (copied.value = what))
    .catch(() => undefined);
}
const fmt = (s: string) => when(s);
</script>

<template>
  <div class="space-y-4" data-testid="invitations-panel">
    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
      role="alert"
      data-testid="invite-error"
    >
      {{ error }}
    </p>

    <DirectoryInvite />

    <BulkInvitations :circles="circles" @created="load" />

    <form class="card form-grid p-4 text-sm" @submit.prevent="create">
      <h2 class="font-medium">{{ t('invite.newUser') }}</h2>
      <label class="block"
        >{{ t('invite.name')
        }}<input
          v-model="form.name"
          type="text"
          required
          maxlength="100"
          class="input"
          data-testid="invite-name"
      /></label>
      <label class="block"
        >{{ t('corporate.accountIdentifier')
        }}<input
          v-model="form.email"
          type="text"
          required
          autocapitalize="none"
          spellcheck="false"
          maxlength="254"
          class="input"
          data-testid="invite-email"
      /></label>
      <label class="block"
        >{{ t('invite.role')
        }}<select v-model="form.role" class="input" data-testid="invite-role">
          <option value="member">{{ t('invite.roleMember') }}</option>
          <option value="admin">{{ t('invite.roleAdmin') }}</option>
        </select></label
      >
      <label class="block"
        >{{ t('invite.days') }}
        <input v-model.number="form.days" type="number" min="1" max="60" class="input"
      /></label>
      <label class="check-row"
        ><input
          v-model="form.sendEmail"
          type="checkbox"
          :disabled="!canEmail"
          data-testid="invite-send"
        />
        <span class="check-text">{{ t('invite.send') }}</span></label
      >
      <fieldset v-if="circles.length" class="space-y-2">
        <legend class="mb-1 text-xs font-medium text-slate-600 dark:text-slate-300">
          {{ t('invite.circles') }}
        </legend>
        <!-- при десятках групп (по числу подразделений) нужен отбор, а выбранные остаются на виду -->
        <input
          v-if="circles.length > 6"
          v-model="circleFilter"
          type="search"
          class="input"
          :placeholder="t('invite.circleFilter')"
          data-testid="invite-circle-filter"
        />
        <div class="grid max-h-36 gap-x-6 gap-y-1 overflow-y-auto sm:grid-cols-2">
          <label
            v-for="c in shownCircles"
            :key="c.id"
            class="check-row"
            :data-testid="`invite-circle-${c.name}`"
          >
            <input v-model="form.circleIds" type="checkbox" :value="c.id" /><span
              class="check-text"
              >{{ c.name }}</span
            >
          </label>
        </div>
      </fieldset>
      <div class="btn-row">
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="invite-create">
          {{ t('invite.createAction') }}
        </button>
      </div>
    </form>

    <div v-if="created" class="card space-y-3 p-4 text-sm" data-testid="invite-created">
      <p>{{ t('invite.codeShown') }}</p>
      <code class="block break-all text-base tracking-wider" data-testid="invite-code">{{
        created.code
      }}</code>
      <p v-if="created.emailed" class="text-emerald-700">{{ t('invite.emailed') }}</p>
      <label class="block">
        <span class="field-label">{{ t('invite.messageLabel') }}</span>
        <textarea
          :value="message"
          readonly
          rows="7"
          class="input font-sans"
          data-testid="invite-message"
        />
      </label>
      <div class="btn-row">
        <button
          type="button"
          class="btn-primary"
          data-testid="invite-copy-message"
          @click="copy('message')"
        >
          {{ copied === 'message' ? t('invite.copied') : t('invite.copyMessage') }}
        </button>
        <button type="button" class="btn" data-testid="invite-copy-code" @click="copy('code')">
          {{ copied === 'code' ? t('invite.copied') : t('invite.copyCode') }}
        </button>
      </div>
    </div>

    <div class="card overflow-x-auto">
      <table class="table-cards min-w-full text-sm" data-testid="invite-table">
        <thead class="text-left text-xs text-slate-500">
          <tr>
            <th class="px-3 py-2">{{ t('invite.name') }}</th>
            <th>{{ t('corporate.accountIdentifier') }}</th>
            <th>{{ t('invite.role') }}</th>
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
            <td class="cell-main px-3 py-2">
              <span class="font-medium">{{ i.displayName ?? '—' }}</span>
              <span class="block text-xs text-slate-500 md:hidden">{{ i.email }}</span>
            </td>
            <td class="max-md:!hidden">{{ i.email }}</td>
            <td :data-label="t('invite.role')">
              {{ i.role === 'admin' ? t('invite.roleAdmin') : t('invite.roleMember') }}
            </td>
            <td :data-label="t('invite.status')">{{ t(`invite.st.${i.status}`) }}</td>
            <td class="text-xs" :data-label="t('invite.expires')">{{ fmt(i.expiresAt) }}</td>
            <td class="px-3 text-right">
              <button
                v-if="i.status === 'pending'"
                type="button"
                class="btn"
                data-testid="invite-revoke"
                @click="revoke(i.id)"
              >
                {{ t('invite.revokeInvite') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!list.length" class="p-3 text-sm text-slate-500">{{ t('invite.none') }}</p>
    </div>
  </div>
</template>
