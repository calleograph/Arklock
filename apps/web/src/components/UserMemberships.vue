<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, spaceLabel } from '../services/helpers';
import GroupPicker, { type Group } from './GroupPicker.vue';
import Icon from './Icon.vue';
import InfoHint from './InfoHint.vue';

/**
 * Принадлежность сотрудника: подразделения и группы. Здесь её задают и снимают, не переходя в разделы групп и подразделений.
 * Руководителя подразделения назначают и снимают в карточке подразделения: там же выдаются роли в сейфах отдела.
 */
const props = defineProps<{
  userId: string;
  groups: { id: string; name: string; adminRoleId: string | null; directory?: boolean }[];
  spaces: { id: string; name: string; isDefault: boolean; head?: boolean }[];
  roleName: (id: string | null) => string | undefined;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      depts: 'Подразделения',
      noDepts: 'Ни в одном подразделении не состоит.',
      head: 'руководитель',
      headFirst: 'Сначала снимите с руководства в карточке подразделения.',
      deptAdd: 'Добавить в подразделение',
      deptPick: 'Выберите подразделение',
      deptHint: 'Добавляет сотрудника в группу подразделения: он получает доступ к сейфам отдела.',
      groups: 'Группы',
      noGroups: 'Ни в одной группе не состоит.',
      groupFind: 'Добавить в группу: название',
      remove: 'Убрать из: {name}',
      fromDirectory: 'состав ведёт каталог',
      directoryHint:
        'Группа связана с каталогом: исключённый вручную сотрудник вернётся при сверке, пока он состоит в группе домена.',
      spaces: 'Другие пространства',
      added: 'Добавлено.',
      removed: 'Убрано.',
    },
    en: {
      depts: 'Departments',
      noDepts: 'Not a member of any department.',
      head: 'head',
      headFirst: 'Remove from the leadership in the department card first.',
      deptAdd: 'Add to a department',
      deptPick: 'Choose a department',
      deptHint:
        'Adds the employee to the department group: they get access to the department vaults.',
      groups: 'Groups',
      noGroups: 'Not a member of any group.',
      groupFind: 'Add to a group: name',
      remove: 'Remove from: {name}',
      fromDirectory: 'membership managed by the directory',
      directoryHint:
        'The group is linked to the directory: an employee removed by hand returns at the sync while they are in the domain group.',
      spaces: 'Other spaces',
      added: 'Added.',
      removed: 'Removed.',
    },
  },
});

interface Dept {
  spaceId: string;
  circleId: string;
  name: string;
}
const depts = ref<Dept[]>([]);
const pick = ref('');
const groupPick = ref<Group[]>([]);
const busy = ref(false);
const error = ref('');
const notice = ref('');

onMounted(async () => {
  depts.value = (
    await api<{ items: Dept[] }>('GET', '/admin/departments?limit=200').catch(() => ({ items: [] }))
  ).items;
});

const deptCircles = computed(() => new Set(depts.value.map((d) => d.circleId)));
/** Подразделения сотрудника: группа подразделения, в которой он состоит; руководитель — администратор его пространства. */
const mine = computed(() =>
  depts.value
    .filter((d) => props.groups.some((g) => g.id === d.circleId))
    .map((d) => ({ ...d, head: !!props.spaces.find((s) => s.id === d.spaceId)?.head })),
);
const free = computed(() =>
  depts.value.filter((d) => !props.groups.some((g) => g.id === d.circleId)),
);
const plainGroups = computed(() => props.groups.filter((g) => !deptCircles.value.has(g.id)));
const otherSpaces = computed(() =>
  props.spaces.filter((s) => !s.isDefault && !depts.value.some((d) => d.spaceId === s.id)),
);

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

    <div class="space-y-1.5" data-testid="profile-depts">
      <h3 class="text-xs font-medium text-slate-500">{{ t('depts') }}</h3>
      <ul v-if="mine.length" class="space-y-1">
        <li
          v-for="d in mine"
          :key="d.spaceId"
          class="flex min-h-11 items-center justify-between gap-2"
          :data-testid="`profile-dept-${d.name}`"
        >
          <span class="min-w-0"
            >{{ d.name }}<span v-if="d.head" class="badge-brand ml-2">{{ t('head') }}</span></span
          >
          <button
            type="button"
            class="btn min-w-11"
            :disabled="busy || d.head"
            :title="d.head ? t('headFirst') : undefined"
            :aria-label="t('remove', { name: d.name })"
            :data-testid="`profile-dept-leave-${d.name}`"
            @click="leave(d.circleId)"
          >
            ×
          </button>
        </li>
      </ul>
      <p v-else class="text-slate-500">{{ t('noDepts') }}</p>
      <div v-if="free.length" class="flex flex-wrap items-center gap-2">
        <select
          v-model="pick"
          class="input w-auto max-w-full"
          :aria-label="t('deptAdd')"
          data-testid="profile-dept-pick"
        >
          <option value="">{{ t('deptPick') }}</option>
          <option v-for="d in free" :key="d.spaceId" :value="d.circleId">{{ d.name }}</option>
        </select>
        <button
          type="button"
          class="btn"
          :disabled="busy || !pick"
          data-testid="profile-dept-add"
          @click="add(pick).then(() => (pick = ''))"
        >
          {{ t('deptAdd') }}
        </button>
        <InfoHint :text="t('deptHint')" />
      </div>
    </div>

    <div class="space-y-1.5" data-testid="profile-group-edit">
      <h3 class="text-xs font-medium text-slate-500">{{ t('groups') }}</h3>
      <ul v-if="plainGroups.length" class="flex flex-wrap gap-1" data-testid="profile-groups">
        <li v-for="g in plainGroups" :key="g.id" class="badge gap-1">
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

    <div v-if="otherSpaces.length" class="space-y-1.5">
      <h3 class="text-xs font-medium text-slate-500">{{ t('spaces') }}</h3>
      <ul class="flex flex-wrap gap-1" data-testid="profile-spaces">
        <li v-for="s in otherSpaces" :key="s.id" class="badge">{{ spaceLabel(s, t) }}</li>
      </ul>
    </div>
  </div>
</template>
