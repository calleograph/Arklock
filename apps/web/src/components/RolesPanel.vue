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
    <ul class="space-y-2">
      <li v-for="r in data.roles" :key="r.id" class="card space-y-1 text-sm" data-testid="role-row">
        <div class="flex flex-wrap items-center gap-2">
          <strong>{{ r.name }}</strong>
          <span class="badge">{{
            r.scope === 'admin' ? t('roles.scopeAdmin') : t('roles.scopeVault')
          }}</span>
          <span class="ml-auto space-x-1">
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
          </span>
        </div>
        <p v-if="r.description" class="text-xs text-slate-500">{{ r.description }}</p>
        <p v-if="r.parents.length" class="text-xs">
          {{ t('roles.parents') }}: {{ r.parents.map(nameOf).join(', ') }}
        </p>
        <p v-if="r.deny.length" class="text-xs text-red-600">
          {{ t('roles.deny') }}: {{ r.deny.map((p) => permLabel(p)).join(', ') }}
        </p>
        <p class="text-xs text-slate-600 dark:text-slate-400">
          {{ t('roles.effective') }}:
          {{ (effective[r.id] ?? []).map((p) => permLabel(p)).join(', ') || t('roles.none') }}
        </p>
      </li>
    </ul>
  </div>
</template>
