<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { email } from '@arklock/contracts';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../services/api';
import { errorMessage, when } from '../services/helpers';

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
const created = ref<{ code: string; emailed: boolean } | null>(null);
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
    created.value = r;
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
const copy = () => navigator.clipboard.writeText(created.value?.code ?? '').catch(() => undefined);
const fmt = (s: string) => when(s);
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
      <h2 class="text-base font-semibold">{{ t('invite.newUser') }}</h2>
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
      <div class="flex flex-wrap items-center gap-3">
        <label
          >{{ t('invite.days') }}
          <input v-model.number="form.days" type="number" min="1" max="60" class="input w-20"
        /></label>
        <label class="flex items-center gap-2"
          ><input
            v-model="form.sendEmail"
            type="checkbox"
            :disabled="!canEmail"
            data-testid="invite-send"
          />
          {{ t('invite.send') }}</label
        >
      </div>
      <fieldset v-if="circles.length" class="space-y-1">
        <legend class="text-xs text-slate-500">{{ t('invite.circles') }}</legend>
        <!-- при десятках групп (по числу подразделений) нужен отбор, а выбранные остаются на виду -->
        <input
          v-if="circles.length > 6"
          v-model="circleFilter"
          type="search"
          class="input max-w-xs"
          :placeholder="t('invite.circleFilter')"
          data-testid="invite-circle-filter"
        />
        <div class="flex max-h-28 flex-wrap gap-x-3 gap-y-1 overflow-y-auto">
          <label
            v-for="c in shownCircles"
            :key="c.id"
            class="inline-flex items-center gap-1"
            :data-testid="`invite-circle-${c.name}`"
          >
            <input v-model="form.circleIds" type="checkbox" :value="c.id" /> {{ c.name }}
          </label>
        </div>
      </fieldset>
      <button type="submit" class="btn-primary" :disabled="busy" data-testid="invite-create">
        {{ t('invite.createAction') }}
      </button>
    </form>

    <div v-if="created" class="card max-w-xl space-y-2 p-4 text-sm" data-testid="invite-created">
      <p>{{ t('invite.codeShown') }}</p>
      <code class="block break-all text-base tracking-wider" data-testid="invite-code">{{
        created.code
      }}</code>
      <p v-if="created.emailed" class="text-emerald-700">{{ t('invite.emailed') }}</p>
      <button type="button" class="btn" @click="copy">{{ t('common.copy') }}</button>
    </div>

    <div class="card overflow-x-auto">
      <table class="min-w-full text-sm" data-testid="invite-table">
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
            <td class="px-3 py-2">{{ i.displayName ?? '—' }}</td>
            <td>{{ i.email }}</td>
            <td>{{ i.role === 'admin' ? t('invite.roleAdmin') : t('invite.roleMember') }}</td>
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
