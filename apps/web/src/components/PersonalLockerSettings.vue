<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import GroupPicker, { type Group } from './GroupPicker.vue';

const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      title: 'Личные сейфы',
      all: 'Разрешить всей организации',
      deny: 'Запретить всем',
      hint: 'По умолчанию запрещены. Исключения можно выдать пользователям и группам. Отключение сохраняет зашифрованные данные и ключи.',
      migration:
        'Для экспорта или переноса ранее созданных данных временно разрешите личный сейф конкретному пользователю. Он выполнит экспорт сам, затем отзовите разрешение. Администратор не получает ключи или содержимое.',
      groups: 'Разрешённые группы',
      users: 'Пользователи и сохранённые данные',
      direct: 'Личное разрешение',
      user: 'Пользователь',
      allowed: 'Разрешён',
      denied: 'Запрещён',
      policy: 'Доступ по политике',
      data: 'Сейфы / записи',
      find: 'Найти сотрудника (имя, почта)',
      findGroup: 'Найти группу',
      prev: 'Назад',
      next: 'Дальше',
      shownNote: 'Без запроса показаны сотрудники с личным сейфом или личным разрешением.',
      range: '{from}–{to} из {total}',
    },
    en: {
      title: 'Personal vaults',
      all: 'Allow for the whole organization',
      deny: 'Deny for everyone',
      hint: 'Disabled by default. Allow specific users or groups. Disabling preserves encrypted data and keys.',
      migration:
        'To export or move existing data, temporarily allow the personal vault for that user. The user exports it themselves; then revoke permission. Administrators receive no keys or content.',
      groups: 'Allowed groups',
      users: 'Users and preserved data',
      direct: 'Individual permission',
      user: 'User',
      allowed: 'Allowed',
      denied: 'Denied',
      policy: 'Effective access',
      data: 'Vaults / entries',
      find: 'Find an employee (name, email)',
      findGroup: 'Find a group',
      prev: 'Back',
      next: 'Next',
      shownNote:
        'Without a query, employees with a personal vault or an individual permission are shown.',
      range: '{from}–{to} of {total}',
    },
  },
});
interface Person {
  id: string;
  name: string;
  email: string;
  allowed: boolean;
  direct: boolean;
  lockers: { id: string; entries: number }[];
}
const PAGE = 50;
const settings = ref<Record<string, unknown>>({});
const inventory = ref<{ users: Person[]; circles: Group[]; total: number }>({
  users: [],
  circles: [],
  total: 0,
});
const q = ref('');
const page = ref(0);
const busy = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
async function load(): Promise<void> {
  const p = new URLSearchParams({
    limit: String(PAGE),
    offset: String(page.value * PAGE),
    q: q.value.trim(),
  });
  [settings.value, inventory.value] = await Promise.all([
    api<Record<string, unknown>>('GET', '/admin/settings'),
    api<typeof inventory.value>('GET', `/admin/settings/personal-lockers?${p}`),
  ]);
}
async function save(values: Record<string, unknown>): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api('PUT', '/admin/settings', values);
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
function toggleUser(id: string, checked: boolean): void {
  const ids = new Set((settings.value['vaults.personalLockerUsers'] as string[] | undefined) ?? []);
  if (checked) ids.add(id);
  else ids.delete(id);
  void save({ 'vaults.personalLockerUsers': [...ids] });
}
const groups = computed<Group[]>({
  get: () => inventory.value.circles,
  set: (v) => void save({ 'vaults.personalLockerCircles': v.map((g) => g.id) }),
});
watch(q, () => {
  page.value = 0;
  clearTimeout(timer);
  timer = setTimeout(() => void load().catch((e) => (error.value = errorMessage(e, t))), 250);
});
onBeforeUnmount(() => clearTimeout(timer));
const go = (n: number) => {
  page.value += n;
  void load();
};
onMounted(async () => {
  try {
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});
</script>

<template>
  <div class="space-y-3 border-t border-slate-200 pt-4" data-testid="personal-locker-policy">
    <h3 class="font-medium">{{ t('title') }}</h3>
    <p class="text-xs text-slate-500">{{ t('hint') }}</p>
    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>
    <fieldset :disabled="busy" class="space-y-3">
      <label class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {{ t('all') }}
        <input
          type="checkbox"
          class="switch"
          data-testid="set-personal-lockers"
          :checked="settings['vaults.personalLockers'] === true"
          @change="save({ 'vaults.personalLockers': ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <button
        type="button"
        class="btn"
        data-testid="deny-personal-lockers"
        @click="
          save({
            'vaults.personalLockers': false,
            'vaults.personalLockerUsers': [],
            'vaults.personalLockerCircles': [],
          })
        "
      >
        {{ t('deny') }}
      </button>
      <div class="space-y-1">
        <h4 class="font-medium">{{ t('groups') }}</h4>
        <GroupPicker v-model="groups" :placeholder="t('findGroup')" testid="locker-groups" />
      </div>
      <div class="overflow-x-auto">
        <h4 class="mb-1 font-medium">{{ t('users') }}</h4>
        <input
          v-model="q"
          type="search"
          class="input mb-1 max-w-xs"
          :placeholder="t('find')"
          :aria-label="t('find')"
          data-testid="locker-search"
        />
        <p v-if="!q" class="mb-1 text-xs text-slate-500">{{ t('shownNote') }}</p>
        <table class="w-full text-left text-xs">
          <thead>
            <tr>
              <th class="p-2">{{ t('user') }}</th>
              <th class="p-2">{{ t('direct') }}</th>
              <th class="p-2">{{ t('policy') }}</th>
              <th class="p-2">{{ t('data') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in inventory.users" :key="u.id" class="border-t border-slate-200">
              <td class="p-2">
                {{ u.name }}
                <div class="text-slate-500">{{ u.email }}</div>
              </td>
              <td class="p-2">
                <input
                  type="checkbox"
                  :aria-label="`${t('direct')}: ${u.email}`"
                  :checked="u.direct"
                  @change="toggleUser(u.id, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td class="p-2">{{ u.allowed ? t('allowed') : t('denied') }}</td>
              <td class="p-2">
                {{ u.lockers.length }} / {{ u.lockers.reduce((n, v) => n + v.entries, 0) }}
              </td>
            </tr>
          </tbody>
        </table>
        <div class="flex items-center justify-between pt-1 text-xs text-slate-500">
          <span>{{
            t('range', {
              from: inventory.total ? page * PAGE + 1 : 0,
              to: Math.min(inventory.total, (page + 1) * PAGE),
              total: inventory.total,
            })
          }}</span>
          <span class="flex gap-1">
            <button type="button" class="btn" :disabled="page === 0" @click="go(-1)">
              {{ t('prev') }}
            </button>
            <button
              type="button"
              class="btn"
              :disabled="(page + 1) * PAGE >= inventory.total"
              @click="go(1)"
            >
              {{ t('next') }}
            </button>
          </span>
        </div>
      </div>
    </fieldset>
    <p class="text-xs text-slate-500">{{ t('migration') }}</p>
  </div>
</template>
