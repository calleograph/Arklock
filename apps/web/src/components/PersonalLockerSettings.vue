<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';

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
    },
  },
});
interface Person {
  id: string;
  name: string;
  email: string;
  allowed: boolean;
  lockers: { id: string; entries: number }[];
}
const settings = ref<Record<string, unknown>>({});
const inventory = ref<{ users: Person[]; circles: { id: string; name: string }[] }>({
  users: [],
  circles: [],
});
const busy = ref(false);
const error = ref('');
const selected = (key: string, id: string) =>
  Array.isArray(settings.value[key]) && (settings.value[key] as string[]).includes(id);
async function load(): Promise<void> {
  [settings.value, inventory.value] = await Promise.all([
    api<Record<string, unknown>>('GET', '/admin/settings'),
    api<typeof inventory.value>('GET', '/admin/settings/personal-lockers'),
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
function toggle(key: string, id: string, checked: boolean): void {
  const ids = new Set((settings.value[key] as string[] | undefined) ?? []);
  if (checked) ids.add(id);
  else ids.delete(id);
  void save({ [key]: [...ids] });
}
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
      <div v-if="inventory.circles.length" class="space-y-2">
        <h4 class="font-medium">{{ t('groups') }}</h4>
        <label v-for="c in inventory.circles" :key="c.id" class="flex items-center gap-2">
          <input
            type="checkbox"
            :checked="selected('vaults.personalLockerCircles', c.id)"
            @change="
              toggle(
                'vaults.personalLockerCircles',
                c.id,
                ($event.target as HTMLInputElement).checked,
              )
            "
          />
          {{ c.name }}
        </label>
      </div>
      <div class="overflow-x-auto">
        <h4 class="mb-2 font-medium">{{ t('users') }}</h4>
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
                  :checked="selected('vaults.personalLockerUsers', u.id)"
                  @change="
                    toggle(
                      'vaults.personalLockerUsers',
                      u.id,
                      ($event.target as HTMLInputElement).checked,
                    )
                  "
                />
              </td>
              <td class="p-2">{{ u.allowed ? t('allowed') : t('denied') }}</td>
              <td class="p-2">
                {{ u.lockers.length }} / {{ u.lockers.reduce((n, v) => n + v.entries, 0) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </fieldset>
    <p class="text-xs text-slate-500">{{ t('migration') }}</p>
  </div>
</template>
