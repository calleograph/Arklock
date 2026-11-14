<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import GroupPicker, { type Group } from './GroupPicker.vue';
import Icon from './Icon.vue';

/** Группы сотрудника: здесь их задают и снимают, не переходя в раздел групп. Доступ к сейфам приходит через группы. */
const props = defineProps<{
  userId: string;
  groups: { id: string; name: string; adminRoleId: string | null; directory?: boolean }[];
  roleName: (id: string | null) => string | undefined;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      groups: 'Группы',
      noGroups: 'Ни в одной группе не состоит.',
      groupFind: 'Добавить в группу: название',
      remove: 'Убрать из: {name}',
      fromDirectory: 'состав ведёт каталог',
      directoryHint:
        'Группа связана с каталогом: исключённый вручную сотрудник вернётся при сверке, пока он состоит в группе домена.',
      added: 'Добавлено.',
      removed: 'Убрано.',
    },
    en: {
      groups: 'Groups',
      noGroups: 'Not a member of any group.',
      groupFind: 'Add to a group: name',
      remove: 'Remove from: {name}',
      fromDirectory: 'membership managed by the directory',
      directoryHint:
        'The group is linked to the directory: an employee removed by hand returns at the sync while they are in the domain group.',
      added: 'Added.',
      removed: 'Removed.',
    },
  },
});

const groupPick = ref<Group[]>([]);
const busy = ref(false);
const error = ref('');
const notice = ref('');

async function run(fn: () => Promise<void>, ok: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
    notice.value = ok;
    emit('changed');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
const add = (circleId: string) =>
  run(async () => {
    await api('PATCH', `/admin/circles/${circleId}/members`, { add: [props.userId] });
  }, t('added'));
const leave = (circleId: string) =>
  run(async () => {
    await api('DELETE', `/admin/circles/${circleId}/members/${props.userId}`);
  }, t('removed'));
// выбранная в поле группа сразу добавляет сотрудника, поле очищается
watch(groupPick, (v) => {
  const g = v[0];
  if (!g) return;
  groupPick.value = [];
  void add(g.id);
});
</script>

<template>
  <div class="space-y-4 lg:col-span-2" data-testid="user-memberships">
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
    <p v-if="notice" class="text-emerald-700 dark:text-emerald-300" role="status">{{ notice }}</p>

    <div class="space-y-2" data-testid="profile-group-edit">
      <h3 class="text-xs font-medium text-slate-500">{{ t('groups') }}</h3>
      <ul v-if="groups.length" class="flex flex-wrap gap-1" data-testid="profile-groups">
        <li v-for="g in groups" :key="g.id" class="badge gap-1">
          <Icon name="users" class="size-3.5" />{{ g.name
          }}<span v-if="roleName(g.adminRoleId)" class="text-brand-700"
            >· {{ roleName(g.adminRoleId) }}</span
          ><span v-if="g.directory" class="text-slate-500" :title="t('directoryHint')"
            >· {{ t('fromDirectory') }}</span
          >
          <button
            type="button"
            class="ml-1 min-h-11 min-w-11 rounded px-1 text-slate-500 hover:text-red-600"
            :disabled="busy"
            :aria-label="t('remove', { name: g.name })"
            :data-testid="`profile-group-leave-${g.name}`"
            @click="leave(g.id)"
          >
            ×
          </button>
        </li>
      </ul>
      <p v-else class="text-slate-500">{{ t('noGroups') }}</p>
      <GroupPicker v-model="groupPick" :placeholder="t('groupFind')" testid="profile-group-add" />
    </div>
  </div>
</template>
