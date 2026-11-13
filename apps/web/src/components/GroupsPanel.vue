<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import GroupEditDialog, { type GroupRow } from './GroupEditDialog.vue';
import GroupsExplainer from './GroupsExplainer.vue';
import Icon from './Icon.vue';
import IconButton from './IconButton.vue';
import InfoHint from './InfoHint.vue';

/**
 * Группы одним экраном: таблица (название, число участников, действия) и окно правки. Ручка открывает правку состава,
 * корзина удаляет группу. Привязка групп домена и сейфов — во вкладках того же окна.
 */
const props = defineProps<{
  circles: (GroupRow & { adminRoleId?: string | null })[];
  adminRoles: { id: string; name: string }[];
  full: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      find: 'Найти группу',
      add: 'Добавить',
      name: 'Название',
      users: 'Участников',
      role: 'Роль администратора',
      roleHint:
        'Участники группы получают выбранную административную роль: так можно выдавать права по группе, а не по одному человеку.',
      noRole: 'Нет',
      edit: 'Изменить группу',
      remove: 'Удалить группу',
      confirmDelete:
        'Удалить группу «{name}»? Участники останутся, но потеряют доступ, который получали через эту группу.',
      none: 'Групп пока нет. Нажмите «Добавить».',
      noMatch: 'Ничего не найдено.',
    },
    en: {
      find: 'Find a group',
      add: 'Add',
      name: 'Name',
      users: 'Members',
      role: 'Administrator role',
      roleHint:
        'Members of the group get the chosen administrative role: rights are given by the group, not one person at a time.',
      noRole: 'None',
      edit: 'Edit the group',
      remove: 'Delete the group',
      confirmDelete:
        'Delete the group “{name}”? The people stay but lose the access they got through this group.',
      none: 'No groups yet. Press “Add”.',
      noMatch: 'Nothing found.',
    },
  },
});

const search = ref('');
const editing = ref<GroupRow | null>(null);
const dialogOpen = ref(false);
const error = ref('');
const roles = computed(() => props.full && props.adminRoles.length > 0);
const visible = computed(() =>
  props.circles.filter((c) =>
    `${c.name} ${c.description}`.toLowerCase().includes(search.value.trim().toLowerCase()),
  ),
);
const columns = computed(() =>
  roles.value
    ? 'sm:grid-cols-[minmax(0,1fr)_7rem_14rem_5.5rem]'
    : 'sm:grid-cols-[minmax(0,1fr)_7rem_5.5rem]',
);

function open(c: GroupRow | null): void {
  editing.value = c;
  dialogOpen.value = true;
}
async function remove(c: GroupRow): Promise<void> {
  if (!window.confirm(t('confirmDelete', { name: c.name }))) return;
  error.value = '';
  try {
    await api('DELETE', `/admin/circles/${c.id}`);
    emit('changed');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
async function setRole(c: GroupRow, value: string): Promise<void> {
  error.value = '';
  try {
    await api('PATCH', `/admin/circles/${c.id}`, { adminRoleId: value || null });
    emit('changed');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
/** «Сохранить» закрывает окно; связи с доменом и сейфами применяются сразу и окно не закрывают. */
function savedAndClose(): void {
  emit('changed');
  dialogOpen.value = false;
}
</script>

<template>
  <div class="space-y-3" data-testid="groups-panel">
    <GroupsExplainer />
    <div class="grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <input
        v-model="search"
        type="search"
        class="input"
        :aria-label="t('find')"
        :placeholder="t('find')"
        data-testid="admin-group-search"
      />
      <button type="button" class="btn-primary" data-testid="circle-add" @click="open(null)">
        <Icon name="plus" /> {{ t('add') }}
      </button>
    </div>
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>

    <div class="card overflow-hidden text-sm" data-testid="circles-list">
      <div
        class="hidden items-center gap-x-4 border-b border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 sm:grid"
        :class="columns"
        aria-hidden="true"
      >
        <span>{{ t('name') }}</span>
        <span>{{ t('users') }}</span>
        <span v-if="roles" class="inline-flex items-center gap-1"
          >{{ t('role') }}<InfoHint :text="t('roleHint')"
        /></span>
        <span />
      </div>
      <ul class="divide-y divide-slate-200 dark:divide-slate-800">
        <li
          v-for="c in visible"
          :key="c.id"
          class="grid min-h-12 grid-cols-1 items-center gap-x-4 gap-y-1 px-4 py-1"
          :class="columns"
          :data-testid="`circle-row-${c.name}`"
        >
          <button
            type="button"
            class="flex min-h-11 min-w-0 items-center gap-2 text-left font-medium sm:min-h-9"
            :data-testid="`circle-${c.name}`"
            @click="open(c)"
          >
            <Icon name="users" class="text-slate-400" /><span class="truncate">{{ c.name }}</span>
          </button>
          <span class="text-slate-600 dark:text-slate-300">{{ c.members }}</span>
          <select
            v-if="roles"
            :value="c.adminRoleId ?? ''"
            class="input"
            :aria-label="`${t('role')}: ${c.name}`"
            :data-testid="`circle-admin-role-${c.name}`"
            @change="setRole(c, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('noRole') }}</option>
            <option v-for="r in adminRoles" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
          <span class="flex items-center gap-1 sm:justify-end">
            <IconButton
              icon="edit"
              :label="`${t('edit')}: ${c.name}`"
              :data-testid="`circle-edit-${c.name}`"
              @click="open(c)"
            />
            <IconButton
              icon="trash"
              :label="`${t('remove')}: ${c.name}`"
              :data-testid="`circle-delete-${c.name}`"
              @click="remove(c)"
            />
          </span>
        </li>
        <li v-if="!visible.length" class="px-4 py-4 text-slate-500">
          {{ circles.length ? t('noMatch') : t('none') }}
        </li>
      </ul>
    </div>

    <GroupEditDialog
      :open="dialogOpen"
      :circle="editing"
      @close="dialogOpen = false"
      @saved="savedAndClose"
      @changed="emit('changed')"
    />
  </div>
</template>
