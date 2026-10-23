<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, vaultLabel, when } from '../services/helpers';
import Icon from './Icon.vue';

/** Карточка сотрудника: статус, группы, сеансы и сейфы в одном месте — без перехода по разделам. */
const props = defineProps<{ userId: string; adminRoles: { id: string; name: string }[] }>();
const emit = defineEmits<{ close: []; offboard: []; changed: [] }>();
const { t } = useI18n();

interface Profile {
  user: {
    id: string;
    name: string;
    email: string;
    disabled: boolean;
    role: string;
    adminRoleId: string | null;
    authSource: string;
    createdAt: string;
  };
  groups: { id: string; name: string; adminRoleId: string | null }[];
  sessionList: { id: string; lastSeenAt: string; ip: string | null; userAgent: string | null }[];
  vaults: { id: string; name: string; role: string; entries: number }[];
  apiTokens: number;
  externalLinks: number;
}
const p = ref<Profile | null>(null);
const error = ref('');
const busy = ref(false);
const roleName = (id: string | null) => props.adminRoles.find((r) => r.id === id)?.name;

async function load(): Promise<void> {
  try {
    p.value = await api<Profile>('GET', `/admin/users/${props.userId}/profile`);
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(load);
async function endSessions(): Promise<void> {
  busy.value = true;
  try {
    await api('POST', `/admin/users/${props.userId}/revoke-sessions`);
    await load();
    emit('changed');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card my-3 space-y-4 p-4 text-sm" data-testid="user-profile">
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
    <p v-if="!p && !error" class="text-slate-500">{{ t('common.working') }}</p>
    <template v-if="p">
      <header class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <h2 class="break-words">{{ p.user.name }}</h2>
          <p class="break-all text-slate-500">{{ p.user.email }}</p>
          <div class="mt-1.5 flex flex-wrap gap-1">
            <span class="badge" :class="p.user.disabled ? 'text-red-700' : 'text-emerald-700'">{{
              p.user.disabled ? t('admin.disabled') : t('admin.active')
            }}</span>
            <span class="badge">{{
              p.user.role === 'admin' ? t('admin.roleAdmin') : t('admin.roleMember')
            }}</span>
            <span v-if="roleName(p.user.adminRoleId)" class="badge-brand">{{
              roleName(p.user.adminRoleId)
            }}</span>
            <span class="badge">{{ p.user.authSource.toUpperCase() }}</span>
          </div>
        </div>
        <div class="flex shrink-0 gap-2">
          <button
            v-if="!p.user.disabled"
            type="button"
            class="btn-danger"
            data-testid="profile-offboard"
            @click="emit('offboard')"
          >
            {{ t('admin.offboard') }}
          </button>
          <button type="button" class="btn" @click="emit('close')">{{ t('profile.close') }}</button>
        </div>
      </header>

      <div class="grid gap-4 lg:grid-cols-3">
        <div>
          <h3 class="mb-1.5 text-xs font-medium text-slate-500">{{ t('profile.groups') }}</h3>
          <ul v-if="p.groups.length" class="flex flex-wrap gap-1" data-testid="profile-groups">
            <li v-for="g in p.groups" :key="g.id" class="badge gap-1">
              <Icon name="users" class="size-3.5" />{{ g.name
              }}<span v-if="roleName(g.adminRoleId)" class="text-brand-700"
                >· {{ roleName(g.adminRoleId) }}</span
              >
            </li>
          </ul>
          <p v-else class="text-slate-500">{{ t('profile.noGroups') }}</p>
        </div>
        <div>
          <h3 class="mb-1.5 text-xs font-medium text-slate-500">{{ t('profile.vaults') }}</h3>
          <ul v-if="p.vaults.length" class="space-y-1" data-testid="profile-vaults">
            <li v-for="v in p.vaults" :key="v.id" class="flex justify-between gap-2">
              <span class="min-w-0 truncate">{{ vaultLabel(v, t) }}</span>
              <span class="shrink-0 text-slate-500">{{ t(`role.${v.role}`) }}</span>
            </li>
          </ul>
          <p v-else class="text-slate-500">{{ t('profile.noVaults') }}</p>
        </div>
        <div>
          <h3 class="mb-1.5 text-xs font-medium text-slate-500">
            {{ t('profile.sessions', { n: p.sessionList.length }) }}
          </h3>
          <ul class="space-y-1 text-xs" data-testid="profile-sessions">
            <li v-for="s in p.sessionList" :key="s.id" class="text-slate-600 dark:text-slate-300">
              <span class="num">{{ when(s.lastSeenAt) }}</span>
              <span v-if="s.ip" class="text-slate-500"> · {{ s.ip }}</span>
            </li>
          </ul>
          <button
            v-if="p.sessionList.length"
            type="button"
            class="btn mt-2"
            :disabled="busy"
            @click="endSessions"
          >
            {{ t('admin.endSessions') }}
          </button>
          <p class="mt-2 text-xs text-slate-500">
            {{ t('profile.extras', { a: p.apiTokens, l: p.externalLinks }) }}
          </p>
        </div>
      </div>
    </template>
  </section>
</template>
