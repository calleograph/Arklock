<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import DomainGroupLinks from './DomainGroupLinks.vue';
import GroupVaults from './GroupVaults.vue';
import IconButton from './IconButton.vue';

/**
 * Окно правки группы на одном экране: название и описание, состав (слева все сотрудники, справа участники группы),
 * группы домена и сейфы. Состав и название применяются кнопкой «Сохранить», остальное вкладками сразу.
 */
export interface GroupRow {
  id: string;
  name: string;
  description: string;
  members: number;
  directoryLinks?: number;
}
interface Person {
  id: string;
  name: string;
  email: string;
  pending?: boolean;
}
const props = defineProps<{ open: boolean; circle: GroupRow | null }>();
const emit = defineEmits<{ close: []; saved: []; changed: [] }>();
const { t } = useI18n({
  useScope: 'local',
  messages: {
    ru: {
      titleNew: 'Новая группа',
      titleEdit: 'Редактирование группы',
      name: 'Название',
      description: 'Описание',
      tabMembers: 'Состав',
      tabDomain: 'Группы домена',
      tabVaults: 'Сейфы',
      everyone: 'Сотрудники',
      everyoneFind: 'Найти сотрудника: имя или почта',
      members: 'Участники группы',
      membersFind: 'Найти в составе',
      add: 'Добавить в группу',
      remove: 'Убрать из группы',
      isNew: 'новый',
      pending: 'ждёт первого входа',
      noneFound: 'Никого не найдено.',
      noMembers: 'В группе пока никого нет.',
      more: 'Показаны первые {n} из {total}: уточните поиск.',
      directoryNote:
        'Состав связан с группой домена: сотрудник, убранный вручную, вернётся при следующей сверке с каталогом.',
      saveFirst:
        'Сначала создайте группу: связи с группами домена и сейфами настраиваются после этого.',
      save: 'Сохранить',
      create: 'Создать',
      cancel: 'Отмена',
      close: 'Закрыть',
    },
    en: {
      titleNew: 'New group',
      titleEdit: 'Edit group',
      name: 'Name',
      description: 'Description',
      tabMembers: 'Members',
      tabDomain: 'Domain groups',
      tabVaults: 'Vaults',
      everyone: 'Employees',
      everyoneFind: 'Find an employee: name or e-mail',
      members: 'Group members',
      membersFind: 'Search the members',
      add: 'Add to the group',
      remove: 'Remove from the group',
      isNew: 'new',
      pending: 'waiting for first sign-in',
      noneFound: 'Nobody found.',
      noMembers: 'Nobody in the group yet.',
      more: 'The first {n} of {total} are shown: narrow the search.',
      directoryNote:
        'The membership is linked to a domain group: a person removed by hand returns at the next directory sync.',
      saveFirst:
        'Create the group first: links with domain groups and vaults are set up after that.',
      save: 'Save',
      create: 'Create',
      cancel: 'Cancel',
      close: 'Close',
    },
  },
});

const dialog = ref<HTMLDialogElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const name = ref('');
const description = ref('');
const tab = ref<'members' | 'domain' | 'vaults'>('members');
const busy = ref(false);
const error = ref('');

// сотрудники слева (поиск на сервере), состав справа (поиск на сервере, не больше LIMIT строк)
const LIMIT = 50;
const everyone = ref<Person[]>([]);
const everyoneQuery = ref('');
const loaded = ref<Person[]>([]);
const loadedTotal = ref(0);
const membersQuery = ref('');
const staged = ref<Person[]>([]);
const removed = ref<Set<string>>(new Set());

const isNew = computed(() => !props.circle);
const memberIds = computed(
  () =>
    new Set([
      ...loaded.value.filter((m) => !removed.value.has(m.id)).map((m) => m.id),
      ...staged.value.map((m) => m.id),
    ]),
);
const shownMembers = computed(() => [
  ...staged.value
    .filter((m) => matches(m, membersQuery.value))
    .map((m) => ({ ...m, staged: true })),
  ...loaded.value.filter((m) => !removed.value.has(m.id)).map((m) => ({ ...m, staged: false })),
]);
const candidates = computed(() => everyone.value.filter((p) => !memberIds.value.has(p.id)));
const dirty = computed(
  () =>
    isNew.value ||
    name.value.trim() !== props.circle?.name ||
    description.value !== (props.circle?.description ?? '') ||
    staged.value.length > 0 ||
    removed.value.size > 0,
);
function matches(p: Person, q: string): boolean {
  const s = q.trim().toLowerCase();
  return !s || `${p.name} ${p.email}`.toLowerCase().includes(s);
}

async function loadEveryone(): Promise<void> {
  const q = encodeURIComponent(everyoneQuery.value.trim());
  const r = await api<{ items: Person[] }>(
    'GET',
    `/admin/people?limit=${LIMIT}&offset=0&status=active&q=${q}`,
  );
  everyone.value = r.items;
}
async function loadMembers(): Promise<void> {
  if (!props.circle) return;
  const q = encodeURIComponent(membersQuery.value.trim());
  const r = await api<{ items: Person[]; total: number }>(
    'GET',
    `/admin/circles/${props.circle.id}/members?limit=${LIMIT}&offset=0&q=${q}`,
  );
  loaded.value = r.items;
  loadedTotal.value = r.total;
}
const guard = (fn: () => Promise<void>) => () =>
  fn().catch((e) => (error.value = errorMessage(e, t)));
function debounced(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, 250);
  };
}
const searchEveryone = debounced(guard(loadEveryone));
const searchMembers = debounced(guard(loadMembers));
watch(everyoneQuery, searchEveryone);
watch(membersQuery, searchMembers);

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      dialog.value?.close();
      return;
    }
    name.value = props.circle?.name ?? '';
    description.value = props.circle?.description ?? '';
    tab.value = 'members';
    error.value = '';
    everyoneQuery.value = '';
    membersQuery.value = '';
    staged.value = [];
    removed.value = new Set();
    loaded.value = [];
    dialog.value?.showModal();
    await nextTick();
    nameInput.value?.focus();
    await Promise.all([guard(loadEveryone)(), guard(loadMembers)()]);
  },
  { immediate: true },
);

const stage = (p: Person) => {
  if (!staged.value.some((s) => s.id === p.id)) staged.value = [p, ...staged.value];
};
function unstage(m: Person & { staged: boolean }): void {
  if (m.staged) staged.value = staged.value.filter((s) => s.id !== m.id);
  else removed.value = new Set([...removed.value, m.id]);
}

async function save(): Promise<void> {
  if (busy.value || !name.value.trim()) return;
  busy.value = true;
  error.value = '';
  try {
    let id = props.circle?.id;
    if (!id) {
      id = (
        await api<{ id: string }>('POST', '/admin/circles', {
          name: name.value.trim(),
          description: description.value.trim(),
        })
      ).id;
    } else if (
      name.value.trim() !== props.circle!.name ||
      description.value !== props.circle!.description
    ) {
      await api('PATCH', `/admin/circles/${id}`, {
        name: name.value.trim(),
        description: description.value.trim(),
      });
    }
    if (staged.value.length || removed.value.size)
      await api('PATCH', `/admin/circles/${id}/members`, {
        add: staged.value.map((s) => s.id),
        remove: [...removed.value],
      });
    emit('saved');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    class="modal-fade m-auto w-[min(60rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-1.5rem)] overflow-visible"
    :aria-label="isNew ? t('titleNew') : t('titleEdit')"
    data-testid="group-dialog"
    @close="emit('close')"
    @cancel.prevent="emit('close')"
  >
    <form class="flex max-h-[calc(100dvh-1.5rem)] flex-col" @submit.prevent="save">
      <header
        class="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-800"
      >
        <h2 data-testid="group-dialog-title">{{ isNew ? t('titleNew') : t('titleEdit') }}</h2>
        <IconButton
          icon="x"
          :label="t('close')"
          data-testid="group-dialog-close"
          @click="emit('close')"
        />
      </header>

      <div class="space-y-4 overflow-y-auto px-5 py-4 text-sm">
        <div class="form-grid">
          <label class="block"
            >{{ t('name') }}
            <input
              ref="nameInput"
              v-model="name"
              required
              maxlength="100"
              class="input"
              data-testid="group-dialog-name"
          /></label>
          <label class="block"
            >{{ t('description') }}
            <input
              v-model="description"
              maxlength="500"
              class="input"
              data-testid="group-dialog-description"
          /></label>
        </div>

        <div
          class="flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800"
          role="tablist"
        >
          <button
            v-for="x in ['members', 'domain', 'vaults'] as const"
            :key="x"
            type="button"
            role="tab"
            class="seg"
            :class="tab === x ? 'seg-on' : ''"
            :aria-selected="tab === x"
            :data-testid="`group-tab-${x}`"
            @click="tab = x"
          >
            {{ t(x === 'members' ? 'tabMembers' : x === 'domain' ? 'tabDomain' : 'tabVaults') }}
          </button>
        </div>

        <div v-show="tab === 'members'" class="space-y-2">
          <p
            v-if="circle?.directoryLinks"
            class="text-xs text-amber-700 dark:text-amber-300"
            data-testid="group-directory-note"
          >
            {{ t('directoryNote') }}
          </p>
          <div class="grid gap-4 md:grid-cols-2">
            <section class="min-w-0 space-y-2" data-testid="group-everyone">
              <h3 class="font-medium">{{ t('everyone') }}</h3>
              <input
                v-model="everyoneQuery"
                type="search"
                class="input"
                :placeholder="t('everyoneFind')"
                :aria-label="t('everyoneFind')"
                data-testid="group-everyone-find"
              />
              <ul
                class="max-h-72 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800"
              >
                <li
                  v-for="p in candidates"
                  :key="p.id"
                  class="flex min-h-11 items-center justify-between gap-2 px-3 py-1"
                  :data-testid="`group-candidate-${p.email}`"
                >
                  <span class="min-w-0">
                    <span class="block truncate">{{ p.name }}</span>
                    <span class="block truncate text-xs text-slate-500"
                      >{{ p.email }}<span v-if="p.pending"> · {{ t('pending') }}</span></span
                    >
                  </span>
                  <IconButton
                    icon="plus"
                    :label="`${t('add')}: ${p.name}`"
                    :data-testid="`group-add-${p.email}`"
                    @click="stage(p)"
                  />
                </li>
                <li v-if="!candidates.length" class="px-3 py-3 text-slate-500">
                  {{ t('noneFound') }}
                </li>
              </ul>
            </section>
            <section class="min-w-0 space-y-2" data-testid="group-members">
              <h3 class="font-medium">{{ t('members') }} ({{ memberIds.size }})</h3>
              <input
                v-model="membersQuery"
                type="search"
                class="input"
                :placeholder="t('membersFind')"
                :aria-label="t('membersFind')"
                data-testid="group-members-find"
              />
              <ul
                class="max-h-72 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800"
              >
                <li
                  v-for="m in shownMembers"
                  :key="m.id"
                  class="flex min-h-11 items-center justify-between gap-2 px-3 py-1"
                  :data-testid="`group-member-${m.email}`"
                >
                  <span class="min-w-0">
                    <span class="block truncate"
                      >{{ m.name
                      }}<span v-if="m.staged" class="badge-brand ml-2 text-xs">{{
                        t('isNew')
                      }}</span></span
                    >
                    <span class="block truncate text-xs text-slate-500"
                      >{{ m.email }}<span v-if="m.pending"> · {{ t('pending') }}</span></span
                    >
                  </span>
                  <IconButton
                    icon="trash"
                    :label="`${t('remove')}: ${m.name}`"
                    :data-testid="`group-remove-${m.email}`"
                    @click="unstage(m)"
                  />
                </li>
                <li v-if="!shownMembers.length" class="px-3 py-3 text-slate-500">
                  {{ t('noMembers') }}
                </li>
              </ul>
              <p v-if="loadedTotal > LIMIT" class="text-xs text-slate-500">
                {{ t('more', { n: LIMIT, total: loadedTotal }) }}
              </p>
            </section>
          </div>
        </div>

        <div v-if="tab === 'domain'">
          <p v-if="!circle" class="text-slate-500">{{ t('saveFirst') }}</p>
          <DomainGroupLinks
            v-else
            :circle-id="circle.id"
            :circle-name="circle.name"
            @changed="emit('changed')"
          />
        </div>
        <div v-if="tab === 'vaults'">
          <p v-if="!circle" class="text-slate-500">{{ t('saveFirst') }}</p>
          <GroupVaults v-else :circle-id="circle.id" @changed="emit('changed')" />
        </div>

        <p v-if="error" class="text-red-600" role="alert" data-testid="group-dialog-error">
          {{ error }}
        </p>
      </div>

      <footer
        class="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800"
      >
        <button type="button" class="btn" data-testid="group-dialog-cancel" @click="emit('close')">
          {{ t('cancel') }}
        </button>
        <button
          type="submit"
          class="btn-primary"
          :disabled="busy || !name.trim() || !dirty"
          data-testid="group-dialog-save"
        >
          {{ isNew ? t('create') : t('save') }}
        </button>
      </footer>
    </form>
  </dialog>
</template>
