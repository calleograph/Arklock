<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '../services/api';
import { errorMessage, spaceLabel, vaultLabel, when } from '../services/helpers';
import { ledgerAction, ledgerTarget, type LedgerItem } from '../services/ledger';
import { useAuthStore } from '../stores/auth';
import Icon from './Icon.vue';

/** Карточка сотрудника: статус, группы, сеансы и сейфы в одном месте — без перехода по разделам. */
const props = defineProps<{
  userId: string;
  adminRoles: { id: string; name: string }[];
  /** у просматривающего есть доступ к журналу действий */
  canLedger?: boolean;
}>();
const emit = defineEmits<{ close: []; offboard: []; changed: [] }>();
const { t, te } = useI18n();
const router = useRouter();
const auth = useAuthStore();

interface Profile {
  user: {
    id: string;
    name: string;
    email: string;
    title: string | null;
    department: string | null;
    phone: string | null;
    profileSource: Record<string, 'ldap'>;
    disabled: boolean;
    disabledReason?: 'manual' | 'directory' | 'offboarding' | 'expired' | null;
    accessUntil?: string | null;
    disabledNote?: string | null;
    disabledAt?: string | null;
    role: string;
    chief?: boolean;
    adminRoleId: string | null;
    authSource: string;
    createdAt: string;
  };
  mfa: { totp: boolean; passkey: boolean };
  spaces: { id: string; name: string; isDefault: boolean }[];
  groups: { id: string; name: string; adminRoleId: string | null }[];
  sessionList: { id: string; lastSeenAt: string; ip: string | null; userAgent: string | null }[];
  vaults: { id: string; name: string; role: string; entries: number }[];
  apiTokens: number;
  externalLinks: number;
  /** «смените пароль» после увольнения: одно общее событие по всем записям сотрудника */
  rotation: {
    total: number;
    open: number;
    available: number;
    vaults: { id: string; name: string | null; total: number; open: number; available: number }[];
  } | null;
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
// последние действия сотрудника и над его учётной записью; весь журнал — в разделе «Журнал действий»
const recent = ref<LedgerItem[] | null>(null);
async function loadRecent(): Promise<void> {
  if (!props.canLedger) return;
  recent.value = (
    await api<{ items: LedgerItem[] }>('GET', `/admin/ledger?user=${props.userId}&limit=10`).catch(
      () => ({ items: [] }),
    )
  ).items;
}
const openJournal = () =>
  router.push({
    path: '/admin/ledger',
    query: { user: props.userId, name: p.value?.user.name ?? '' },
  });
onMounted(() => void Promise.all([load(), loadRecent()]));

const FIELDS = ['title', 'department', 'phone'] as const;
type Field = (typeof FIELDS)[number];
const editing = ref(false);
const draft = ref<Record<Field, string>>({ title: '', department: '', phone: '' });
const synced = (f: string) => p.value?.user.profileSource[f] === 'ldap';
function startEdit(): void {
  for (const f of FIELDS) draft.value[f] = p.value?.user[f] ?? '';
  editing.value = true;
}
async function saveCard(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    // поля из каталога не отправляются: их меняет только каталог
    const body = Object.fromEntries(
      FIELDS.filter((f) => !synced(f)).map((f) => [f, draft.value[f]]),
    );
    await api('PATCH', `/admin/users/${props.userId}/profile`, body);
    editing.value = false;
    await load();
    emit('changed');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
// поле datetime-local — местное время без зоны; серверу уходит момент в UTC
const localInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const untilDraft = ref('');
watch(p, (v) => (untilDraft.value = localInput(v?.user.accessUntil)), { immediate: true });
async function saveUntil(value: string): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api('PATCH', `/admin/users/${props.userId}`, {
      accessUntil: value ? new Date(value).toISOString() : null,
    });
    await load();
    emit('changed');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
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
            <span
              v-if="p.user.disabled && p.user.disabledReason"
              class="badge"
              data-testid="profile-disabled-reason"
              >{{ t(`admin.disabledBy.${p.user.disabledReason}`)
              }}<template v-if="p.user.disabledAt"> · {{ when(p.user.disabledAt) }}</template
              ><template v-if="p.user.disabledNote">: {{ p.user.disabledNote }}</template></span
            >
            <span
              v-if="!p.user.disabled && p.user.accessUntil"
              class="badge text-amber-700"
              data-testid="profile-access-until-badge"
              >{{ t('admin.accessUntilShort', { at: when(p.user.accessUntil) }) }}</span
            >
            <span class="badge">{{
              p.user.role === 'admin' ? t('admin.roleAdmin') : t('admin.roleMember')
            }}</span>
            <span v-if="roleName(p.user.adminRoleId)" class="badge-brand">{{
              roleName(p.user.adminRoleId)
            }}</span>
            <span v-if="p.user.chief" class="badge-brand">{{ t('chief.title') }}</span>
            <span class="badge">{{ p.user.authSource.toUpperCase() }}</span>
            <span
              class="badge"
              :class="p.mfa.totp || p.mfa.passkey ? 'text-emerald-700' : 'text-amber-700'"
              data-testid="profile-mfa"
              >{{
                p.mfa.passkey
                  ? t('profile.mfaPasskey')
                  : p.mfa.totp
                    ? t('profile.mfaTotp')
                    : t('profile.mfaNone')
              }}</span
            >
          </div>
        </div>
        <div class="flex shrink-0 gap-2">
          <button
            v-if="!p.user.disabled && !p.user.chief && p.user.id !== auth.user?.id"
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

      <form
        class="grid gap-x-4 gap-y-2 sm:grid-cols-3"
        data-testid="profile-card"
        @submit.prevent="saveCard"
      >
        <div v-for="f in FIELDS" :key="f">
          <div class="field-label">
            {{ t(`profile.field.${f}`) }}
            <span v-if="synced(f)" class="font-normal text-slate-500"
              >· {{ t('profile.fromDirectory') }}</span
            >
          </div>
          <input
            v-if="editing && !synced(f)"
            v-model="draft[f]"
            class="input"
            :maxlength="f === 'phone' ? 50 : 200"
            :data-testid="`profile-edit-${f}`"
          />
          <p v-else class="break-words">{{ p.user[f] || '—' }}</p>
        </div>
        <div class="flex gap-2 sm:col-span-3">
          <template v-if="editing">
            <button type="submit" class="btn-primary" :disabled="busy" data-testid="profile-save">
              {{ t('common.save') }}
            </button>
            <button type="button" class="btn" @click="editing = false">
              {{ t('common.cancel') }}
            </button>
          </template>
          <button
            v-else-if="FIELDS.some((f) => !synced(f))"
            type="button"
            class="btn"
            data-testid="profile-edit"
            @click="startEdit"
          >
            {{ t('profile.edit') }}
          </button>
          <p v-if="FIELDS.some(synced)" class="self-center text-xs text-slate-500">
            {{ t('profile.syncedHint') }}
          </p>
        </div>
      </form>
      <!-- срок действия учётной записи: временные сотрудники и подрядчики; у администраторов и у себя не задаётся -->
      <div
        v-if="p.user.role !== 'admin' && p.user.id !== auth.user?.id && !p.user.disabled"
        class="flex flex-wrap items-end gap-2"
        data-testid="profile-access-until"
      >
        <label class="block"
          ><span class="field-label">{{ t('profile.accessUntil') }}</span
          ><input
            v-model="untilDraft"
            type="datetime-local"
            class="input w-auto"
            data-testid="profile-access-until-input"
        /></label>
        <button
          type="button"
          class="btn"
          :disabled="busy || !untilDraft"
          data-testid="profile-access-until-save"
          @click="saveUntil(untilDraft)"
        >
          {{ t('common.save') }}
        </button>
        <button
          v-if="p.user.accessUntil"
          type="button"
          class="btn-ghost"
          :disabled="busy"
          @click="saveUntil('')"
        >
          {{ t('profile.accessUntilClear') }}
        </button>
        <p class="w-full text-xs text-slate-500">{{ t('profile.accessUntilHint') }}</p>
      </div>

      <div class="grid gap-4 lg:grid-cols-4">
        <div>
          <h3 class="mb-1.5 text-xs font-medium text-slate-500">{{ t('profile.spaces') }}</h3>
          <ul v-if="p.spaces.length" class="flex flex-wrap gap-1" data-testid="profile-spaces">
            <li v-for="s in p.spaces" :key="s.id" class="badge">{{ spaceLabel(s, t) }}</li>
          </ul>
          <p v-else class="text-slate-500">{{ t('profile.noSpaces') }}</p>
        </div>
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
      <div v-if="p.rotation" data-testid="profile-rotation">
        <h3 class="mb-1.5 text-xs font-medium text-slate-500">{{ t('profile.rotation') }}</h3>
        <p>
          {{
            t('profile.rotationSummary', {
              closed: p.rotation.total - p.rotation.open,
              total: p.rotation.total,
              available: p.rotation.available,
            })
          }}
        </p>
        <p v-if="p.rotation.available < p.rotation.total" class="text-xs text-slate-500">
          {{ t('profile.rotationHint') }}
        </p>
        <ul class="mt-1 space-y-1 text-xs">
          <li v-for="v in p.rotation.vaults" :key="v.id" class="flex justify-between gap-2">
            <RouterLink
              v-if="v.available"
              :to="`/vault/${v.id}/settings`"
              class="min-w-0 truncate underline"
              >{{ v.name ? vaultLabel(v, t) : t('profile.rotationPersonal') }}</RouterLink
            >
            <span v-else class="min-w-0 truncate">{{
              v.name ? vaultLabel(v, t) : t('profile.rotationPersonal')
            }}</span>
            <span class="num shrink-0 text-slate-500">{{
              t('profile.rotationVault', { open: v.open, total: v.total })
            }}</span>
          </li>
        </ul>
      </div>
      <div v-if="recent" data-testid="profile-journal">
        <div class="mb-1.5 flex items-center justify-between gap-2">
          <h3 class="text-xs font-medium text-slate-500">{{ t('profile.journal') }}</h3>
          <button
            type="button"
            class="text-xs underline"
            data-testid="profile-journal-all"
            @click="openJournal"
          >
            {{ t('profile.journalAll') }}
          </button>
        </div>
        <ul v-if="recent.length" class="divide-y divide-slate-200 text-xs dark:divide-slate-800">
          <li v-for="l in recent" :key="l.id" class="flex flex-wrap gap-x-2 py-1">
            <span class="num shrink-0 text-slate-500">{{ when(l.at) }}</span>
            <span :title="l.action">{{ ledgerAction(l.action, t, te) }}</span>
            <span class="min-w-0 truncate text-slate-500" :title="l.target ?? ''">{{
              ledgerTarget(l, t, te)
            }}</span>
          </li>
        </ul>
        <p v-else class="text-xs text-slate-500">{{ t('profile.journalEmpty') }}</p>
      </div>
    </template>
  </section>
</template>
