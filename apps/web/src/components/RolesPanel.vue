<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';

const { t } = useI18n();

interface Role {
  id: string;
  name: string;
  description: string;
  scope: 'vault' | 'admin';
  allow: string[];
  deny: string[];
  parents: string[];
}
interface Listing {
  roles: Role[];
  vaultPermissions: string[];
  adminPermissions: string[];
}

const data = ref<Listing>({ roles: [], vaultPermissions: [], adminPermissions: [] });
const error = ref('');
const notice = ref('');
const busy = ref(false);
const effective = ref<Record<string, string[]>>({});

/** Редактируемая роль; id пуст у новой. */
const form = ref<(Omit<Role, 'id'> & { id: string }) | null>(null);

const perms = computed(() =>
  form.value?.scope === 'admin' ? data.value.adminPermissions : data.value.vaultPermissions,
);
const parentChoices = computed(() =>
  data.value.roles.filter((r) => r.scope === form.value?.scope && r.id !== form.value?.id),
);
const permLabel = (p: string) => t(`roles.perm.${p.replace('.', '_')}`);
const nameOf = (id: string) => data.value.roles.find((r) => r.id === id)?.name ?? id;
/** Сколько прав видно в таблице сразу; остальные раскрываются в строке. */
const RIGHTS_SHOWN = 6;
const rightsOf = (r: Role): string[] => effective.value[r.id] ?? [];

async function load(): Promise<void> {
  data.value = await api<Listing>('GET', '/admin/roles');
  for (const r of data.value.roles) {
    const e = await api<{ permissions: string[] }>('GET', `/admin/roles/${r.id}/effective`);
    effective.value[r.id] = e.permissions;
  }
}
async function wrap(fn: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
onMounted(() => wrap(load));

const blank = (): NonNullable<typeof form.value> => ({
  id: '',
  name: '',
  description: '',
  scope: 'vault',
  allow: [],
  deny: [],
  parents: [],
});
const startNew = () => (form.value = blank());
const startEdit = (r: Role) =>
  (form.value = { ...r, allow: [...r.allow], deny: [...r.deny], parents: [...r.parents] });

/** Разрешение и запрет взаимоисключающи в форме: отметка одного снимает другое. */
function toggle(list: 'allow' | 'deny', p: string): void {
  const f = form.value!;
  const other = list === 'allow' ? 'deny' : 'allow';
  f[other] = f[other].filter((x) => x !== p);
  f[list] = f[list].includes(p) ? f[list].filter((x) => x !== p) : [...f[list], p];
}
function toggleParent(id: string): void {
  const f = form.value!;
  f.parents = f.parents.includes(id) ? f.parents.filter((x) => x !== id) : [...f.parents, id];
}
const setScope = (s: 'vault' | 'admin') => {
  const f = form.value!;
  f.scope = s;
  f.allow = [];
  f.deny = [];
  f.parents = [];
};

const save = () =>
  wrap(async () => {
    const f = form.value!;
    const body = {
      name: f.name,
      description: f.description,
      scope: f.scope,
      allow: f.allow,
      deny: f.deny,
      parents: f.parents,
    };
    if (f.id) await api('PUT', `/admin/roles/${f.id}`, body);
    else await api('POST', '/admin/roles', body);
    form.value = null;
    await load();
    notice.value = t('roles.saved');
  });

const confirmId = ref('');
const remove = (r: Role) =>
  wrap(async () => {
    if (confirmId.value !== r.id) {
      confirmId.value = r.id;
      return;
    }
    await api('DELETE', `/admin/roles/${r.id}`);
    confirmId.value = '';
    await load();
    notice.value = t('roles.deleted');
  });
</script>

<template>
  <div class="space-y-4" data-testid="roles-panel">
    <p class="text-sm text-slate-600 dark:text-slate-400">{{ t('roles.intro') }}</p>
    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
      data-testid="roles-error"
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      role="status"
    >
      {{ notice }}
    </p>

    <div v-if="!form">
      <button type="button" class="btn-primary" data-testid="role-new" @click="startNew">
        {{ t('roles.new') }}
      </button>
    </div>

    <form v-else class="card space-y-3" data-testid="role-form" @submit.prevent="save">
      <div class="flex flex-wrap gap-3">
        <label class="block min-w-[12rem] flex-1 text-sm">
          {{ t('roles.name') }}
          <input
            v-model="form.name"
            class="input"
            maxlength="60"
            required
            data-testid="role-name"
          />
        </label>
        <label class="block text-sm">
          {{ t('roles.scope') }}
          <select
            :value="form.scope"
            class="input"
            :disabled="!!form.id"
            data-testid="role-scope"
            @change="setScope(($event.target as HTMLSelectElement).value as 'vault' | 'admin')"
          >
            <option value="vault">{{ t('roles.scopeVault') }}</option>
            <option value="admin">{{ t('roles.scopeAdmin') }}</option>
          </select>
        </label>
      </div>
      <label class="block text-sm">
        {{ t('roles.description') }}
        <input v-model="form.description" class="input" maxlength="300" />
      </label>

      <table class="min-w-full text-sm">
        <thead class="text-left text-xs text-slate-500">
          <tr>
            <th class="py-1">&nbsp;</th>
            <th class="px-3">{{ t('roles.allow') }}</th>
            <th class="px-3">{{ t('roles.deny') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in perms" :key="p" class="border-t border-slate-200 dark:border-slate-800">
            <td class="py-1">{{ permLabel(p) }}</td>
            <td class="px-3">
              <input
                type="checkbox"
                :checked="form.allow.includes(p)"
                :data-testid="`allow-${p}`"
                :aria-label="`${t('roles.allow')}: ${permLabel(p)}`"
                @change="toggle('allow', p)"
              />
            </td>
            <td class="px-3">
              <input
                type="checkbox"
                :checked="form.deny.includes(p)"
                :data-testid="`deny-${p}`"
                :aria-label="`${t('roles.deny')}: ${permLabel(p)}`"
                @change="toggle('deny', p)"
              />
            </td>
          </tr>
        </tbody>
      </table>

      <fieldset v-if="parentChoices.length" class="text-sm">
        <legend class="text-xs text-slate-500">{{ t('roles.parents') }}</legend>
        <label v-for="r in parentChoices" :key="r.id" class="mr-4 inline-flex items-center gap-1">
          <input
            type="checkbox"
            :checked="form.parents.includes(r.id)"
            :data-testid="`parent-${r.name}`"
            @change="toggleParent(r.id)"
          />
          {{ r.name }}
        </label>
      </fieldset>

      <div class="flex gap-2">
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="role-save">
          {{ t('roles.save') }}
        </button>
        <button type="button" class="btn" @click="form = null">{{ t('roles.cancel') }}</button>
      </div>
    </form>

    <p v-if="!data.roles.length" class="text-sm text-slate-500">{{ t('roles.empty') }}</p>
    <div
      class="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
    >
      <table class="min-w-full text-sm">
        <thead class="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/60">
          <tr>
            <th class="px-4 py-2.5 font-medium">{{ t('roles.colName') }}</th>
            <th class="px-4 py-2.5 font-medium">{{ t('roles.colScope') }}</th>
            <th class="px-4 py-2.5 font-medium">{{ t('roles.colRights') }}</th>
            <th class="w-px px-4 py-2.5">
              <span class="sr-only">{{ t('roles.colActions') }}</span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-200 dark:divide-slate-800">
          <tr v-for="r in data.roles" :key="r.id" class="align-top" data-testid="role-row">
            <td class="px-4 py-3">
              <div class="font-semibold">{{ r.name }}</div>
              <div v-if="r.description" class="mt-0.5 text-xs text-slate-500">
                {{ r.description }}
              </div>
              <div v-if="r.parents.length" class="mt-1 text-xs text-slate-500">
                {{ t('roles.parents') }}: {{ r.parents.map(nameOf).join(', ') }}
              </div>
            </td>
            <td class="px-4 py-3">
              <span class="badge">{{
                r.scope === 'admin' ? t('roles.scopeAdmin') : t('roles.scopeVault')
              }}</span>
            </td>
            <td class="px-4 py-3">
              <div class="flex flex-wrap gap-1">
                <span
                  v-for="p in rightsOf(r).slice(0, RIGHTS_SHOWN)"
                  :key="p"
                  class="rounded-md bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800"
                  >{{ permLabel(p) }}</span
                >
                <details v-if="rightsOf(r).length > RIGHTS_SHOWN" class="w-full">
                  <summary class="cursor-pointer text-xs text-brand-600 dark:text-brand-400">
                    {{ t('roles.moreRights', { n: rightsOf(r).length - RIGHTS_SHOWN }) }}
                  </summary>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <span
                      v-for="p in rightsOf(r).slice(RIGHTS_SHOWN)"
                      :key="p"
                      class="rounded-md bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800"
                      >{{ permLabel(p) }}</span
                    >
                  </div>
                </details>
                <span v-if="!rightsOf(r).length" class="text-xs text-slate-500">{{
                  t('roles.none')
                }}</span>
              </div>
              <p v-if="r.deny.length" class="mt-1.5 text-xs text-red-600">
                {{ t('roles.deny') }}: {{ r.deny.map((p) => permLabel(p)).join(', ') }}
              </p>
            </td>
            <td class="whitespace-nowrap px-4 py-3 text-right">
              <div class="flex justify-end gap-1.5">
                <button
                  type="button"
                  class="btn"
                  :data-testid="`role-edit-${r.name}`"
                  @click="startEdit(r)"
                >
                  {{ t('roles.edit') }}
                </button>
                <button
                  type="button"
                  class="btn-danger"
                  :disabled="busy"
                  :data-testid="`role-delete-${r.name}`"
                  @click="remove(r)"
                >
                  {{ confirmId === r.id ? t('roles.confirmDelete') : t('roles.delete') }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
