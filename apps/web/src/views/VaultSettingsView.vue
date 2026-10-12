<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { decryptEntry, fingerprint, fromBase64Url } from '@arklock/crypto';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import { useAuthStore } from '../stores/auth';
import { useWorkspaceStore, type MemberInfo } from '../stores/workspace';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const ws = useWorkspaceStore();
const auth = useAuthStore();
const id = String(route.params.id);

const vault = computed(() => ws.vaults.find((v) => v.id === id) ?? null);
const isOwner = computed(() => vault.value?.role === 'owner');
const info = ref<{
  keyVersion: number;
  members: MemberInfo[];
  circles: { id: string; name: string; role: string }[];
} | null>(null);
const fingerprints = ref<Record<string, string>>({});
const error = ref('');
const notice = ref('');
const busy = ref(false);

const search = ref('');
const found = ref<
  { id: string; name: string; email: string; publicKey: string; signPublicKey: string }[]
>([]);
const newRole = ref('builtin:editor');
const allCircles = ref<{ id: string; name: string }[]>([]);
const circleChoice = ref('');
const circleRole = ref('builtin:reader');
const grants = ref<
  {
    id: string;
    targetType: string;
    targetId: string;
    subjectType: string;
    subjectId: string;
    subjectName: string;
    role: string;
    expiresAt: string | null;
  }[]
>([]);
const grantForm = ref({
  targetId: '',
  subjectKind: 'user',
  subjectId: '',
  role: 'reader',
  expiresAt: '',
});
const signals = ref<
  { id: string; entryId: string; type: string; status: string; assignedName: string | null }[]
>([]);
const entryTitles = ref<Map<string, string>>(new Map());
const newName = ref(vault.value?.name ?? '');
const rotationHint = ref(false);

async function load(): Promise<void> {
  try {
    if (!ws.vaults.length) await ws.loadVaults();
    info.value = await ws.members(id);
    for (const m of info.value.members) {
      fingerprints.value[m.userId] = await fingerprint(
        fromBase64Url(m.publicKey),
        fromBase64Url(m.signPublicKey),
      );
    }
    allCircles.value = await api('GET', '/directory/circles');
    grants.value = await api('GET', `/vaults/${id}/grants`);
    signals.value = await api('GET', `/vaults/${id}/signals`);
    if (ws.currentId !== id) await ws.select(id);
    entryTitles.value = new Map(ws.entries.map((e) => [e.id, e.data.title]));
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(load);

async function run(fn: () => Promise<unknown>, ok = ''): Promise<void> {
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
    await fn();
    if (ok) notice.value = ok;
    await load();
  } catch (e) {
    error.value =
      e instanceof Error && !(e as { code?: string }).code ? e.message : errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
function onSearch(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    found.value =
      search.value.trim().length >= 2
        ? await api('GET', `/directory/users?q=${encodeURIComponent(search.value.trim())}`)
        : [];
  }, 250);
}

/** Выбор роли: «builtin:editor» или «custom:<id>»; для пользовательской роли — идентификатор роли. */
const customRoles = ref<{ id: string; name: string; permissions: string[] }[]>([]);
void api<typeof customRoles.value>('GET', '/vault-roles')
  .then((r) => (customRoles.value = r))
  .catch(() => undefined);
const roleBody = (value: string, expiresAt?: string | null) => ({
  ...(value.startsWith('custom:')
    ? { customRoleId: value.slice(7) }
    : { role: value.replace('builtin:', '') }),
  ...(expiresAt !== undefined ? { expiresAt } : {}),
});
const roleValue = (builtin: string | null, custom: string | null) =>
  custom ? `custom:${custom}` : `builtin:${builtin}`;
const toIso = (d: string) => (d ? new Date(d + 'T23:59:59').toISOString() : null);
const newExpiry = ref('');

const addMember = (u: (typeof found.value)[number]) =>
  run(async () => {
    await ws.addMember(
      id,
      u,
      roleBody(newRole.value, newExpiry.value ? toIso(newExpiry.value) : undefined),
    );
    found.value = [];
    search.value = '';
  }, t('settings.memberAdded'));

const setRole = (m: MemberInfo, value: string, expiry?: string) =>
  run(() =>
    api('PUT', `/vaults/${id}/members/${m.userId}`, {
      ...roleBody(value),
      expiresAt: expiry !== undefined ? toIso(expiry) : (m.directExpiresAt ?? null),
    }),
  );
const removeMember = (m: MemberInfo) =>
  run(async () => {
    await api('DELETE', `/vaults/${id}/members/${m.userId}`);
    rotationHint.value = true;
  });
const distribute = () =>
  run(async () => {
    notice.value = t('settings.keysIssued', { n: await ws.distributePending(id) });
  });
const addCircle = () =>
  run(() => api('PUT', `/vaults/${id}/circles/${circleChoice.value}`, roleBody(circleRole.value)));
const removeCircle = (cid: string) =>
  run(async () => {
    await api('DELETE', `/vaults/${id}/circles/${cid}`);
    rotationHint.value = true;
  });
const rotate = () => {
  if (!window.confirm(t('settings.confirmRotate'))) return;
  return run(async () => {
    await ws.rotate(id);
    rotationHint.value = false;
  }, t('settings.rotated'));
};
const rename = () =>
  run(() => api('PATCH', `/vaults/${id}`, { name: newName.value }).then(() => ws.loadVaults()));
async function removeVault(): Promise<void> {
  if (!window.confirm(t('settings.confirmDeleteVault'))) return;
  await run(async () => {
    await api('DELETE', `/vaults/${id}`);
    await ws.loadVaults();
    await router.replace('/');
  });
}

const grantTargets = computed(() => {
  const out: { id: string; label: string; type: 'branch' | 'entry' }[] = [];
  for (const b of ws.branches) out.push({ id: b.id, label: `📁 ${b.name}`, type: 'branch' });
  for (const e of ws.entries) out.push({ id: e.id, label: `🔑 ${e.data.title}`, type: 'entry' });
  return out;
});
const grantSubjects = computed(() =>
  grantForm.value.subjectKind === 'user'
    ? (info.value?.members ?? []).map((m) => ({ id: m.userId, label: `${m.name} <${m.email}>` }))
    : allCircles.value.map((c) => ({ id: c.id, label: c.name })),
);
const putGrant = () =>
  run(async () => {
    const target = grantTargets.value.find((x) => x.id === grantForm.value.targetId)!;
    await api('PUT', `/vaults/${id}/grants`, {
      targetType: target.type,
      targetId: target.id,
      subjectType: grantForm.value.subjectKind,
      subjectId: grantForm.value.subjectId,
      role: grantForm.value.role,
      expiresAt: grantForm.value.expiresAt
        ? new Date(grantForm.value.expiresAt).toISOString()
        : null,
    });
  });
const revokeGrant = (gid: string) => run(() => api('DELETE', `/vaults/${id}/grants/${gid}`));
const targetLabel = (g: { targetType: string; targetId: string }) =>
  grantTargets.value.find((x) => x.id === g.targetId)?.label ?? g.targetId.slice(0, 8);

const setSignal = (sid: string, body: object) =>
  run(() => api('PATCH', `/vaults/${id}/signals/${sid}`, body));
const pending = computed(() => info.value?.members.filter((m) => !m.hasKey) ?? []);
void decryptEntry;
</script>

<template>
  <section v-if="vault" class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-semibold">{{ t('settings.title') }}: {{ vault.name }}</h1>
      <button type="button" class="btn" @click="router.push('/')">{{ t('settings.back') }}</button>
    </div>
    <p
      v-if="error"
      class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
      role="alert"
      data-testid="settings-error"
    >
      {{ error }}
    </p>
    <p
      v-if="notice"
      class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      role="status"
      data-testid="settings-notice"
    >
      {{ notice }}
    </p>
    <p v-if="!ws.keyLogOk" class="text-sm text-red-600" role="alert">
      {{ t('vault.keyLogBroken') }}
    </p>

    <div
      v-if="rotationHint"
      class="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      data-testid="rotation-hint"
    >
      {{ t('settings.rotationHint') }}
      <button type="button" class="ml-2 underline" data-testid="btn-rotate-hint" @click="rotate">
        {{ t('settings.rotate') }}
      </button>
    </div>

    <!-- Участники -->
    <div class="space-y-2">
      <h2 class="font-medium">{{ t('settings.members') }}</h2>
      <div class="card overflow-x-auto">
        <table class="min-w-full text-sm" data-testid="members-table">
          <thead class="text-left text-xs text-slate-500">
            <tr>
              <th class="px-3 py-2">{{ t('common.name') }}</th>
              <th>{{ t('settings.role') }}</th>
              <th>{{ t('settings.key') }}</th>
              <th>{{ t('settings.fingerprint') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="m in info?.members"
              :key="m.userId"
              class="border-t border-slate-200 dark:border-slate-800"
              data-testid="member-row"
            >
              <td class="px-3 py-2">
                <div>{{ m.name }}</div>
                <div class="text-xs text-slate-500">{{ m.email }}</div>
                <div v-for="c in m.circles" :key="c.id" class="badge mt-1">
                  ◎ {{ c.name }}: {{ c.role }}
                </div>
              </td>
              <td>
                <select
                  v-if="m.directRole && m.directRole !== 'owner'"
                  :value="roleValue(m.directRole, m.directCustomRoleId)"
                  class="input w-auto"
                  :disabled="busy || (m.directRole === 'admin' && !isOwner)"
                  :data-testid="`role-${m.email}`"
                  @change="setRole(m, ($event.target as HTMLSelectElement).value)"
                >
                  <option
                    v-for="r in ['admin', 'editor', 'reader', 'limited']"
                    :key="r"
                    :value="`builtin:${r}`"
                    :disabled="r === 'admin' && !isOwner"
                  >
                    {{ t(`role.${r}`) }}
                  </option>
                  <option v-for="c in customRoles" :key="c.id" :value="`custom:${c.id}`">
                    ◆ {{ c.name }}
                  </option>
                </select>
                <input
                  v-if="m.directRole && m.directRole !== 'owner'"
                  type="date"
                  class="input ml-1 w-auto"
                  :value="m.directExpiresAt ? m.directExpiresAt.slice(0, 10) : ''"
                  :title="t('settings.expires')"
                  :data-testid="`expiry-${m.email}`"
                  @change="
                    setRole(
                      m,
                      roleValue(m.directRole, m.directCustomRoleId),
                      ($event.target as HTMLInputElement).value,
                    )
                  "
                />
                <span v-else-if="m.directRole === 'owner'" class="badge">{{
                  t('role.owner')
                }}</span>
                <span v-else class="text-xs text-slate-500">{{ t('settings.viaCircle') }}</span>
              </td>
              <td>
                <span :class="m.hasKey ? 'text-emerald-600' : 'text-amber-600'">{{
                  m.hasKey ? t('settings.keyIssued') : t('settings.keyPending')
                }}</span>
              </td>
              <td class="font-mono text-xs" :title="t('settings.fingerprintHint')">
                {{ fingerprints[m.userId]?.slice(0, 19) }}…
              </td>
              <td class="px-3 text-right">
                <button
                  v-if="m.directRole && m.directRole !== 'owner'"
                  type="button"
                  class="btn-danger"
                  :disabled="busy"
                  :data-testid="`remove-${m.email}`"
                  @click="removeMember(m)"
                >
                  {{ t('settings.remove') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <button
        v-if="pending.length"
        type="button"
        class="btn-primary"
        :disabled="busy"
        data-testid="btn-distribute"
        @click="distribute"
      >
        {{ t('settings.issueKeys', { n: pending.length }) }}
      </button>

      <div class="card space-y-2 p-3">
        <h3 class="text-sm font-medium">{{ t('settings.addMember') }}</h3>
        <div class="flex flex-wrap gap-2">
          <input
            v-model="search"
            class="input max-w-xs"
            :placeholder="t('settings.searchUser')"
            data-testid="member-search"
            @input="onSearch"
          />
          <select v-model="newRole" class="input w-auto" data-testid="new-role">
            <option
              v-for="r in ['admin', 'editor', 'reader', 'limited']"
              :key="r"
              :value="`builtin:${r}`"
              :disabled="r === 'admin' && !isOwner"
            >
              {{ t(`role.${r}`) }}
            </option>
            <option v-for="c in customRoles" :key="c.id" :value="`custom:${c.id}`">
              ◆ {{ c.name }}
            </option>
          </select>
          <input
            v-model="newExpiry"
            type="date"
            class="input w-auto"
            :title="t('settings.expires')"
            data-testid="new-expiry"
          />
        </div>
        <ul
          v-if="found.length"
          class="divide-y divide-slate-200 text-sm dark:divide-slate-800"
          data-testid="search-results"
        >
          <li v-for="u in found" :key="u.id" class="flex items-center justify-between py-1.5">
            <span
              >{{ u.name }} <span class="text-xs text-slate-500">{{ u.email }}</span></span
            >
            <button
              type="button"
              class="btn"
              :disabled="busy"
              :data-testid="`add-${u.email}`"
              @click="addMember(u)"
            >
              {{ t('settings.add') }}
            </button>
          </li>
        </ul>
        <p class="text-xs text-slate-500">{{ t('settings.signedKeyHint') }}</p>
      </div>
    </div>

    <!-- Круги -->
    <div class="space-y-2">
      <h2 class="font-medium">{{ t('settings.circles') }}</h2>
      <ul class="card divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <li
          v-for="c in info?.circles"
          :key="c.id"
          class="flex items-center justify-between px-3 py-2"
          data-testid="circle-row"
        >
          ◎ {{ c.name }} · {{ t(`role.${c.role}`)
          }}<button type="button" class="btn-danger" @click="removeCircle(c.id)">
            {{ t('settings.remove') }}
          </button>
        </li>
        <li v-if="!info?.circles.length" class="px-3 py-2 text-slate-500">—</li>
      </ul>
      <div class="flex flex-wrap gap-2">
        <select v-model="circleChoice" class="input w-auto" data-testid="circle-choice">
          <option value="" disabled>…</option>
          <option v-for="c in allCircles" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select v-model="circleRole" class="input w-auto">
          <option
            v-for="r in ['admin', 'editor', 'reader', 'limited']"
            :key="r"
            :value="`builtin:${r}`"
            :disabled="r === 'admin' && !isOwner"
          >
            {{ t(`role.${r}`) }}
          </option>
          <option v-for="c in customRoles" :key="c.id" :value="`custom:${c.id}`">
            ◆ {{ c.name }}
          </option>
        </select>
        <button
          type="button"
          class="btn"
          :disabled="!circleChoice || busy"
          data-testid="btn-add-circle"
          @click="addCircle"
        >
          {{ t('settings.add') }}
        </button>
      </div>
    </div>

    <!-- Гранты -->
    <div class="space-y-2">
      <h2 class="font-medium">{{ t('settings.grants') }}</h2>
      <ul
        class="card divide-y divide-slate-200 text-sm dark:divide-slate-800"
        data-testid="grants-list"
      >
        <li
          v-for="g in grants"
          :key="g.id"
          class="flex items-center justify-between gap-2 px-3 py-2"
        >
          <span class="min-w-0 truncate"
            >{{ targetLabel(g) }} → {{ g.subjectName }} · {{ t(`grant.${g.role}`)
            }}<span v-if="g.expiresAt" class="text-xs text-slate-500">
              · {{ t('settings.until') }} {{ new Date(g.expiresAt).toLocaleDateString() }}</span
            ></span
          >
          <button type="button" class="btn-danger" @click="revokeGrant(g.id)">
            {{ t('settings.revoke') }}
          </button>
        </li>
        <li v-if="!grants.length" class="px-3 py-2 text-slate-500">—</li>
      </ul>
      <div class="flex flex-wrap gap-2">
        <select
          v-model="grantForm.targetId"
          class="input w-auto max-w-48"
          data-testid="grant-target"
        >
          <option value="" disabled>{{ t('settings.target') }}</option>
          <option v-for="x in grantTargets" :key="x.id" :value="x.id">{{ x.label }}</option>
        </select>
        <select v-model="grantForm.subjectKind" class="input w-auto" data-testid="grant-kind">
          <option value="user">{{ t('settings.user') }}</option>
          <option value="circle">{{ t('settings.circle') }}</option>
        </select>
        <select
          v-model="grantForm.subjectId"
          class="input w-auto max-w-48"
          data-testid="grant-subject"
        >
          <option value="" disabled>…</option>
          <option v-for="x in grantSubjects" :key="x.id" :value="x.id">{{ x.label }}</option>
        </select>
        <select v-model="grantForm.role" class="input w-auto" data-testid="grant-role">
          <option v-for="r in ['reader', 'editor', 'manager']" :key="r" :value="r">
            {{ t(`grant.${r}`) }}
          </option>
        </select>
        <input
          v-model="grantForm.expiresAt"
          type="date"
          class="input w-auto"
          :title="t('settings.expires')"
        />
        <button
          type="button"
          class="btn"
          :disabled="busy || !grantForm.targetId || !grantForm.subjectId"
          data-testid="btn-grant"
          @click="putGrant"
        >
          {{ t('settings.grant') }}
        </button>
      </div>
    </div>

    <!-- События безопасности -->
    <div class="space-y-2">
      <h2 class="font-medium">{{ t('settings.signals') }}</h2>
      <ul
        class="card divide-y divide-slate-200 text-sm dark:divide-slate-800"
        data-testid="signals-list"
      >
        <li
          v-for="s in signals"
          :key="s.id"
          class="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
        >
          <span
            >{{ t(`issue.${s.type}`) }} —
            {{ entryTitles.get(s.entryId) ?? s.entryId.slice(0, 8) }}</span
          >
          <span class="flex items-center gap-1">
            <select
              :value="s.status"
              class="input w-auto"
              @change="setSignal(s.id, { status: ($event.target as HTMLSelectElement).value })"
            >
              <option
                v-for="st in ['open', 'in_progress', 'resolved', 'dismissed']"
                :key="st"
                :value="st"
              >
                {{ t(`signalStatus.${st}`) }}
              </option>
            </select>
            <button
              type="button"
              class="btn"
              @click="setSignal(s.id, { assignedTo: auth.user?.id ?? null })"
            >
              {{ s.assignedName ?? t('settings.assignMe') }}
            </button>
          </span>
        </li>
        <li v-if="!signals.length" class="px-3 py-2 text-slate-500">—</li>
      </ul>
    </div>

    <!-- Ключ и удаление -->
    <div class="space-y-2">
      <h2 class="font-medium">{{ t('settings.keyTitle') }}</h2>
      <p class="text-sm text-slate-500">
        {{ t('settings.keyVersion', { v: info?.keyVersion ?? vault.keyVersion }) }} ·
        {{ t('settings.rotateHint') }}
      </p>
      <button type="button" class="btn" :disabled="busy" data-testid="btn-rotate" @click="rotate">
        {{ t('settings.rotate') }}
      </button>
      <div class="flex flex-wrap gap-2 pt-4">
        <input v-model="newName" class="input max-w-xs" maxlength="100" />
        <button type="button" class="btn" :disabled="busy || !newName.trim()" @click="rename">
          {{ t('vault.rename') }}
        </button>
        <button
          v-if="isOwner"
          type="button"
          class="btn-danger"
          data-testid="btn-delete-vault"
          @click="removeVault"
        >
          {{ t('settings.deleteVault') }}
        </button>
      </div>
    </div>
  </section>
  <p v-else class="text-sm text-slate-500">{{ t('common.working') }}</p>
</template>
