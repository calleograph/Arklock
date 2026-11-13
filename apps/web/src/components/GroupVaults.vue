<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage, vaultLabel, when } from '../services/helpers';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * Сейфы группы: какие сейфы открыты всем участникам группы и с какой ролью. Роль назначает администратор сейфа; та же
 * связь видна и меняется в настройках самого сейфа («Доступ групп»).
 */
const props = defineProps<{ circleId: string }>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      lead: 'Все участники группы получают в сейфе указанную роль: достаточно добавить человека в группу, и доступ появится сам.',
      none: 'Группа пока не открыта ни одному сейфу.',
      customRole: 'особая роль',
      until: 'до {date}',
      remove: 'Закрыть доступ',
      assign: 'Открыть сейф группе',
      assignRole: 'Роль в сейфе',
      pick: 'Выберите сейф',
      assigned: 'Сейф открыт группе.',
      unassigned:
        'Доступ группы к сейфу закрыт. Чтобы закрыть доступ по ранее полученным ключам, обновите ключ сейфа в его настройках.',
      roleChanged: 'Роль изменена.',
      noCandidates: 'Нет сейфов, доступ к которым вы можете выдавать.',
      roles: {
        admin: 'Администратор',
        editor: 'Редактор',
        reader: 'Читатель',
        limited: 'Ограниченный',
      },
    },
    en: {
      lead: 'Every member of the group gets the chosen role in the vault: add a person to the group and the access appears by itself.',
      none: 'The group is not open to any vault yet.',
      customRole: 'custom role',
      until: 'until {date}',
      remove: 'Close access',
      assign: 'Open a vault to the group',
      assignRole: 'Role in the vault',
      pick: 'Choose a vault',
      assigned: 'The vault is open to the group.',
      unassigned:
        'The group access to the vault is closed. To close access through previously received keys, renew the vault key in its settings.',
      roleChanged: 'Role changed.',
      noCandidates: 'There are no vaults whose access you can give.',
      roles: { admin: 'Administrator', editor: 'Editor', reader: 'Reader', limited: 'Limited' },
    },
  },
});
const ws = useWorkspaceStore();

interface GroupVault {
  id: string;
  name: string | null;
  role: string;
  customRoleId: string | null;
  expiresAt: string | null;
}
const vaults = ref<GroupVault[]>([]);
const pickVault = ref('');
const pickRole = ref('reader');
const busy = ref(false);
const error = ref('');
const notice = ref('');
const ROLES = ['admin', 'editor', 'reader', 'limited'];

const load = async (): Promise<void> => {
  vaults.value = await api<GroupVault[]>('GET', `/admin/circles/${props.circleId}/vaults`);
};
async function run(fn: () => Promise<void>, ok = ''): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
    if (ok) notice.value = ok;
    emit('changed');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  if (!ws.vaults.length) await ws.loadVaults().catch(() => undefined);
  await run(load);
});

/** Сейфы, которыми может управлять просматривающий и которые группе ещё не назначены. */
const candidates = computed(() =>
  ws.vaults.filter(
    (v) => v.kind === 'shared' && v.canManageMembers && !vaults.value.some((g) => g.id === v.id),
  ),
);
const assign = () =>
  run(async () => {
    await api('PUT', `/vaults/${pickVault.value}/circles/${props.circleId}`, {
      role: pickRole.value,
    });
    pickVault.value = '';
    await load();
  }, t('assigned'));
const setRole = (v: GroupVault, role: string) =>
  run(async () => {
    await api('PUT', `/vaults/${v.id}/circles/${props.circleId}`, { role, expiresAt: v.expiresAt });
    await load();
  }, t('roleChanged'));
const unassign = (v: GroupVault) =>
  run(async () => {
    await api('DELETE', `/vaults/${v.id}/circles/${props.circleId}`);
    await load();
  }, t('unassigned'));
</script>

<template>
  <div class="space-y-3 text-sm" data-testid="group-vaults">
    <p class="text-slate-600 dark:text-slate-300">{{ t('lead') }}</p>
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
    <p v-if="notice" class="text-emerald-700 dark:text-emerald-300" role="status">{{ notice }}</p>
    <p v-if="!vaults.length" class="text-slate-500">{{ t('none') }}</p>
    <ul v-else class="divide-y divide-slate-200 dark:divide-slate-800">
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
            {{ t('remove') }}
          </button>
        </span>
      </li>
    </ul>
    <div v-if="candidates.length" class="form-grid">
      <select
        v-model="pickVault"
        class="input"
        :aria-label="t('assign')"
        data-testid="group-vault-pick"
      >
        <option value="">{{ t('pick') }}</option>
        <option v-for="v in candidates" :key="v.id" :value="v.id">{{ vaultLabel(v, t) }}</option>
      </select>
      <select v-model="pickRole" class="input" :aria-label="t('assignRole')">
        <option v-for="r in ROLES" :key="r" :value="r">{{ t(`roles.${r}`) }}</option>
      </select>
      <div class="btn-row">
        <button
          type="button"
          class="btn-primary"
          :disabled="busy || !pickVault"
          data-testid="group-vault-assign"
          @click="assign"
        >
          {{ t('assign') }}
        </button>
      </div>
    </div>
    <p v-else class="text-xs text-slate-500">{{ t('noCandidates') }}</p>
  </div>
</template>
