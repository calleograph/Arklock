<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError, api } from '../services/api';
import { errorMessage } from '../services/helpers';
import { useAuthStore } from '../stores/auth';
import { useWorkspaceStore } from '../stores/workspace';
import DomainGroupLinks from './DomainGroupLinks.vue';
import PersonPicker, { type Person } from './PersonPicker.vue';

/**
 * Карточка подразделения: название и описание, руководители, состав, сейфы и привязка групп домена. Подразделение — это
 * пространство и группа с одним названием; здесь они меняются вместе, чтобы не разойтись.
 */
const props = defineProps<{ spaceId: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      close: 'Закрыть',
      basics: 'Основное',
      name: 'Название',
      description: 'Описание',
      save: 'Сохранить',
      renameHint:
        'Название меняется у пространства, группы и сейфов отдела вместе. Сейфы с другими названиями не затрагиваются.',
      archive: 'В архив',
      restore: 'Вернуть из архива',
      remove: 'Удалить подразделение',
      removeHint: 'Удалить можно, только если в подразделении нет сейфов.',
      confirmRemove:
        'Удалить подразделение «{name}»? Группа удалится, если она больше нигде не используется.',
      heads: 'Руководители',
      headsHint:
        'Руководитель — администратор пространства и сейфов отдела: управляет составом и доступом. Прежний руководитель при смене теряет эти роли.',
      headAdd: 'Назначить руководителя: имя, логин или почта',
      headAssign: 'Назначить',
      headRemove: 'Снять',
      headLast: 'Нельзя снять единственного руководителя: сначала назначьте другого.',
      confirmHeadRemove:
        'Снять {name} с руководства? Он останется участником отдела с ролью редактора, доступ к сейфу руководства будет закрыт.',
      confirmRotate:
        'Обновить ключ сейфа руководства «{name}»? Это закрывает доступ по ранее полученному ключу (рекомендуется).',
      members: 'Участники',
      membersCount: 'Участников: {n}',
      membersWaiting: 'ждут первого входа: {n}',
      membersFind: 'Найти в составе: имя или почта',
      membersAdd: 'Добавить участников: имя, логин или почта',
      add: 'Добавить',
      removeMember: 'Убрать: {name}',
      none: 'Участников нет.',
      pending: 'ждёт первого входа',
      prev: 'Назад',
      next: 'Вперёд',
      range: '{from}–{to} из {total}',
      directoryNote:
        'Состав связан с группой домена: убранный вручную человек вернётся при следующей сверке с каталогом. Чтобы убрать насовсем, исключите его из группы домена или отвяжите её ниже.',
      guests: 'Гости',
      guestsHint:
        'Гость — человек из другого подразделения, которому владелец выдал доступ к отдельной папке или записи. Он видит только выданное, остальной сейф ему закрыт. Гость выходит из подразделения, когда у него не остаётся доступов. Если убрать гостя здесь, его доступы к папкам и записям тоже снимаются; после этого обновите ключ сейфа в его настройках.',
      guestRemove: 'Убрать гостя: {name}',
      guestRemoved: 'Гость убран вместе с его доступами. Обновите ключ сейфа в настройках сейфа.',
      vaults: 'Сейфы отдела',
      vaultName: 'Название сейфа',
      vaultGroupRole: 'Роль группы отдела в сейфе',
      noVaults: 'Сейфов пока нет.',
      vaultRole: 'группа: {role}',
      vaultNoRole: 'группа без доступа',
      open: 'Открыть настройки',
      vaultNew: 'Название нового сейфа',
      vaultCreate: 'Создать сейф',
      roles: {
        admin: 'администратор',
        editor: 'редактор',
        reader: 'читатель',
        limited: 'ограниченный',
      },
      saved: 'Сохранено.',
      headDone: '{name} назначен руководителем.',
      headDoneKeys:
        '{name} назначен руководителем. Роль в сейфе {vault} не выдана: у вас нет доступа к этому сейфу.',
      headRemoved: '{name} больше не руководитель.',
      added: 'Добавлено: {n}.',
      err: {
        name_taken: 'Группа или подразделение с таким названием уже есть.',
        space_not_empty:
          'В подразделении есть сейфы: сначала перенесите их или архивируйте подразделение.',
      },
    },
    en: {
      close: 'Close',
      basics: 'Basics',
      name: 'Name',
      description: 'Description',
      save: 'Save',
      renameHint:
        'The name changes for the space, the group and the department vaults together. Vaults with other names are not touched.',
      archive: 'Archive',
      restore: 'Restore from archive',
      remove: 'Delete the department',
      removeHint: 'It can be deleted only when it has no vaults.',
      confirmRemove:
        'Delete the department “{name}”? The group is deleted unless it is used elsewhere.',
      heads: 'Heads',
      headsHint:
        'A head is an administrator of the space and the department vaults: manages the members and access. A former head loses these roles.',
      headAdd: 'Appoint a head: name, login or e-mail',
      headAssign: 'Appoint',
      headRemove: 'Remove',
      headLast: 'The only head cannot be removed: appoint another one first.',
      confirmHeadRemove:
        'Remove {name} from the leadership? They stay a department member as an editor; access to the leadership vault is closed.',
      confirmRotate:
        'Renew the key of the leadership vault “{name}”? This closes access through a previously received key (recommended).',
      members: 'Members',
      membersCount: 'Members: {n}',
      membersWaiting: 'waiting for first sign-in: {n}',
      membersFind: 'Search the members: name or e-mail',
      membersAdd: 'Add members: name, login or e-mail',
      add: 'Add',
      removeMember: 'Remove: {name}',
      none: 'No members.',
      pending: 'waiting for first sign-in',
      prev: 'Back',
      next: 'Next',
      range: '{from}–{to} of {total}',
      directoryNote:
        'The membership is linked to a domain group: a person removed by hand returns at the next directory sync. To remove for good, take them out of the domain group or unlink it below.',
      guests: 'Guests',
      guestsHint:
        'A guest is a person from another department to whom an owner gave access to a single folder or entry. They see only what was given; the rest of the vault stays closed. A guest leaves the department when no access remains. Removing a guest here also removes their access to folders and entries; afterwards renew the vault key in its settings.',
      guestRemove: 'Remove guest: {name}',
      guestRemoved:
        'The guest was removed together with their access. Renew the vault key in the vault settings.',
      vaults: 'Department vaults',
      vaultName: 'Vault name',
      vaultGroupRole: 'Role of the department group in the vault',
      noVaults: 'No vaults yet.',
      vaultRole: 'group: {role}',
      vaultNoRole: 'group has no access',
      open: 'Open settings',
      vaultNew: 'Name of the new vault',
      vaultCreate: 'Create vault',
      roles: { admin: 'admin', editor: 'editor', reader: 'reader', limited: 'limited' },
      saved: 'Saved.',
      headDone: '{name} is now a head.',
      headDoneKeys:
        '{name} is now a head. The role in the vault {vault} was not given: you have no access to that vault.',
      headRemoved: '{name} is no longer a head.',
      added: 'Added: {n}.',
      err: {
        name_taken: 'A group or department with this name already exists.',
        space_not_empty: 'The department has vaults: move them first or archive the department.',
      },
    },
  },
});
const ws = useWorkspaceStore();
const auth = useAuthStore();
/** Полный администратор видит всё; руководитель подразделения — свои сведения, поиск и состав без административных разделов. */
const isAdmin = computed(() => auth.user?.role === 'admin');

interface Card {
  id: string;
  circleId: string;
  name: string;
  description: string;
  archived: boolean;
  heads: { id: string; name: string; email: string; pending: boolean }[];
  guests: { id: string; name: string; email: string; pending: boolean }[];
  vaults: { id: string; name: string; role: string | null }[];
  members: number;
  waiting: number;
  directoryLinks: number;
}
interface Member {
  id: string;
  name: string;
  email: string;
  pending: boolean;
  disabled: boolean;
}
const PAGE = 20;
const card = ref<Card | null>(null);
const draft = ref({ name: '', description: '' });
const members = ref<Member[]>([]);
const total = ref(0);
const offset = ref(0);
const find = ref('');
const newHead = ref<Person[]>([]);
const newMembers = ref<Person[]>([]);
const vaultName = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');

const KNOWN = ['name_taken', 'space_not_empty'];
const fail = (e: unknown) =>
  e instanceof ApiError && KNOWN.includes(e.code) ? t(`err.${e.code}`) : errorMessage(e, t);

async function loadCard(): Promise<void> {
  card.value = await api<Card>('GET', `/admin/departments/${props.spaceId}`);
  draft.value = { name: card.value.name, description: card.value.description };
}
async function loadMembers(): Promise<void> {
  if (!card.value) return;
  const r = await api<{ items: Member[]; total: number }>(
    'GET',
    `/admin/departments/${props.spaceId}/members?limit=${PAGE}&offset=${offset.value}&q=${encodeURIComponent(find.value.trim())}`,
  );
  members.value = r.items;
  total.value = r.total;
}
async function reload(): Promise<void> {
  await loadCard();
  await loadMembers();
}
async function run(fn: () => Promise<void>, ok = ''): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
    if (ok) notice.value = ok;
  } catch (e) {
    error.value = fail(e);
  } finally {
    busy.value = false;
  }
}
onMounted(() => run(async () => (await ws.loadVaults().catch(() => undefined), await reload())));
let timer: ReturnType<typeof setTimeout> | undefined;
watch(find, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    offset.value = 0;
    void loadMembers().catch((e) => (error.value = fail(e)));
  }, 250);
});

const save = () =>
  run(async () => {
    await api('PATCH', `/admin/departments/${props.spaceId}`, draft.value);
    await ws.loadVaults().catch(() => undefined);
    await reload();
    emit('changed');
  }, t('saved'));
const archive = () =>
  run(async () => {
    await api('PATCH', `/spaces/${props.spaceId}`, { archived: !card.value?.archived });
    await reload();
    emit('changed');
  });
const remove = () => {
  if (!card.value || !window.confirm(t('confirmRemove', { name: card.value.name }))) return;
  return run(async () => {
    await api('DELETE', `/admin/departments/${props.spaceId}`);
    emit('changed');
    emit('close');
  });
};

/** Запись человека с ключами: нужна, чтобы выдать роль в сейфе (профиль без входа получает роль без ключа). */
async function keyRecord(p: { id: string; email: string }) {
  const list = await api<{ id: string; publicKey: string; signPublicKey: string }[]>(
    'GET',
    `/directory/users?q=${encodeURIComponent(p.email)}`,
  );
  return list.find((u) => u.id === p.id);
}
const isLead = (name: string) => name.startsWith(`${card.value?.name} · `);

/** Руководитель: администратор пространства, участник группы и администратор сейфов отдела. */
const assignHead = (p: Person) =>
  run(async () => {
    const c = card.value!;
    await api('PUT', `/spaces/${props.spaceId}/users/${p.id}`, { role: 'admin' });
    await api('PATCH', `/admin/departments/${props.spaceId}/members`, { add: [p.id] });
    const rec = await keyRecord(p);
    let missed = '';
    for (const v of c.vaults)
      try {
        if (rec) await ws.addMember(v.id, rec, 'admin');
      } catch {
        missed ||= v.name;
      }
    newHead.value = [];
    await reload();
    emit('changed');
    notice.value = missed
      ? t('headDoneKeys', { name: p.name, vault: missed })
      : t('headDone', { name: p.name });
  });

/** Снятие с руководства: роль в пространстве — участник, в сейфах отдела — редактор, в сейфе руководства доступ закрывается. */
const removeHead = (h: Card['heads'][number]) => {
  if (!window.confirm(t('confirmHeadRemove', { name: h.name }))) return;
  return run(async () => {
    const c = card.value!;
    await api('PUT', `/spaces/${props.spaceId}/users/${h.id}`, { role: 'member' });
    for (const v of c.vaults)
      try {
        const mine = (await ws.members(v.id)).members.find((m) => m.userId === h.id);
        if (mine?.directRole !== 'admin') continue;
        if (isLead(v.name)) {
          await api('DELETE', `/vaults/${v.id}/members/${h.id}`);
          if (window.confirm(t('confirmRotate', { name: v.name }))) await ws.rotate(v.id);
        } else await api('PUT', `/vaults/${v.id}/members/${h.id}`, { role: 'editor' });
      } catch {
        /* нет права на этот сейф: роль в нём меняет его администратор */
      }
    await reload();
    emit('changed');
    notice.value = t('headRemoved', { name: h.name });
  });
};

const addMembers = () =>
  run(async () => {
    const ids = newMembers.value.map((p) => p.id);
    await api('PATCH', `/admin/departments/${props.spaceId}/members`, { add: ids });
    newMembers.value = [];
    await reload();
    emit('changed');
    notice.value = t('added', { n: ids.length });
  });
const removeGuest = (g: Card['guests'][number]) =>
  run(async () => {
    await api('DELETE', `/admin/departments/${props.spaceId}/guests/${g.id}`);
    await reload();
    notice.value = t('guestRemoved');
  });
const removeMember = (m: Member) =>
  run(async () => {
    await api('PATCH', `/admin/departments/${props.spaceId}/members`, { remove: [m.id] });
    await reload();
    emit('changed');
  });
const page = (d: number) => {
  offset.value = Math.max(0, offset.value + d * PAGE);
  void loadMembers().catch((e) => (error.value = fail(e)));
};

const createVault = () =>
  run(async () => {
    const c = card.value!;
    const id = await ws.createVault(vaultName.value.trim(), {
      spaceId: props.spaceId,
      select: false,
    });
    await api('PUT', `/vaults/${id}/circles/${c.circleId}`, { role: 'editor' });
    vaultName.value = '';
    await reload();
    emit('changed');
  });
const vaultDraft = ref<Record<string, { name?: string; role?: string }>>({});
const draftOf = (v: Card['vaults'][number]) => (vaultDraft.value[v.id] ??= {});
const vaultChanged = (v: Card['vaults'][number]) => {
  const d = vaultDraft.value[v.id];
  return (
    !!d &&
    ((d.name !== undefined && d.name.trim() !== v.name) ||
      (d.role !== undefined && d.role !== '' && d.role !== v.role))
  );
};
const saveVault = (v: Card['vaults'][number]) =>
  run(async () => {
    const d = vaultDraft.value[v.id] ?? {};
    await api('PATCH', `/admin/departments/${props.spaceId}/vaults/${v.id}`, {
      ...(d.name !== undefined && d.name.trim() !== v.name ? { name: d.name.trim() } : {}),
      ...(d.role && d.role !== v.role ? { role: d.role } : {}),
    });
    delete vaultDraft.value[v.id];
    await ws.loadVaults().catch(() => undefined);
    await reload();
    emit('changed');
  }, t('saved'));
const lastHead = computed(() => (card.value?.heads.length ?? 0) <= 1);
const memberIds = computed(() => members.value.map((m) => m.id));
</script>

<template>
  <section class="card space-y-6 p-4 text-sm" data-testid="dept-detail">
    <header class="flex flex-wrap items-start justify-between gap-2">
      <h3 class="text-base font-semibold" data-testid="dept-detail-title">
        {{ card?.name ?? '…' }}
      </h3>
      <button type="button" class="btn" data-testid="dept-detail-close" @click="emit('close')">
        {{ t('close') }}
      </button>
    </header>
    <p v-if="error" class="text-red-600" role="alert" data-testid="dept-detail-error">
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="text-emerald-700 dark:text-emerald-300"
      role="status"
      data-testid="dept-detail-notice"
    >
      {{ notice }}
    </p>

    <template v-if="card">
      <form class="space-y-2" @submit.prevent="save">
        <h4 class="font-medium">
          {{ t('basics') }}<InfoHint class="ml-1" :text="t('renameHint')" />
        </h4>
        <div class="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          <label class="block"
            ><span class="field-label">{{ t('name') }}</span
            ><input
              v-model="draft.name"
              required
              maxlength="100"
              class="input"
              data-testid="dept-edit-name"
          /></label>
          <label class="block"
            ><span class="field-label">{{ t('description') }}</span
            ><input
              v-model="draft.description"
              maxlength="500"
              class="input"
              data-testid="dept-edit-description"
          /></label>
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="submit" class="btn-primary" :disabled="busy" data-testid="dept-edit-save">
            {{ t('save') }}
          </button>
          <button type="button" class="btn" :disabled="busy" @click="archive">
            {{ card.archived ? t('restore') : t('archive') }}
          </button>
          <button
            type="button"
            class="btn-danger"
            :disabled="busy || card.vaults.length > 0"
            :title="t('removeHint')"
            data-testid="dept-edit-delete"
            @click="remove"
          >
            {{ t('remove') }}
          </button>
        </div>
      </form>

      <div class="space-y-2" data-testid="dept-heads">
        <h4 class="font-medium">
          {{ t('heads') }}<InfoHint class="ml-1" :text="t('headsHint')" />
        </h4>
        <ul class="space-y-1">
          <li
            v-for="h in card.heads"
            :key="h.id"
            class="flex min-h-11 flex-wrap items-center justify-between gap-2"
            :data-testid="`dept-head-row-${h.email}`"
          >
            <span class="min-w-0"
              >{{ h.name }} <span class="text-xs text-slate-500">{{ h.email }}</span
              ><span v-if="h.pending" class="text-xs text-slate-500">
                · {{ t('pending') }}</span
              ></span
            >
            <button
              type="button"
              class="btn"
              :disabled="busy || lastHead"
              :title="lastHead ? t('headLast') : undefined"
              :data-testid="`dept-head-remove-${h.email}`"
              @click="removeHead(h)"
            >
              {{ t('headRemove') }}
            </button>
          </li>
        </ul>
        <PersonPicker
          v-model="newHead"
          :light="!isAdmin"
          :placeholder="t('headAdd')"
          :exclude="card.heads.map((h) => h.id)"
          testid="dept-newhead"
        />
        <button
          type="button"
          class="btn"
          :disabled="busy || !newHead.length"
          data-testid="dept-head-assign"
          @click="assignHead(newHead[0]!)"
        >
          {{ t('headAssign') }}
        </button>
      </div>

      <div class="space-y-2" data-testid="dept-members">
        <h4 class="font-medium">{{ t('members') }}</h4>
        <p class="text-xs text-slate-500">
          {{ t('membersCount', { n: card.members })
          }}<span v-if="card.waiting"> · {{ t('membersWaiting', { n: card.waiting }) }}</span>
        </p>
        <p
          v-if="card.directoryLinks"
          class="max-w-prose text-xs text-amber-700 dark:text-amber-300"
        >
          {{ t('directoryNote') }}
        </p>
        <input
          v-model="find"
          type="search"
          class="input"
          :placeholder="t('membersFind')"
          :aria-label="t('membersFind')"
          data-testid="dept-members-find"
        />
        <ul v-if="members.length" class="divide-y divide-slate-200 dark:divide-slate-800">
          <li
            v-for="m in members"
            :key="m.id"
            class="flex min-h-11 flex-wrap items-center justify-between gap-2"
            :data-testid="`dept-member-row-${m.email}`"
          >
            <span class="min-w-0"
              >{{ m.name }} <span class="text-xs text-slate-500">{{ m.email }}</span
              ><span v-if="m.pending" class="text-xs text-slate-500">
                · {{ t('pending') }}</span
              ></span
            >
            <button
              type="button"
              class="btn min-w-11"
              :disabled="busy"
              :aria-label="t('removeMember', { name: m.name })"
              :data-testid="`dept-member-remove-${m.email}`"
              @click="removeMember(m)"
            >
              ×
            </button>
          </li>
        </ul>
        <p v-else class="text-slate-500">{{ t('none') }}</p>
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
        <PersonPicker
          v-model="newMembers"
          :light="!isAdmin"
          multiple
          :exclude="memberIds"
          :placeholder="t('membersAdd')"
          testid="dept-newmember"
        />
        <button
          type="button"
          class="btn"
          :disabled="busy || !newMembers.length"
          data-testid="dept-members-add"
          @click="addMembers"
        >
          {{ t('add') }}<span v-if="newMembers.length"> ({{ newMembers.length }})</span>
        </button>
        <DomainGroupLinks
          v-if="isAdmin"
          :circle-id="card.circleId"
          :circle-name="card.name"
          @changed="reload"
        />
      </div>

      <div v-if="card.guests.length" class="space-y-2" data-testid="dept-guests">
        <h4 class="font-medium">
          {{ t('guests') }}<InfoHint class="ml-1" :text="t('guestsHint')" />
        </h4>
        <ul class="divide-y divide-slate-200 dark:divide-slate-800">
          <li
            v-for="g in card.guests"
            :key="g.id"
            class="flex min-h-11 flex-wrap items-center justify-between gap-2"
            :data-testid="`dept-guest-row-${g.email}`"
          >
            <span class="min-w-0"
              >{{ g.name }} <span class="text-xs text-slate-500">{{ g.email }}</span></span
            >
            <button
              type="button"
              class="btn min-w-11"
              :disabled="busy"
              :aria-label="t('guestRemove', { name: g.name })"
              @click="removeGuest(g)"
            >
              ×
            </button>
          </li>
        </ul>
      </div>

      <div class="space-y-2" data-testid="dept-vaults">
        <h4 class="font-medium">{{ t('vaults') }}</h4>
        <p v-if="!card.vaults.length" class="text-slate-500">{{ t('noVaults') }}</p>
        <ul v-else class="divide-y divide-slate-200 dark:divide-slate-800">
          <li
            v-for="v in card.vaults"
            :key="v.id"
            class="grid items-end gap-x-3 gap-y-2 py-2 sm:grid-cols-[1fr_12rem_auto_auto]"
            :data-testid="`dept-vault-row-${v.id}`"
          >
            <label class="block"
              >{{ t('vaultName') }}
              <input
                :value="vaultDraft[v.id]?.name ?? v.name"
                maxlength="100"
                class="input"
                :data-testid="`dept-vault-name-${v.id}`"
                @input="draftOf(v).name = ($event.target as HTMLInputElement).value"
              />
            </label>
            <label class="block"
              >{{ t('vaultGroupRole') }}
              <select
                :value="vaultDraft[v.id]?.role ?? v.role ?? ''"
                class="input"
                :data-testid="`dept-vault-role-${v.id}`"
                @change="draftOf(v).role = ($event.target as HTMLSelectElement).value"
              >
                <option v-if="!v.role" value="">{{ t('vaultNoRole') }}</option>
                <option v-for="r in ['admin', 'editor', 'reader', 'limited']" :key="r" :value="r">
                  {{ t(`roles.${r}`) }}
                </option>
              </select>
            </label>
            <button
              type="button"
              class="btn-primary"
              :disabled="busy || !vaultChanged(v)"
              :data-testid="`dept-vault-save-${v.id}`"
              @click="saveVault(v)"
            >
              {{ t('save') }}
            </button>
            <RouterLink :to="`/vault/${v.id}/settings`" class="btn">{{ t('open') }}</RouterLink>
          </li>
        </ul>
        <div class="flex flex-wrap gap-2">
          <input
            v-model="vaultName"
            maxlength="100"
            class="input max-w-xs"
            :placeholder="t('vaultNew')"
            :aria-label="t('vaultNew')"
            data-testid="dept-vault-name"
          />
          <button
            type="button"
            class="btn"
            :disabled="busy || !vaultName.trim()"
            data-testid="dept-vault-create"
            @click="createVault"
          >
            {{ t('vaultCreate') }}
          </button>
        </div>
      </div>
    </template>
  </section>
</template>
