<script setup lang="ts">
import SwitchField from './SwitchField.vue';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  AUTOMATION_DENYABLE,
  AUTOMATION_TRIGGERS,
  type AutomationTrigger,
} from '@arklock/contracts';
import { api } from '../services/api';
import { errorMessage, vaultLabel, when } from '../services/helpers';
import { useWorkspaceStore } from '../stores/workspace';
import ActionMenu, { type ActionItem } from './ActionMenu.vue';

/**
 * Правила автоматизации: событие журнала (в сейфе, от сотрудника группы) — уведомить группы или администраторов.
 * События, о которых сообщает браузер (показ, копирование), сервер не доказывает — правило верит отметке клиента.
 */
interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  effect: 'notify' | 'deny';
  vaultId: string | null;
  actorCircleId: string | null;
  notifyCircles: string[];
  notifyAdmins: boolean;
  fired: number;
  firedAt: string | null;
}
const { t } = useI18n();
const ws = useWorkspaceStore();
const rules = ref<Rule[]>([]);
const circles = ref<{ id: string; name: string }[]>([]);
const error = ref('');
const busy = ref(false);
const ALL_TRIGGERS = Object.keys(AUTOMATION_TRIGGERS) as AutomationTrigger[];
// запретить можно только то, что сервер выполняет сам (показ пароля идёт в браузере)
const triggers = computed(() =>
  form.value.effect === 'deny' ? [...AUTOMATION_DENYABLE] : ALL_TRIGGERS,
);
function setEffect(effect: 'notify' | 'deny'): void {
  form.value.effect = effect;
  if (!triggers.value.includes(form.value.trigger)) form.value.trigger = triggers.value[0]!;
}
const blank = () => ({
  id: '',
  name: '',
  enabled: true,
  trigger: 'entry.reveal' as AutomationTrigger,
  effect: 'notify' as 'notify' | 'deny',
  vaultId: null as string | null,
  actorCircleId: null as string | null,
  notifyCircles: [] as string[],
  notifyAdmins: true,
});
const form = ref(blank());
const editing = ref(false);
const circleName = (id: string | null) => circles.value.find((c) => c.id === id)?.name ?? '—';
const vaultName = (id: string | null) => {
  const v = ws.vaults.find((x) => x.id === id);
  return v ? vaultLabel(v, t) : '—';
};
const sharedVaults = computed(() => ws.vaults.filter((v) => v.kind === 'shared'));

async function load(): Promise<void> {
  error.value = '';
  try {
    if (!ws.vaults.length) await ws.loadVaults();
    rules.value = await api<Rule[]>('GET', '/admin/automation');
    // группы нужны для условий и получателей; без права на группы правило всё равно можно увидеть
    circles.value = await api<{ id: string; name: string }[]>('GET', '/admin/circles').catch(
      () => [],
    );
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(load);

async function run(fn: () => Promise<unknown>): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await fn();
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
const body = (r: ReturnType<typeof blank> | Rule) => ({
  name: r.name,
  enabled: r.enabled,
  trigger: r.trigger,
  effect: r.effect,
  vaultId: r.vaultId,
  actorCircleId: r.actorCircleId,
  notifyCircles: r.notifyCircles,
  notifyAdmins: r.notifyAdmins,
});
const save = () =>
  run(async () => {
    const f = form.value;
    if (f.id) await api('PUT', `/admin/automation/${f.id}`, body(f));
    else await api('POST', '/admin/automation', body(f));
    form.value = blank();
    editing.value = false;
  });
const toggle = (r: Rule) =>
  run(() => api('PUT', `/admin/automation/${r.id}`, { ...body(r), enabled: !r.enabled }));
const actions = (r: Rule): ActionItem[] => [
  { id: 'edit', label: t('automation.edit'), icon: 'edit', testid: `rule-edit-${r.name}` },
  {
    id: 'delete',
    label: t('automation.delete'),
    icon: 'trash',
    danger: true,
    testid: `rule-delete-${r.name}`,
  },
];
function onAction(r: Rule, id: string): void {
  if (id === 'edit') {
    form.value = { ...blank(), ...body(r), id: r.id };
    editing.value = true;
  } else if (id === 'delete' && window.confirm(t('automation.confirmDelete', { name: r.name })))
    void run(() => api('DELETE', `/admin/automation/${r.id}`));
}
const recipients = (r: Rule) =>
  [...r.notifyCircles.map(circleName), ...(r.notifyAdmins ? [t('automation.admins')] : [])].join(
    ', ',
  ) || '—';
</script>

<template>
  <section class="card space-y-4 p-4 text-sm" data-testid="automation">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 class="font-medium">{{ t('automation.title') }}</h2>
        <p class="max-w-prose text-xs text-slate-500">{{ t('automation.hint') }}</p>
      </div>
      <button
        v-if="!editing"
        type="button"
        class="btn-primary"
        data-testid="rule-add"
        @click="((form = blank()), (editing = true))"
      >
        {{ t('automation.add') }}
      </button>
    </div>
    <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>

    <form
      v-if="editing"
      class="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700"
      data-testid="rule-form"
      @submit.prevent="save"
    >
      <label class="block"
        ><span class="field-label">{{ t('automation.name') }}</span
        ><input v-model="form.name" required maxlength="100" class="input" data-testid="rule-name"
      /></label>
      <fieldset class="flex flex-wrap gap-4" role="radiogroup">
        <legend class="field-label">{{ t('automation.effect') }}</legend>
        <label class="flex items-center gap-2"
          ><input
            type="radio"
            :checked="form.effect === 'notify'"
            data-testid="rule-effect-notify"
            @change="setEffect('notify')"
          />
          {{ t('automation.effectNotify') }}</label
        >
        <label class="flex items-center gap-2"
          ><input
            type="radio"
            :checked="form.effect === 'deny'"
            data-testid="rule-effect-deny"
            @change="setEffect('deny')"
          />
          {{ t('automation.effectDeny') }}</label
        >
      </fieldset>
      <p v-if="form.effect === 'deny'" class="text-xs text-slate-500">
        {{ t('automation.denyHint') }}
      </p>
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="block"
          ><span class="field-label">{{ t('automation.when') }}</span
          ><select v-model="form.trigger" class="input" data-testid="rule-trigger">
            <option v-for="tr in triggers" :key="tr" :value="tr">
              {{ t(`automation.trigger.${tr.replace('.', '_')}`) }}
            </option>
          </select></label
        >
        <label class="block"
          ><span class="field-label">{{ t('automation.inVault') }}</span
          ><select v-model="form.vaultId" class="input" data-testid="rule-vault">
            <option :value="null">{{ t('automation.anyVault') }}</option>
            <option v-for="v in sharedVaults" :key="v.id" :value="v.id">
              {{ vaultLabel(v, t) }}
            </option>
          </select></label
        >
        <label class="block"
          ><span class="field-label">{{ t('automation.byGroup') }}</span
          ><select v-model="form.actorCircleId" class="input" data-testid="rule-actor">
            <option :value="null">{{ t('automation.anyone') }}</option>
            <option v-for="c in circles" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select></label
        >
      </div>
      <fieldset class="space-y-1">
        <legend class="field-label">{{ t('automation.notify') }}</legend>
        <SwitchField
          v-model="form.notifyAdmins"
          data-testid="rule-admins"
          :label="t('automation.admins')"
        />
        <label v-for="c in circles" :key="c.id" class="flex items-center gap-2"
          ><input
            v-model="form.notifyCircles"
            type="checkbox"
            :value="c.id"
            :data-testid="`rule-circle-${c.name}`"
          />
          {{ c.name }}</label
        >
      </fieldset>
      <p
        v-if="
          form.trigger.startsWith('entry.') &&
          ['entry.reveal', 'entry.copy', 'entry.open'].includes(form.trigger)
        "
        class="text-xs text-slate-500"
      >
        {{ t('automation.clientReported') }}
      </p>
      <div class="flex gap-2">
        <button
          type="submit"
          class="btn-primary"
          :disabled="
            busy || (form.effect === 'notify' && !form.notifyAdmins && !form.notifyCircles.length)
          "
          data-testid="rule-save"
        >
          {{ t('common.save') }}
        </button>
        <button type="button" class="btn" @click="editing = false">
          {{ t('common.cancel') }}
        </button>
      </div>
    </form>

    <p v-if="!rules.length" class="text-slate-500">{{ t('automation.none') }}</p>
    <ul v-else class="divide-y divide-slate-200 dark:divide-slate-800" data-testid="rules">
      <li
        v-for="r in rules"
        :key="r.id"
        class="flex flex-wrap items-center justify-between gap-2 py-2"
        data-testid="rule-row"
      >
        <span class="min-w-0">
          <span class="font-medium" :class="r.enabled ? '' : 'text-slate-400'">{{ r.name }}</span>
          <span v-if="r.effect === 'deny'" class="badge ml-1 text-red-700 dark:text-red-300">{{
            t('automation.deny')
          }}</span>
          <span class="block text-xs text-slate-500">
            {{ t(`automation.trigger.${r.trigger.replace('.', '_')}`) }} ·
            {{ r.vaultId ? vaultName(r.vaultId) : t('automation.anyVault') }} ·
            {{ r.actorCircleId ? circleName(r.actorCircleId) : t('automation.anyone') }} →
            {{ recipients(r) }}
          </span>
          <span class="block text-xs text-slate-500">
            {{
              r.fired
                ? t('automation.fired', { n: r.fired, at: when(r.firedAt!) })
                : t('automation.neverFired')
            }}
          </span>
        </span>
        <span class="flex items-center gap-2">
          <label class="flex items-center gap-1 text-xs"
            ><input
              type="checkbox"
              :checked="r.enabled"
              :disabled="busy"
              :data-testid="`rule-enabled-${r.name}`"
              @change="toggle(r)"
            />
            {{ t('automation.enabled') }}</label
          >
          <ActionMenu
            :title="`${t('automation.actions')}: ${r.name}`"
            :items="actions(r)"
            @select="(id) => onAction(r, id)"
          />
        </span>
      </li>
    </ul>
  </section>
</template>
