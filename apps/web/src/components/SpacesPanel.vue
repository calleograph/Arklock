<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SpaceInfo } from '@arklock/contracts';
import { api, ApiError } from '../services/api';
import { errorMessage, spaceLabel, vaultLabel } from '../services/helpers';
import { useAuthStore } from '../stores/auth';

const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      spaces: {
        title: 'Корпоративные пространства',
        create: 'Создать пространство',
        name: 'Название',
        description: 'Описание',
        public: 'Доступно всей организации',
        hint: 'Пространство ограничивает доступ к сейфам. Членство и административная роль не выдают ключи и права на содержимое сейфов.',
        private: 'Закрытое',
        archived: 'Архивировано',
        archive: 'Архивировать',
        restore: 'Вернуть из архива',
        remove: 'Удалить',
        confirm: 'Удалить пустое пространство?',
        members: 'Пользователи',
        groups: 'Группы',
        member: 'Участник',
        admin: 'Администратор пространства',
        find: 'Найти пользователя (имя или почта)',
        search: 'Найти',
        add: 'Добавить',
        vaults: 'Сейфы пространства',
        move: 'Перенести',
        empty: 'В этом пространстве пока нет сейфов.',
        archiveHint:
          'Архивирование блокирует использование сейфов и сохраняет зашифрованные данные и ключи. Ранее полученные копии ключей и секретов отозвать невозможно.',
        notEmpty: 'Пространство содержит сейфы. Перенесите их или используйте архивирование.',
        default: 'Основное пространство всегда открыто организации.',
      },
    },
    en: {
      spaces: {
        title: 'Corporate spaces',
        create: 'Create space',
        name: 'Name',
        description: 'Description',
        public: 'Open to the whole organization',
        hint: 'A space scopes vault access. Membership and administrative roles do not grant vault keys or access to their content.',
        private: 'Private',
        archived: 'Archived',
        archive: 'Archive',
        restore: 'Unarchive',
        remove: 'Delete',
        confirm: 'Delete this empty space?',
        members: 'Users',
        groups: 'Groups',
        member: 'Member',
        admin: 'Space administrator',
        find: 'Find a user by name or email',
        search: 'Search',
        add: 'Add',
        vaults: 'Space vaults',
        move: 'Move',
        empty: 'No vaults in this space yet.',
        archiveHint:
          'Archiving blocks vault use and preserves encrypted data and keys. Previously obtained copies of keys and secrets cannot be recalled.',
        notEmpty: 'This space contains vaults. Move them or archive the space.',
        default: 'The default space remains open to the organization.',
      },
    },
  },
});
const auth = useAuthStore();
interface Detail extends SpaceInfo {
  members: { userId: string; name: string; email: string; role: 'member' | 'admin' }[];
  circles: { circleId: string; name: string; role: 'member' | 'admin' }[];
  vaults: { id: string; name: string | null }[];
}
const spaces = ref<SpaceInfo[]>([]);
const selected = ref('');
const detail = ref<Detail | null>(null);
const form = ref({ name: '', description: '', publicToOrg: false });
const circles = ref<{ id: string; name: string }[]>([]);
const query = ref('');
const results = ref<{ id: string; name: string; email: string }[]>([]);
const userId = ref('');
const circleId = ref('');
const userRole = ref<'member' | 'admin'>('member');
const circleRole = ref<'member' | 'admin'>('member');
const moveTargets = ref<Record<string, string>>({});
const busy = ref(false);
const error = ref('');
async function choose(id: string): Promise<void> {
  selected.value = id;
  detail.value = null;
  detail.value = id ? await api<Detail>('GET', `/spaces/${id}`) : null;
  form.value = detail.value
    ? {
        name: detail.value.name,
        description: detail.value.description,
        publicToOrg: detail.value.publicToOrg,
      }
    : { name: '', description: '', publicToOrg: false };
  results.value = [];
  userId.value = '';
  query.value = '';
  moveTargets.value = {};
}
async function load(): Promise<void> {
  [spaces.value, circles.value] = await Promise.all([
    api<SpaceInfo[]>('GET', '/spaces?manage=1'),
    api<typeof circles.value>('GET', '/directory/circles').catch(() => []),
  ]);
  await choose(
    spaces.value.some((s) => s.id === selected.value)
      ? selected.value
      : (spaces.value[0]?.id ?? ''),
  );
}
async function run(operation: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await operation();
  } catch (e) {
    error.value =
      e instanceof ApiError && e.code === 'space_not_empty'
        ? t('spaces.notEmpty')
        : errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
async function changed(): Promise<void> {
  await load();
  emit('changed');
}
const save = () =>
  run(async () => {
    if (detail.value) await api('PATCH', `/spaces/${detail.value.id}`, form.value);
    else selected.value = (await api<{ id: string }>('POST', '/spaces', form.value)).id;
    await changed();
  });
const archive = () =>
  run(async () => {
    await api('PATCH', `/spaces/${selected.value}`, { archived: !detail.value?.archived });
    await changed();
  });
const remove = () =>
  window.confirm(t('spaces.confirm')) &&
  run(async () => {
    await api('DELETE', `/spaces/${selected.value}`);
    await changed();
  });
const find = () =>
  run(async () => {
    results.value = await api('GET', `/directory/users?q=${encodeURIComponent(query.value)}`);
    userId.value = results.value[0]?.id ?? '';
  });
const putMember = (kind: 'users' | 'circles', id: string, role: string) =>
  run(async () => {
    await api('PUT', `/spaces/${selected.value}/${kind}/${id}`, { role });
    await changed();
  });
const removeMember = (kind: 'users' | 'circles', id: string) =>
  run(async () => {
    await api('DELETE', `/spaces/${selected.value}/${kind}/${id}`);
    await changed();
  });
const move = (vaultId: string) =>
  run(async () => {
    await api('PUT', `/spaces/${selected.value}/vaults/${vaultId}`, {
      targetSpaceId: moveTargets.value[vaultId],
    });
    await changed();
  });
onMounted(() => run(load));
</script>

<template>
  <section class="card space-y-4 p-4" data-testid="spaces-panel">
    <h2 class="font-semibold">{{ t('spaces.title') }}</h2>
    <p class="text-sm text-slate-500">{{ t('spaces.hint') }}</p>
    <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
    <div class="flex flex-wrap gap-2">
      <select
        :value="selected"
        class="input max-w-xs"
        :disabled="busy"
        :aria-label="t('spaces.title')"
        @change="run(() => choose(($event.target as HTMLSelectElement).value))"
      >
        <option v-if="!detail" value="">{{ t('spaces.create') }}</option>
        <option v-for="s in spaces" :key="s.id" :value="s.id">
          {{ spaceLabel(s, t) }}{{ s.archived ? ` (${t('spaces.archived')})` : '' }}
        </option>
      </select>
      <button
        v-if="auth.user?.role === 'admin'"
        type="button"
        class="btn"
        :disabled="busy"
        data-testid="space-new"
        @click="choose('')"
      >
        {{ t('spaces.create') }}
      </button>
    </div>
    <form v-if="detail || auth.user?.role === 'admin'" class="space-y-3" @submit.prevent="save">
      <fieldset class="space-y-3" :disabled="busy || (!!detail && !detail.canManage)">
        <label class="block text-sm"
          >{{ t('spaces.name')
          }}<input
            v-model="form.name"
            required
            maxlength="100"
            class="input"
            data-testid="space-name"
        /></label>
        <label class="block text-sm"
          >{{ t('spaces.description')
          }}<textarea v-model="form.description" maxlength="2000" rows="2" class="input" />
        </label>
        <label class="flex items-center gap-2 text-sm"
          ><input
            v-model="form.publicToOrg"
            type="checkbox"
            :disabled="detail?.isDefault"
            data-testid="space-public"
          />{{ t('spaces.public') }}</label
        >
        <button
          v-if="!detail || detail.canManage"
          class="btn-primary"
          type="submit"
          data-testid="space-save"
        >
          {{ t('common.save') }}
        </button>
      </fieldset>
    </form>
    <template v-if="detail">
      <p v-if="detail.isDefault" class="text-xs text-slate-500">{{ t('spaces.default') }}</p>
      <p class="text-xs text-slate-500">{{ t('spaces.archiveHint') }}</p>
      <div v-if="detail.canManage && !detail.isDefault" class="flex gap-2">
        <button
          type="button"
          class="btn"
          :disabled="busy"
          data-testid="space-archive"
          @click="archive"
        >
          {{ t(detail.archived ? 'spaces.restore' : 'spaces.archive') }}
        </button>
        <button type="button" class="btn" :disabled="busy" @click="remove">
          {{ t('spaces.remove') }}
        </button>
      </div>
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="space-y-2">
          <h3 class="text-sm font-medium">{{ t('spaces.members') }}</h3>
          <div
            v-for="u in detail.members"
            :key="u.userId"
            class="flex flex-wrap items-center gap-2 text-sm"
          >
            <span class="min-w-32 flex-1"
              >{{ u.name }} <span class="text-xs text-slate-500">{{ u.email }}</span></span
            >
            <select
              :value="u.role"
              class="input w-44"
              :disabled="busy || !detail.canManage"
              :aria-label="u.name"
              @change="putMember('users', u.userId, ($event.target as HTMLSelectElement).value)"
            >
              <option value="member">{{ t('spaces.member') }}</option>
              <option value="admin">{{ t('spaces.admin') }}</option>
            </select>
            <button
              v-if="detail.canManage"
              type="button"
              class="btn"
              :disabled="busy"
              @click="removeMember('users', u.userId)"
            >
              {{ t('spaces.remove') }}
            </button>
          </div>
          <template v-if="detail.canManage">
            <form class="flex gap-2" @submit.prevent="find">
              <input
                v-model="query"
                class="input"
                minlength="2"
                required
                :placeholder="t('spaces.find')"
              /><button type="submit" class="btn" :disabled="busy">{{ t('spaces.search') }}</button>
            </form>
            <div v-if="results.length" class="flex flex-wrap gap-2">
              <select v-model="userId" class="input flex-1">
                <option v-for="u in results" :key="u.id" :value="u.id">
                  {{ u.name }} ({{ u.email }})
                </option></select
              ><select v-model="userRole" class="input w-44">
                <option value="member">{{ t('spaces.member') }}</option>
                <option value="admin">{{ t('spaces.admin') }}</option></select
              ><button
                type="button"
                class="btn"
                :disabled="busy || !userId"
                @click="putMember('users', userId, userRole)"
              >
                {{ t('spaces.add') }}
              </button>
            </div>
          </template>
        </div>
        <div class="space-y-2">
          <h3 class="text-sm font-medium">{{ t('spaces.groups') }}</h3>
          <div
            v-for="c in detail.circles"
            :key="c.circleId"
            class="flex flex-wrap items-center gap-2 text-sm"
          >
            <span class="flex-1">{{ c.name }}</span
            ><select
              :value="c.role"
              class="input w-44"
              :disabled="busy || !detail.canManage"
              :aria-label="c.name"
              @change="putMember('circles', c.circleId, ($event.target as HTMLSelectElement).value)"
            >
              <option value="member">{{ t('spaces.member') }}</option>
              <option value="admin">{{ t('spaces.admin') }}</option></select
            ><button
              v-if="detail.canManage"
              type="button"
              class="btn"
              :disabled="busy"
              @click="removeMember('circles', c.circleId)"
            >
              {{ t('spaces.remove') }}
            </button>
          </div>
          <div v-if="detail.canManage" class="flex flex-wrap gap-2">
            <select v-model="circleId" class="input flex-1" :aria-label="t('spaces.groups')">
              <option disabled value="">{{ t('spaces.groups') }}</option>
              <option v-for="c in circles" :key="c.id" :value="c.id">{{ c.name }}</option></select
            ><select v-model="circleRole" class="input w-44">
              <option value="member">{{ t('spaces.member') }}</option>
              <option value="admin">{{ t('spaces.admin') }}</option></select
            ><button
              type="button"
              class="btn"
              :disabled="busy || !circleId"
              @click="putMember('circles', circleId, circleRole)"
            >
              {{ t('spaces.add') }}
            </button>
          </div>
        </div>
      </div>
      <div v-if="detail.canManage" class="space-y-2">
        <h3 class="text-sm font-medium">{{ t('spaces.vaults') }}</h3>
        <p v-if="!detail.vaults.length" class="text-sm text-slate-500">{{ t('spaces.empty') }}</p>
        <div
          v-for="v in detail.vaults"
          :key="v.id"
          class="flex flex-wrap items-center gap-2 text-sm"
        >
          <span class="flex-1">{{ vaultLabel(v, t) }}</span
          ><select
            v-model="moveTargets[v.id]"
            class="input max-w-xs"
            :aria-label="t('spaces.move')"
          >
            <option
              v-for="s in spaces.filter((x) => x.canManage && !x.archived && x.id !== detail?.id)"
              :key="s.id"
              :value="s.id"
            >
              {{ spaceLabel(s, t) }}
            </option></select
          ><button
            type="button"
            class="btn"
            :disabled="busy || !moveTargets[v.id]"
            @click="move(v.id)"
          >
            {{ t('spaces.move') }}
          </button>
        </div>
      </div>
    </template>
  </section>
</template>
