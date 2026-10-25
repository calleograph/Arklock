<script setup lang="ts">
import GrantDialog, { type Recipient } from '../components/GrantDialog.vue';
import Icon from '../components/Icon.vue';
import InfoHint from '../components/InfoHint.vue';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { decryptEntry, fingerprint, fromBase64Url } from '@arklock/crypto';
import { api } from '../services/api';
import { errorMessage, vaultLabel, day, when } from '../services/helpers';
import { useAuthStore } from '../stores/auth';
import { useWorkspaceStore, type MemberInfo } from '../stores/workspace';
import EntrySettingsPanel from '../components/EntrySettingsPanel.vue';
import VaultCorporateRecovery from '../components/VaultCorporateRecovery.vue';

const { t, locale } = useI18n();
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
  circles: { id: string; name: string; role: string; managed?: boolean }[];
} | null>(null);
const fingerprints = ref<Record<string, string>>({});
const error = ref('');
const notice = ref('');
const busy = ref(false);

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
const signals = ref<
  {
    id: string;
    entryId: string;
    type: string;
    status: string;
    assignedName: string | null;
    cause: { id: string; name: string | null; reason?: 'offboarding' | 'revoked' } | null;
    createdAt: string;
    updatedAt: string;
  }[]
>([]);
// открытые и в работе — отдельно от архива решённых и отклонённых
const signalTab = ref<'active' | 'closed'>('active');
const isClosed = (status: string) => status === 'resolved' || status === 'dismissed';
// вид события: после увольнения их бывают сотни — нужен отбор
const signalType = ref('');
const signalTypes = computed(() => [...new Set(signals.value.map((s) => s.type))]);
const shownSignals = computed(() =>
  signals.value.filter(
    (s) =>
      isClosed(s.status) === (signalTab.value === 'closed') &&
      (!signalType.value || s.type === signalType.value),
  ),
);
const closedCount = computed(() => signals.value.filter((s) => isClosed(s.status)).length);
// риск по типу: утечка и «смените пароль после увольнения» — высокий, остальное — средний
const risk = (type: string) => (type === 'compromised' || type === 'rotate' ? 'high' : 'medium');
interface SignalStep {
  at: string;
  action: string;
  actorName: string | null;
  status: string | null;
  assigned?: string | null;
  assignedName: string | null;
  auto: boolean;
  clientReported: boolean;
  reason: string | null;
}
const histories = ref<Record<string, SignalStep[]>>({});
async function toggleHistory(sid: string): Promise<void> {
  if (histories.value[sid]) {
    const { [sid]: _, ...rest } = histories.value;
    histories.value = rest;
    return;
  }
  histories.value = {
    ...histories.value,
    [sid]: await api<SignalStep[]>('GET', `/vaults/${id}/signals/${sid}/history`),
  };
}
const stepText = (h: SignalStep) =>
  [
    t(`signalHistory.${h.action.replace('signal.', '')}`),
    h.status ? t(`signalStatus.${h.status}`) : '',
    h.reason === 'offboarding' ? t('signalHistory.offboarding') : '',
    h.auto ? t('signalHistory.auto') : '',
    h.clientReported ? t('signalHistory.clientReported') : '',
    h.assigned === null
      ? t('signalHistory.unassigned')
      : h.assignedName
        ? t('signalHistory.assigned', { name: h.assignedName })
        : '',
  ]
    .filter(Boolean)
    .join(' · ');
// время реакции — от создания до первого действия человека, закрытия — до последнего закрытия
function took(from: string, to: string): string {
  const min = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  const [n, unit] =
    min < 120
      ? [min, 'minute']
      : min < 2880
        ? [Math.round(min / 60), 'hour']
        : [Math.round(min / 1440), 'day'];
  return new Intl.NumberFormat(locale.value, { style: 'unit', unit, unitDisplay: 'short' }).format(
    n,
  );
}
function timings(steps: SignalStep[]): string {
  const created = steps.find((h) => h.action === 'signal.create');
  if (!created) return '';
  const first = steps.find((h) => h.action === 'signal.update' && h.at >= created.at);
  const closed = [...steps]
    .reverse()
    .find(
      (h) => h.action === 'signal.resolve' || h.status === 'resolved' || h.status === 'dismissed',
    );
  return [
    first ? t('signalHistory.reaction', { t: took(created.at, first.at) }) : '',
    closed ? t('signalHistory.closed', { t: took(created.at, closed.at) }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
const entryTitles = ref<Map<string, string>>(new Map());
const newName = ref(vault.value ? vaultLabel(vault.value, t) : '');
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
    grants.value = await api('GET', `/vaults/${id}/grants`);
    signals.value = await api('GET', `/vaults/${id}/signals`);
    // после перезагрузки на другой странице сейф уже выбран, но записи ещё не загружены — названия событий пустые
    if (ws.currentId !== id || !ws.entries.length) await ws.select(id);
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

const showGrant = ref(false);
const grantLevels = computed(() => [
  ...['admin', 'editor', 'reader', 'limited'].map((r) => ({
    value: `builtin:${r}`,
    label: t(`role.${r}`),
    disabled: r === 'admin' && !isOwner.value,
  })),
  ...customRoles.value.map((c) => ({ value: `custom:${c.id}`, label: c.name })),
]);
/** Сотрудникам ключ выдаётся сразу (его запечатывает этот браузер), группам — по мере выдачи участникам группы. */
const grantMany = (list: Recipient[], expiresAt: string | null) =>
  run(
    async () => {
      for (const r of list) {
        if (r.kind === 'user')
          await ws.addMember(
            id,
            {
              id: r.id,
              publicKey: r.publicKey ?? '',
              signPublicKey: r.signPublicKey ?? '',
            },
            roleBody(r.level, expiresAt ?? undefined),
          );
        else
          await api(
            'PUT',
            `/vaults/${id}/circles/${r.id}`,
            roleBody(r.level, expiresAt ?? undefined),
          );
      }
      showGrant.value = false;
      if (list.some((r) => r.kind === 'circle')) await ws.distributePending(id);
    },
    t('grantDlg.done', { n: list.length }),
  );
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
/** Новый владелец выбирается среди участников, у которых уже есть ключ; подтверждение — вводом названия хранилища. */
const heirs = computed(() =>
  (info.value?.members ?? []).filter((m) => m.hasKey && m.directRole && m.directRole !== 'owner'),
);
const heir = ref('');
const heirConfirm = ref('');
const transfer = () =>
  run(async () => {
    await api('POST', `/vaults/${id}/transfer-ownership`, { userId: heir.value });
    heir.value = '';
    heirConfirm.value = '';
    await ws.loadVaults();
    await load();
  }, t('settings.transferred'));
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
  for (const b of ws.branches) out.push({ id: b.id, label: b.name, type: 'branch' });
  for (const e of ws.entries) out.push({ id: e.id, label: e.data.title, type: 'entry' });
  return out;
});
const revokeGrant = (gid: string) => run(() => api('DELETE', `/vaults/${id}/grants/${gid}`));
const targetLabel = (g: { targetType: string; targetId: string }) =>
  grantTargets.value.find((x) => x.id === g.targetId)?.label ?? g.targetId.slice(0, 8);

const setSignal = (sid: string, body: object) =>
  run(async () => {
    await api('PATCH', `/vaults/${id}/signals/${sid}`, body);
    // открытая история не должна отставать от только что сделанного изменения
    if (histories.value[sid])
      histories.value = {
        ...histories.value,
        [sid]: await api<SignalStep[]>('GET', `/vaults/${id}/signals/${sid}/history`),
      };
  });
const pending = computed(() => info.value?.members.filter((m) => !m.hasKey) ?? []);
void decryptEntry;
</script>

<template>
  <section v-if="vault" class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-semibold">{{ t('settings.title') }}: {{ vaultLabel(vault, t) }}</h1>
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
    <section class="card p-4" data-testid="vault-policy">
      <EntrySettingsPanel :vault-id="id" :entry-id="id" target-type="vault" :active="true" />
    </section>
    <VaultCorporateRecovery :vault-id="id" />

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
              <th>
                <span class="inline-flex items-center gap-1"
                  >{{ t('settings.role')
                  }}<InfoHint
                    :text="t('hint.vaultRoles.text')"
                    :details="t('hint.vaultRoles.details')"
                /></span>
              </th>
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

      <button
        type="button"
        class="btn-primary"
        :disabled="busy"
        data-testid="grant-open"
        @click="showGrant = true"
      >
        <Icon name="share" /> {{ t('grantDlg.open') }}
      </button>
      <p class="text-xs text-slate-500">{{ t('settings.signedKeyHint') }}</p>
    </div>

    <p v-if="vault.managed" class="notice notice-warn" data-testid="managed-banner">
      {{
        t('managed.banner', {
          groups: (info?.circles ?? [])
            .filter((c) => c.managed)
            .map((c) => c.name)
            .join(', '),
        })
      }}
    </p>

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
          <span>
            ◎ {{ c.name }} · {{ t(`role.${c.role}`) }}
            <span v-if="c.managed" class="badge ml-1">{{ t('managed.byPolicy') }}</span>
          </span>
          <button v-if="!c.managed" type="button" class="btn-danger" @click="removeCircle(c.id)">
            {{ t('settings.remove') }}
          </button>
        </li>
        <li v-if="!info?.circles.length" class="px-3 py-2 text-slate-500">—</li>
      </ul>
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
              · {{ t('settings.until') }} {{ day(g.expiresAt) }}</span
            ></span
          >
          <button type="button" class="btn-danger" @click="revokeGrant(g.id)">
            {{ t('settings.revoke') }}
          </button>
        </li>
        <li v-if="!grants.length" class="px-3 py-2 text-slate-500">—</li>
      </ul>
      <p class="text-xs text-slate-500">{{ t('settings.grantsWhere') }}</p>
    </div>

    <!-- События безопасности -->
    <div class="space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-medium">{{ t('settings.signals') }}</h2>
        <span class="flex flex-wrap items-center gap-2">
          <select
            v-if="signalTypes.length > 1"
            v-model="signalType"
            class="input w-auto py-1 text-xs"
            :aria-label="t('settings.signalType')"
            data-testid="signals-type"
          >
            <option value="">{{ t('settings.signalTypeAll') }}</option>
            <option v-for="ty in signalTypes" :key="ty" :value="ty">{{ t(`issue.${ty}`) }}</option>
          </select>
          <div class="flex rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800" role="tablist">
            <button
              v-for="tab in ['active', 'closed'] as const"
              :key="tab"
              type="button"
              role="tab"
              class="seg"
              :class="signalTab === tab ? 'seg-on' : ''"
              :aria-selected="signalTab === tab"
              :data-testid="`signals-tab-${tab}`"
              @click="signalTab = tab"
            >
              {{
                t(`settings.signalTab.${tab}`, {
                  n: tab === 'closed' ? closedCount : signals.length - closedCount,
                })
              }}
            </button>
          </div>
        </span>
      </div>
      <ul
        class="card divide-y divide-slate-200 text-sm dark:divide-slate-800"
        data-testid="signals-list"
      >
        <li
          v-for="s in shownSignals"
          :key="s.id"
          class="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
        >
          <span class="min-w-0">
            <span
              class="badge mr-1"
              :class="risk(s.type) === 'high' ? 'text-red-700 dark:text-red-300' : ''"
              >{{ t(`signalRisk.${risk(s.type)}`) }}</span
            >{{ t(`issue.${s.type}`) }} —
            {{ entryTitles.get(s.entryId) ?? s.entryId.slice(0, 8) }}
            <span v-if="s.cause" class="mr-1 text-xs text-slate-500" data-testid="signal-cause"
              >·
              {{
                t(
                  s.cause.reason === 'revoked'
                    ? 'settings.signalCauseRevoked'
                    : 'settings.signalCause',
                  {
                    name: s.cause.name ?? '—',
                  },
                )
              }}</span
            >
            <span class="text-xs text-slate-500"
              >· {{ when(s.createdAt) }}
              <template v-if="isClosed(s.status)"
                >· {{ t('settings.signalClosedAt', { at: when(s.updatedAt) }) }}</template
              ></span
            >
          </span>
          <span class="flex flex-wrap items-center gap-1">
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
            <button
              type="button"
              class="btn-ghost text-xs"
              :aria-expanded="!!histories[s.id]"
              :data-testid="`signal-history-${s.id}`"
              @click="toggleHistory(s.id).catch((e) => (error = errorMessage(e, t)))"
            >
              {{ histories[s.id] ? t('signalHistory.hide') : t('signalHistory.show') }}
            </button>
            <RouterLink
              :to="{ path: '/', query: { vault: id, entry: s.entryId } }"
              class="btn-ghost text-xs"
              :data-testid="`signal-open-${s.id}`"
              >{{ t('settings.signalOpen') }}</RouterLink
            >
          </span>
          <div v-if="histories[s.id]" class="w-full text-xs text-slate-600 dark:text-slate-300">
            <p class="mb-1 max-w-prose" data-testid="signal-advice">
              <span class="font-medium">{{ t('signalAdvice.whyLabel') }}</span>
              {{ t(`signalAdvice.${s.type}.why`) }}
              <span class="font-medium">{{ t('signalAdvice.doLabel') }}</span>
              {{ t(`signalAdvice.${s.type}.do`) }}
            </p>
            <p v-if="timings(histories[s.id]!)" class="font-medium">
              {{ timings(histories[s.id]!) }}
            </p>
            <ol class="mt-1 space-y-0.5" data-testid="signal-history">
              <li v-for="(h, i) in histories[s.id]" :key="i">
                <span class="num text-slate-500">{{ when(h.at) }}</span>
                {{ h.actorName ?? '—' }}: {{ stepText(h) }}
              </li>
            </ol>
          </div>
        </li>
        <li v-if="!shownSignals.length" class="px-3 py-2 text-slate-500">—</li>
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
      <div v-if="isOwner && heirs.length" class="card max-w-xl space-y-2 p-3 text-sm">
        <h3 class="font-medium">{{ t('settings.transferTitle') }}</h3>
        <p class="text-xs text-slate-500">{{ t('settings.transferHint') }}</p>
        <select v-model="heir" class="input" data-testid="heir">
          <option value="">—</option>
          <option v-for="m in heirs" :key="m.userId" :value="m.userId">
            {{ m.name }} · {{ m.email }}
          </option>
        </select>
        <input
          v-model="heirConfirm"
          class="input"
          :placeholder="t('settings.transferConfirm', { name: vault.name })"
          data-testid="heir-confirm"
        />
        <button
          type="button"
          class="btn-danger"
          :disabled="busy || !heir || heirConfirm !== vault.name"
          data-testid="heir-go"
          @click="transfer"
        >
          {{ t('settings.transfer') }}
        </button>
      </div>
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
    <GrantDialog
      :open="showGrant"
      :title="t('grantDlg.open')"
      :levels="grantLevels"
      default-level="builtin:reader"
      :existing="info?.members.map((m) => m.userId) ?? []"
      :busy="busy"
      @close="showGrant = false"
      @submit="grantMany"
    />
  </section>
  <p v-else class="text-sm text-slate-500">{{ t('common.working') }}</p>
</template>
