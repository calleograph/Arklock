<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, when } from '../services/helpers';
import { useWorkspaceStore } from '../stores/workspace';

const props = withDefaults(
  defineProps<{
    vaultId: string;
    entryId: string;
    active: boolean;
    targetType?: 'entry' | 'branch';
  }>(),
  { targetType: 'entry' },
);
const base = computed(
  () =>
    `/vaults/${props.vaultId}/${props.targetType === 'branch' ? 'branches' : 'entries'}/${props.entryId}`,
);
const emit = defineEmits<{ (e: 'changed'): void }>();
const { t } = useI18n();
const ws = useWorkspaceStore();
interface Grant {
  id: string;
  targetType: string;
  targetId: string;
  subjectType: string;
  subjectId: string;
  subjectName: string;
  role: string;
  expiresAt: string | null;
  inherited: boolean;
  expired: boolean;
}
interface Access {
  canManage: boolean;
  effectiveAccess: string;
  grants: Grant[];
  members: {
    userId: string;
    displayName: string;
    email: string;
    access: string | null;
    source: string;
    sources: string[];
    hasKey: boolean;
    pendingKey: boolean;
  }[];
}
const data = ref<Access | null>(null);
const error = ref('');
const busy = ref(false);
const query = ref('');
const users = ref<{ id: string; name: string; email: string }[]>([]);
const circles = ref<{ id: string; name: string }[]>([]);
const form = ref({ subjectType: 'user', subjectId: '', role: 'reader', expiresAt: '' });
const roles = ['reader', 'editor', 'manager', 'none'];
const subjects = computed(() =>
  form.value.subjectType === 'user'
    ? users.value.map((u) => ({ id: u.id, label: `${u.name} <${u.email}>` }))
    : circles.value.map((c) => ({ id: c.id, label: c.name })),
);
watch(
  () => form.value.subjectType,
  () => {
    form.value.subjectId = '';
  },
);
async function load(): Promise<void> {
  error.value = '';
  try {
    data.value = await api('GET', `${base.value}/access`);
    if (data.value?.canManage && !circles.value.length)
      circles.value = await api('GET', '/directory/circles');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
watch(
  () => props.active,
  (active) => {
    if (active) void load();
  },
  { immediate: true },
);
async function search(): Promise<void> {
  if (query.value.trim().length < 2) return;
  busy.value = true;
  error.value = '';
  try {
    users.value = await api('GET', `/directory/users?q=${encodeURIComponent(query.value.trim())}`);
    form.value.subjectId = '';
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
async function mutate(operation: () => Promise<unknown>): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await operation();
    await load();
    emit('changed');
    if (ws.vaults.find((v) => v.id === props.vaultId)?.canManageMembers)
      await ws.distributePending(props.vaultId);
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
function putGrant(grant: {
  subjectType: string;
  subjectId: string;
  role: string;
  expiresAt: string | null;
}): Promise<unknown> {
  return api('PUT', `/vaults/${props.vaultId}/grants`, {
    targetType: props.targetType,
    targetId: props.entryId,
    ...grant,
  });
}
function add(): void {
  void mutate(() =>
    putGrant({
      ...form.value,
      expiresAt: form.value.expiresAt ? new Date(form.value.expiresAt).toISOString() : null,
    }),
  );
}
function change(grant: Grant, event: Event): void {
  const role = (event.target as HTMLSelectElement).value;
  void mutate(() =>
    putGrant({
      subjectType: grant.subjectType,
      subjectId: grant.subjectId,
      role,
      expiresAt: grant.expiresAt,
    }),
  );
}
function revoke(grant: Grant): void {
  if (window.confirm(t('entryPanel.confirmRevoke', { name: grant.subjectName })))
    void mutate(() => api('DELETE', `/vaults/${props.vaultId}/grants/${grant.id}`));
}
function sourceLabel(source: string): string {
  const [kind, id] = source.split(':');
  if (kind === 'member') return t('entryPanel.scopes.vault');
  if (kind === 'group') return `${t('entryPanel.group')}: ${source.slice(6)}`;
  if (kind === 'branch')
    return `${t('entryPanel.scopes.branch')}: ${ws.branches.find((b) => b.id === id)?.name ?? t('entryPanel.inherited')}`;
  return t('entryPanel.direct');
}
</script>

<template>
  <div class="space-y-4 text-sm" data-testid="entry-access">
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
    <p v-if="!data && !error" class="text-slate-500">{{ t('common.working') }}</p>
    <template v-if="data">
      <p class="text-slate-500">
        {{ t('entryPanel.yourAccess') }}:
        <strong>{{ t(`entryPanel.roles.${data.effectiveAccess}`) }}</strong>
      </p>
      <p
        class="rounded-md bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"
      >
        {{ t('entryPanel.cryptoNotice') }}
      </p>
      <section class="space-y-2">
        <h3 class="font-medium">{{ t('entryPanel.actualAccess') }}</h3>
        <ul class="divide-y divide-slate-200 dark:divide-slate-800">
          <li
            v-for="member in data.members"
            :key="member.userId"
            class="flex flex-wrap justify-between gap-2 py-2"
            data-testid="entry-access-member"
          >
            <span class="min-w-0 break-all"
              >{{ member.displayName }}
              <span class="text-xs text-slate-500"
                >{{ member.email }} · {{ member.sources.map(sourceLabel).join(', ') }}</span
              ></span
            >
            <span
              >{{ t(`entryPanel.roles.${member.access ?? 'none'}`) }} ·
              <span class="text-xs text-slate-500">{{
                !member.access || member.access === 'none'
                  ? t('entryPanel.denied')
                  : member.hasKey
                    ? t('entryPanel.keyReady')
                    : t('entryPanel.keyPending')
              }}</span></span
            >
          </li>
        </ul>
      </section>
      <section class="space-y-2">
        <h3 class="font-medium">{{ t('entryPanel.rules') }}</h3>
        <p class="text-xs text-slate-500">{{ t('entryPanel.inheritanceHint') }}</p>
        <p v-if="!data.grants.length" class="text-slate-500">{{ t('entryPanel.noRules') }}</p>
        <ul class="space-y-2">
          <li
            v-for="grant in data.grants"
            :key="grant.id"
            class="rounded-md border border-slate-200 p-2 dark:border-slate-800"
            data-testid="entry-access-grant"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="break-all"
                >{{ grant.subjectName }}
                <span class="badge">{{
                  t(
                    grant.inherited
                      ? 'entryPanel.inherited'
                      : targetType === 'branch'
                        ? 'entryPanel.directFolder'
                        : 'entryPanel.direct',
                  )
                }}</span></span
              >
              <span class="flex items-center gap-2">
                <span v-if="grant.expired" class="badge">{{ t('entryPanel.expired') }}</span>
                <select
                  v-if="data.canManage && !grant.inherited"
                  class="input w-auto"
                  :value="grant.role"
                  :disabled="busy"
                  :aria-label="t('entryPanel.permission')"
                  @change="change(grant, $event)"
                >
                  <option v-for="role in roles" :key="role" :value="role">
                    {{ t(`entryPanel.roles.${role}`) }}
                  </option>
                </select>
                <span v-else>{{ t(`entryPanel.roles.${grant.role}`) }}</span>
                <button
                  v-if="data.canManage && !grant.inherited"
                  class="btn"
                  type="button"
                  :disabled="busy"
                  @click="revoke(grant)"
                >
                  {{ t('entryPanel.revoke') }}
                </button>
              </span>
            </div>
            <p v-if="grant.expiresAt" class="mt-1 text-xs text-slate-500">
              {{ t('entryPanel.until') }} {{ when(grant.expiresAt) }}
            </p>
          </li>
        </ul>
      </section>
      <form
        v-if="data.canManage"
        class="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800"
        data-testid="entry-grant-form"
        @submit.prevent="add"
      >
        <h3 class="font-medium">
          {{ t(targetType === 'branch' ? 'entryPanel.assignFolder' : 'entryPanel.assign') }}
        </h3>
        <label class="block"
          ><span class="mb-1 block text-xs">{{ t('entryPanel.subjectType') }}</span>
          <select v-model="form.subjectType" class="input">
            <option value="user">{{ t('entryPanel.user') }}</option>
            <option value="circle">{{ t('entryPanel.group') }}</option>
          </select>
        </label>
        <div v-if="form.subjectType === 'user'" class="flex gap-2">
          <input
            v-model="query"
            class="input"
            minlength="2"
            :aria-label="t('entryPanel.findUser')"
            :placeholder="t('entryPanel.findUser')"
            @keydown.enter.prevent="search"
          />
          <button
            type="button"
            class="btn"
            :disabled="busy || query.trim().length < 2"
            @click="search"
          >
            {{ t('entryPanel.search') }}
          </button>
        </div>
        <label class="block"
          ><span class="mb-1 block text-xs">{{ t('entryPanel.subject') }}</span>
          <select v-model="form.subjectId" required class="input">
            <option value="">—</option>
            <option v-for="subject in subjects" :key="subject.id" :value="subject.id">
              {{ subject.label }}
            </option>
          </select>
        </label>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label class="block"
            ><span class="mb-1 flex items-center gap-1 text-xs"
              >{{ t('entryPanel.permission')
              }}<InfoHint
                :text="t('hint.accessLevels.text')"
                :details="t('hint.accessLevels.details')" /></span
            ><select v-model="form.role" class="input">
              <option v-for="role in roles" :key="role" :value="role">
                {{ t(`entryPanel.roles.${role}`) }}
              </option>
            </select></label
          >
          <label class="block"
            ><span class="mb-1 block text-xs">{{ t('entryPanel.untilOptional') }}</span
            ><input v-model="form.expiresAt" type="datetime-local" class="input"
          /></label>
        </div>
        <button type="submit" class="btn-primary" :disabled="busy || !form.subjectId">
          {{ t('common.save') }}
        </button>
      </form>
    </template>
  </div>
</template>
