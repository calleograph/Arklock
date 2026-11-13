<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, vaultLabel, when } from '../services/helpers';
import { useWorkspaceStore } from '../stores/workspace';
import DomainGroupLinks from './DomainGroupLinks.vue';
import PersonPicker, { type Person } from './PersonPicker.vue';

/**
 * Открытая группа: состав постранично с поиском, добавление и исключение, привязка групп домена и сейфы группы
 * (назначить, изменить роль, снять). Группа с привязкой к каталогу получает состав от каталога.
 */
const props = defineProps<{
  circle: { id: string; name: string; members?: number; directoryLinks?: number };
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      membersTitle: 'Участники',
      count: 'Участников: {n}',
      find: 'Найти в составе: имя или почта',
      none: 'Участников нет.',
      pending: 'ждёт первого входа',
      disabled: 'отключён',
      removeSelected: 'Исключить выбранных',
      removeOne: 'Исключить: {name}',
      add: 'Добавить',
      addPlaceholder: 'Добавить участников: имя, логин или почта',
      prev: 'Назад',
      next: 'Вперёд',
      range: '{from}–{to} из {total}',
      directoryNote:
        'Состав связан с группой домена: человек, исключённый вручную, вернётся при следующей сверке с каталогом. Чтобы убрать насовсем, исключите его из группы домена или отвяжите её.',
      vaultsTitle: 'Сейфы группы',
      vaultsNone: 'Группа не назначена ни одному сейфу.',
      vaultsHint:
        'Каждый участник группы получает в сейфе указанную роль. Назначать и менять роли может администратор сейфа.',
      customRole: 'особая роль',
      until: 'до {date}',
      removeVault: 'Снять',
      assign: 'Назначить сейф',
      assignRole: 'Роль в сейфе',
      pick: 'Выберите сейф',
      assigned: 'Сейф назначен.',
      unassigned:
        'Сейф снят. Чтобы закрыть доступ по ранее полученным ключам, обновите ключ сейфа в его настройках.',
      roleChanged: 'Роль изменена.',
      roles: {
        admin: 'Администратор',
        editor: 'Редактор',
        reader: 'Читатель',
        limited: 'Ограниченный',
      },
    },
    en: {
      membersTitle: 'Members',
      count: 'Members: {n}',
      find: 'Search the members: name or e-mail',
      none: 'No members.',
      pending: 'waiting for first sign-in',
      disabled: 'disabled',
      removeSelected: 'Remove selected',
      removeOne: 'Remove: {name}',
      add: 'Add',
      addPlaceholder: 'Add members: name, login or e-mail',
      prev: 'Back',
      next: 'Next',
      range: '{from}–{to} of {total}',
      directoryNote:
        'The membership is linked to a domain group: a person removed by hand returns at the next directory sync. To remove for good, take them out of the domain group or unlink it.',
      vaultsTitle: 'Group vaults',
      vaultsNone: 'The group is not assigned to any vault.',
      vaultsHint:
        'Every member of the group gets the chosen role in the vault. A vault administrator assigns and changes roles.',
      customRole: 'custom role',
      until: 'until {date}',
      removeVault: 'Remove',
      assign: 'Assign a vault',
      assignRole: 'Role in the vault',
      pick: 'Choose a vault',
      assigned: 'Vault assigned.',
      unassigned:
        'Vault removed. To close access through previously received keys, renew the vault key in its settings.',
      roleChanged: 'Role changed.',
      roles: { admin: 'Administrator', editor: 'Editor', reader: 'Reader', limited: 'Limited' },
    },
  },
});
const ws = useWorkspaceStore();

interface Member {
  id: string;
  name: string;
  email: string;
  pending: boolean;
  disabled: boolean;
}
interface GroupVault {
  id: string;
  name: string | null;
  role: string;
  customRoleId: string | null;
  expiresAt: string | null;
}
const PAGE = 20;
const members = ref<Member[]>([]);
const total = ref(0);
const offset = ref(0);
const find = ref('');
const selected = ref<string[]>([]);
const adding = ref<Person[]>([]);
const vaults = ref<GroupVault[]>([]);
const pickVault = ref('');
const pickRole = ref('reader');
const busy = ref(false);
const error = ref('');
const notice = ref('');

async function loadMembers(): Promise<void> {
  const r = await api<{ items: Member[]; total: number }>(
    'GET',
    `/admin/circles/${props.circle.id}/members?limit=${PAGE}&offset=${offset.value}&q=${encodeURIComponent(find.value.trim())}`,
  );
  members.value = r.items;
  total.value = r.total;
}
const loadVaults = async () =>
  (vaults.value = await api<GroupVault[]>('GET', `/admin/circles/${props.circle.id}/vaults`));
async function run(fn: () => Promise<void>, ok = ''): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
    if (ok) notice.value = ok;
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
const refresh = () => run(async () => void (await Promise.all([loadMembers(), loadVaults()])));
onMounted(async () => {
  if (!ws.vaults.length) await ws.loadVaults().catch(() => undefined);
  await refresh();
});
let timer: ReturnType<typeof setTimeout> | undefined;
watch(find, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    offset.value = 0;
    void loadMembers().catch((e) => (error.value = errorMessage(e, t)));
  }, 250);
});
const page = (d: number) => {
  offset.value = Math.max(0, offset.value + d * PAGE);
  selected.value = [];
  void loadMembers().catch((e) => (error.value = errorMessage(e, t)));
};

const change = (body: { add?: string[]; remove?: string[] }) =>
  run(async () => {
    await api('PATCH', `/admin/circles/${props.circle.id}/members`, body);
    adding.value = [];
    selected.value = [];
    await loadMembers();
    emit('changed');
  });
const removeOne = (m: Member) =>
  run(async () => {
    await api('DELETE', `/admin/circles/${props.circle.id}/members/${m.id}`);
    await loadMembers();
    emit('changed');
  });

/** Сейфы, которыми может управлять просматривающий и которые группе ещё не назначены. */
const candidates = computed(() =>
  ws.vaults.filter(
    (v) => v.kind === 'shared' && v.canManageMembers && !vaults.value.some((g) => g.id === v.id),
  ),
);
const assign = () =>
  run(async () => {
    await api('PUT', `/vaults/${pickVault.value}/circles/${props.circle.id}`, {
      role: pickRole.value,
    });
    pickVault.value = '';
    await loadVaults();
  }, t('assigned'));
const setRole = (v: GroupVault, role: string) =>
  run(async () => {
    await api('PUT', `/vaults/${v.id}/circles/${props.circle.id}`, {
      role,
      expiresAt: v.expiresAt,
    });
    await loadVaults();
  }, t('roleChanged'));
const unassign = (v: GroupVault) =>
  run(async () => {
    await api('DELETE', `/vaults/${v.id}/circles/${props.circle.id}`);
    await loadVaults();
  }, t('unassigned'));
const ROLES = ['admin', 'editor', 'reader', 'limited'];
</script>

<template>
  <div class="mt-2 space-y-4" data-testid="group-detail">
    <p v-if="error" class="text-xs text-red-600" role="alert" data-testid="group-detail-error">
      {{ error }}
    </p>
    <p v-if="notice" class="text-xs text-emerald-700 dark:text-emerald-300" role="status">
      {{ notice }}
    </p>

    <div class="space-y-2">
      <h3 class="text-xs font-medium">{{ t('membersTitle') }}</h3>
      <p class="text-xs text-slate-500">{{ t('count', { n: circle.members ?? total }) }}</p>
      <p
        v-if="circle.directoryLinks"
        class="max-w-prose text-xs text-amber-700 dark:text-amber-300"
        data-testid="group-directory-note"
      >
        {{ t('directoryNote') }}
      </p>
      <input
        v-model="find"
        type="search"
        class="input"
        :placeholder="t('find')"
        :aria-label="t('find')"
        data-testid="group-members-find"
      />
      <ul v-if="members.length" class="text-xs">
        <li
          v-for="m in members"
          :key="m.id"
          class="flex min-h-11 items-center justify-between gap-2"
        >
          <label class="flex min-w-0 items-center gap-2"
            ><input v-model="selected" :value="m.id" type="checkbox" /><span class="min-w-0"
              >{{ m.name }} ({{ m.email }})<span v-if="m.pending" class="text-slate-500">
                · {{ t('pending') }}</span
              ><span v-if="m.disabled" class="text-slate-500"> · {{ t('disabled') }}</span></span
            ></label
          >
          <button
            type="button"
            class="btn min-w-11 text-red-600"
            :disabled="busy"
            :aria-label="t('removeOne', { name: m.name })"
            @click="removeOne(m)"
          >
            ×
          </button>
        </li>
      </ul>
      <p v-else class="text-xs text-slate-500">{{ t('none') }}</p>
      <div v-if="total > PAGE" class="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <button type="button" class="btn" :disabled="offset === 0" @click="page(-1)">
          {{ t('prev') }}
        </button>
        <span>{{
          t('range', { from: offset + 1, to: Math.min(total, offset + PAGE), total })
        }}</span>
        <button type="button" class="btn" :disabled="offset + PAGE >= total" @click="page(1)">
          {{ t('next') }}
        </button>
      </div>
      <button
        v-if="selected.length"
        type="button"
        class="btn-danger"
        :disabled="busy"
        @click="change({ remove: selected })"
      >
        {{ t('removeSelected') }} ({{ selected.length }})
      </button>
      <div class="space-y-1">
        <PersonPicker
          v-model="adding"
          multiple
          :exclude="members.map((m) => m.id)"
          :placeholder="t('addPlaceholder')"
          testid="circle-add-user"
        />
        <button
          type="button"
          class="btn"
          :disabled="busy || !adding.length"
          data-testid="circle-add"
          @click="change({ add: adding.map((p) => p.id) })"
        >
          {{ t('add') }}<span v-if="adding.length"> ({{ adding.length }})</span>
        </button>
      </div>
    </div>

    <DomainGroupLinks
      :circle-id="circle.id"
      :circle-name="circle.name"
      @changed="(refresh(), emit('changed'))"
    />

    <div class="space-y-2 text-xs" data-testid="group-vaults">
      <h3 class="font-medium">
        {{ t('vaultsTitle') }}<InfoHint class="ml-1" :text="t('vaultsHint')" />
      </h3>
      <p v-if="!vaults.length" class="text-slate-500">{{ t('vaultsNone') }}</p>
      <ul v-else>
        <li v-for="v in vaults" :key="v.id" class="list-row" :data-testid="`group-vault-${v.name}`">
          <span class="min-w-0"
            >{{ vaultLabel(v, t) }}
            <span v-if="v.expiresAt" class="text-slate-500">
              · {{ t('until', { date: when(v.expiresAt) }) }}</span
            ></span
          >
          <span class="row-actions">
            <span v-if="v.customRoleId" class="text-slate-500">{{ t('customRole') }}</span>
            <select
              v-else
              :value="v.role"
              class="input w-40"
              :disabled="busy"
              :aria-label="`${t('assignRole')}: ${v.name}`"
              @change="setRole(v, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="r in ROLES" :key="r" :value="r">{{ t(`roles.${r}`) }}</option>
            </select>
            <button type="button" class="btn" :disabled="busy" @click="unassign(v)">
              {{ t('removeVault') }}
            </button>
          </span>
        </li>
      </ul>
      <div v-if="candidates.length" class="flex flex-wrap items-center gap-2">
        <select
          v-model="pickVault"
          class="input w-auto max-w-full"
          :aria-label="t('assign')"
          data-testid="group-vault-pick"
        >
          <option value="">{{ t('pick') }}</option>
          <option v-for="v in candidates" :key="v.id" :value="v.id">{{ vaultLabel(v, t) }}</option>
        </select>
        <select v-model="pickRole" class="input w-auto" :aria-label="t('assignRole')">
          <option v-for="r in ROLES" :key="r" :value="r">{{ t(`roles.${r}`) }}</option>
        </select>
        <button
          type="button"
          class="btn"
          :disabled="busy || !pickVault"
          data-testid="group-vault-assign"
          @click="assign"
        >
          {{ t('assign') }}
        </button>
      </div>
    </div>
  </div>
</template>
