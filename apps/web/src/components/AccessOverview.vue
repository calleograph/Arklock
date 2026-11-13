<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, spaceLabel, vaultLabel, when } from '../services/helpers';
import { useAuthStore } from '../stores/auth';
import InfoHint from './InfoHint.vue';
import PersonPicker, { type Person } from './PersonPicker.vue';

/**
 * «Доступы»: кто куда ходит. По сотруднику — его подразделения (руководитель, участник, гость), группы и сейфы с ролью
 * и источником права. По сейфу (главный администратор) — люди, группы и гости с доступом. Только сведения о доступе:
 * содержимого и ключей здесь нет.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      byUser: 'По сотруднику',
      byVault: 'По сейфу',
      findUser: 'Введите имя или почту сотрудника',
      findUserHint:
        'Начните вводить имя, логин или почту: найденный сотрудник выбирается из списка, и его доступы показываются сразу.',
      depts: 'Подразделения',
      deptsHint:
        'Руководитель управляет подразделением и его сейфами. Участник входит в группу подразделения и видит его сейфы с ролью группы. Гость видит только выданные ему папки и записи, на время.',
      none: 'Ни в одном подразделении не состоит.',
      head: 'руководитель',
      member: 'участник',
      guest: 'гость',
      groups: 'Группы',
      groupsHint:
        'Группы, в которые входит сотрудник. Через группы он получает доступ к сейфам и пространствам.',
      noGroups: 'Ни в одной группе не состоит.',
      vaults: 'Сейфы',
      vaultsHint:
        'Корпоративные сейфы, к которым у сотрудника есть доступ: роль, откуда она получена, сколько правил выдано на отдельные папки и записи и сколько записей он видит.',
      noVaults: 'Нет доступа к корпоративным сейфам.',
      direct: 'напрямую: {role}',
      viaGroup: 'через группу «{name}»: {role}',
      rules: 'правил на папки и записи: разрешений {allow}, запретов {deny}',
      sees: 'видит записей: {sees} из {total}',
      notes:
        'Сотрудник из каталога, который ещё не входил, ждёт первого входа: роли ему назначены, а ключи сейфов выдаются после входа.',
      pending: 'ждёт первого входа',
      vaultFind: 'Название сейфа или владелец',
      onlyChief: 'Список доступов к сейфу виден главному администратору.',
      people: 'Люди с прямой ролью',
      peopleHint:
        'Роль в сейфе, срок и выдан ли им ключ. «Нет ключа» — человек получит его, когда его выдаст администратор сейфа.',
      groupsTitle: 'Группы',
      members: 'участников: {n}',
      guests: 'Гости и отдельные папки и записи',
      guestsHint:
        'Люди, которым выдан доступ к отдельным папкам или записям сейфа. Гость — человек из другого подразделения: он видит только выданное, доступ временный.',
      guestMark: 'гость',
      rulesN: 'правил: {n}',
      until: 'до {date}',
      noKey: 'нет ключа',
      key: 'ключ выдан',
      show: 'Показать доступы',
      disabled: 'отключён',
      roles: {
        owner: 'владелец',
        admin: 'администратор',
        editor: 'редактор',
        reader: 'читатель',
        limited: 'ограниченный',
      },
    },
    en: {
      byUser: 'By employee',
      byVault: 'By vault',
      findUser: 'Type an employee name or e-mail',
      findUserHint:
        'Start typing a name, login or e-mail: the found employee is picked from the list and their access appears at once.',
      depts: 'Departments',
      deptsHint:
        'A head manages the department and its vaults. A member is in the department group and sees its vaults with the group role. A guest sees only the folders and entries given to them, for a time.',
      none: 'Not a member of any department.',
      head: 'head',
      member: 'member',
      guest: 'guest',
      groups: 'Groups',
      groupsHint:
        'Groups the employee belongs to. Through groups they get access to vaults and departments.',
      noGroups: 'Not a member of any group.',
      vaults: 'Vaults',
      vaultsHint:
        'Corporate vaults the employee can access: the role, where it comes from, how many rules are given for single folders and entries, and how many entries they see.',
      noVaults: 'No access to corporate vaults.',
      direct: 'directly: {role}',
      viaGroup: 'through the group “{name}”: {role}',
      rules: 'rules for folders and entries: allows {allow}, denies {deny}',
      sees: 'sees entries: {sees} of {total}',
      notes:
        'A directory employee who has not signed in yet waits for the first sign-in: roles are assigned, the vault keys are issued after the sign-in.',
      pending: 'waiting for first sign-in',
      vaultFind: 'Vault name or owner',
      onlyChief: 'The access list of a vault is visible to the chief administrator.',
      people: 'People with a direct role',
      peopleHint:
        'Role in the vault, term and whether the key is issued. “No key” — the person gets it when a vault administrator issues it.',
      groupsTitle: 'Groups',
      members: 'members: {n}',
      guests: 'Guests and single folders and entries',
      guestsHint:
        'People given access to single folders or entries of the vault. A guest is a person from another department: they see only what is given, for a time.',
      guestMark: 'guest',
      rulesN: 'rules: {n}',
      until: 'until {date}',
      noKey: 'no key',
      key: 'key issued',
      show: 'Show access',
      disabled: 'disabled',
      roles: {
        owner: 'owner',
        admin: 'administrator',
        editor: 'editor',
        reader: 'reader',
        limited: 'limited',
      },
    },
  },
});
const auth = useAuthStore();
const mode = ref<'user' | 'vault'>('user');
const picked = ref<Person[]>([]);
const error = ref('');

interface Profile {
  user: {
    id: string;
    name: string;
    email: string;
    disabled: boolean;
    authSource: string;
    role: string;
  };
  spaces: { id: string; name: string; isDefault: boolean; head?: boolean; guest?: boolean }[];
  groups: { id: string; name: string; directory?: boolean }[];
  access: {
    id: string;
    name: string | null;
    direct: string | null;
    groups: { name: string; role: string }[];
    rules: { allow: number; deny: number };
    sees: number;
    total: number;
  }[];
}
const profile = ref<Profile | null>(null);
watch(picked, async (v) => {
  const p = v[0];
  profile.value = null;
  error.value = '';
  if (!p) return;
  try {
    profile.value = await api<Profile>('GET', `/admin/users/${p.id}/profile`);
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});
const relation = (s: { head?: boolean; guest?: boolean }) =>
  t(s.head ? 'head' : s.guest ? 'guest' : 'member');
const depts = computed(() => profile.value?.spaces.filter((s) => !s.isDefault) ?? []);
const role = (r: string) =>
  r in { owner: 1, admin: 1, editor: 1, reader: 1, limited: 1 } ? t(`roles.${r}`) : r;

// по сейфу
interface VRow {
  id: string;
  name: string | null;
  kind: string;
  space: string | null;
  owner: string | null;
}
const q = ref('');
const vaultRows = ref<VRow[]>([]);
const vaultAccess = ref<{
  name: string | null;
  space: string | null;
  direct: {
    id: string;
    name: string;
    email: string;
    role: string;
    expiresAt: string | null;
    hasKey: boolean;
  }[];
  groups: { id: string; name: string; role: string; members: number; expiresAt: string | null }[];
  grants: {
    id: string;
    name: string;
    email: string;
    rules: number;
    until: string | null;
    guest: boolean;
  }[];
} | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
watch([q, mode], () => {
  clearTimeout(timer);
  if (mode.value !== 'vault' || !auth.user?.chief) return;
  timer = setTimeout(async () => {
    try {
      const r = await api<{ items: VRow[] }>(
        'GET',
        `/admin/vaults?kind=corporate&limit=20&q=${encodeURIComponent(q.value.trim())}`,
      );
      vaultRows.value = r.items;
    } catch (e) {
      error.value = errorMessage(e, t);
    }
  }, 250);
});
async function openVault(v: VRow): Promise<void> {
  error.value = '';
  try {
    vaultAccess.value = await api('GET', `/admin/vaults/${v.id}/access`);
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
</script>

<template>
  <div class="space-y-4 text-sm" data-testid="access-overview">
    <div class="flex w-fit gap-1 rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800">
      <button
        v-for="m in ['user', 'vault'] as const"
        :key="m"
        type="button"
        class="seg"
        :class="mode === m ? 'seg-on' : ''"
        :data-testid="`access-mode-${m}`"
        @click="mode = m"
      >
        {{ t(m === 'user' ? 'byUser' : 'byVault') }}
      </button>
    </div>
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>

    <template v-if="mode === 'user'">
      <section class="card space-y-3 p-4">
        <h3 class="font-medium">
          {{ t('findUser') }}<InfoHint class="ml-1" :text="t('findUserHint')" />
        </h3>
        <PersonPicker
          v-model="picked"
          :directory="false"
          :placeholder="t('findUser')"
          testid="access-person"
        />
      </section>
      <template v-if="profile">
        <section class="card space-y-3 p-4" data-testid="access-user">
          <h3 class="font-medium">
            {{ profile.user.name }}
            <span class="text-xs font-normal text-slate-500">{{ profile.user.email }}</span>
            <span v-if="profile.user.disabled" class="badge ml-2 text-red-700">{{
              t('disabled')
            }}</span>
          </h3>
          <div>
            <h4 class="mb-1 font-medium">
              {{ t('depts') }}<InfoHint class="ml-1" :text="t('deptsHint')" />
            </h4>
            <ul v-if="depts.length" class="space-y-1" data-testid="access-depts">
              <li
                v-for="d in depts"
                :key="d.id"
                class="flex min-h-11 items-center justify-between gap-2"
                :data-testid="`access-dept-${d.name}`"
              >
                <span>{{ spaceLabel(d, t) }}</span>
                <span class="badge" :class="d.head ? 'badge-brand' : ''">{{ relation(d) }}</span>
              </li>
            </ul>
            <p v-else class="text-slate-500">{{ t('none') }}</p>
          </div>
          <div>
            <h4 class="mb-1 font-medium">
              {{ t('groups') }}<InfoHint class="ml-1" :text="t('groupsHint')" />
            </h4>
            <ul v-if="profile.groups.length" class="flex flex-wrap gap-1">
              <li v-for="g in profile.groups" :key="g.id" class="badge">{{ g.name }}</li>
            </ul>
            <p v-else class="text-slate-500">{{ t('noGroups') }}</p>
          </div>
          <div>
            <h4 class="mb-1 font-medium">
              {{ t('vaults') }}<InfoHint class="ml-1" :text="t('vaultsHint')" />
            </h4>
            <ul
              v-if="profile.access.length"
              class="divide-y divide-slate-200 dark:divide-slate-800"
              data-testid="access-vaults"
            >
              <li v-for="a in profile.access" :key="a.id" class="space-y-0.5 py-2">
                <div class="font-medium">{{ vaultLabel({ name: a.name, kind: 'shared' }, t) }}</div>
                <div class="text-xs text-slate-600 dark:text-slate-300">
                  <span v-if="a.direct">{{ t('direct', { role: role(a.direct) }) }}</span>
                  <span v-for="g in a.groups" :key="g.name" class="ml-2">{{
                    t('viaGroup', { name: g.name, role: role(g.role) })
                  }}</span>
                </div>
                <div class="text-xs text-slate-500">
                  {{ t('rules', a.rules) }} · {{ t('sees', a) }}
                </div>
              </li>
            </ul>
            <p v-else class="text-slate-500">{{ t('noVaults') }}</p>
          </div>
        </section>
      </template>
    </template>

    <template v-else>
      <p v-if="!auth.user?.chief" class="notice notice-warn">{{ t('onlyChief') }}</p>
      <template v-else>
        <section class="card space-y-3 p-4">
          <input
            v-model="q"
            type="search"
            class="input"
            :placeholder="t('vaultFind')"
            :aria-label="t('vaultFind')"
            data-testid="access-vault-search"
          />
          <ul class="divide-y divide-slate-200 dark:divide-slate-800">
            <li
              v-for="v in vaultRows"
              :key="v.id"
              class="flex min-h-11 flex-wrap items-center justify-between gap-2"
            >
              <span
                >{{ vaultLabel({ name: v.name, kind: 'shared' }, t) }}
                <span class="text-xs text-slate-500">{{ v.space ?? '' }}</span></span
              >
              <button
                type="button"
                class="btn"
                :data-testid="`access-vault-open-${v.name}`"
                @click="openVault(v)"
              >
                {{ t('show') }}
              </button>
            </li>
          </ul>
        </section>
        <section v-if="vaultAccess" class="card space-y-3 p-4" data-testid="access-vault">
          <h3 class="font-medium">
            {{ vaultAccess.name }}
            <span class="text-xs font-normal text-slate-500">{{ vaultAccess.space ?? '' }}</span>
          </h3>
          <div>
            <h4 class="mb-1 font-medium">
              {{ t('people') }}<InfoHint class="ml-1" :text="t('peopleHint')" />
            </h4>
            <ul class="space-y-1">
              <li
                v-for="d in vaultAccess.direct"
                :key="d.id"
                class="flex min-h-11 flex-wrap items-center justify-between gap-2"
              >
                <span
                  >{{ d.name }} <span class="text-xs text-slate-500">{{ d.email }}</span></span
                >
                <span class="text-xs text-slate-600 dark:text-slate-300">
                  {{ role(d.role)
                  }}<span v-if="d.expiresAt"> · {{ t('until', { date: when(d.expiresAt) }) }}</span>
                  ·
                  {{ d.hasKey ? t('key') : t('noKey') }}
                </span>
              </li>
            </ul>
          </div>
          <div>
            <h4 class="mb-1 font-medium">{{ t('groupsTitle') }}</h4>
            <ul class="space-y-1">
              <li
                v-for="g in vaultAccess.groups"
                :key="g.id"
                class="flex min-h-11 flex-wrap items-center justify-between gap-2"
              >
                <span>{{ g.name }}</span>
                <span class="text-xs text-slate-600 dark:text-slate-300"
                  >{{ role(g.role) }} · {{ t('members', { n: g.members }) }}</span
                >
              </li>
            </ul>
          </div>
          <div v-if="vaultAccess.grants.length">
            <h4 class="mb-1 font-medium">
              {{ t('guests') }}<InfoHint class="ml-1" :text="t('guestsHint')" />
            </h4>
            <ul class="space-y-1">
              <li
                v-for="g in vaultAccess.grants"
                :key="g.id"
                class="flex min-h-11 flex-wrap items-center justify-between gap-2"
              >
                <span
                  >{{ g.name }} <span class="text-xs text-slate-500">{{ g.email }}</span
                  ><span v-if="g.guest" class="badge ml-2">{{ t('guestMark') }}</span></span
                >
                <span class="text-xs text-slate-600 dark:text-slate-300"
                  >{{ t('rulesN', { n: g.rules })
                  }}<span v-if="g.until"> · {{ t('until', { date: when(g.until) }) }}</span></span
                >
              </li>
            </ul>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>
