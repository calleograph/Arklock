<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import { checkPolicy, type PasswordPolicy } from '../services/policy';
type Policy = PasswordPolicy & { maxAgeDays: number };
interface PolicyInfo {
  own: Partial<Policy> | null;
  effective: Policy;
  sources: { scope: string; id: string | null; policy: Partial<Policy> }[];
  canManage: boolean;
}
const props = withDefaults(
  defineProps<{
    vaultId: string;
    entryId: string;
    active: boolean;
    password?: string;
    passwordChangedAt?: string;
    targetType?: 'entry' | 'branch' | 'vault';
  }>(),
  { targetType: 'entry', password: '' },
);
const base = computed(() =>
  props.targetType === 'vault'
    ? `/vaults/${props.vaultId}`
    : `/vaults/${props.vaultId}/${props.targetType === 'branch' ? 'branches' : 'entries'}/${props.entryId}`,
);
const emit = defineEmits<{ (e: 'policy', value: Policy): void }>();
const { t } = useI18n();
const data = ref<PolicyInfo | null>(null);
const inherit = ref(true);
const draft = ref<Policy>({ minLength: 0, classes: 0, maxAgeDays: 0 });
const error = ref('');
const saved = ref(false);
const busy = ref(false);
const checks = computed(() =>
  props.password && data.value ? checkPolicy(props.password, data.value.effective) : [],
);
const expired = computed(() => {
  if (!props.password || !props.passwordChangedAt || !data.value?.effective.maxAgeDays)
    return false;
  return (
    Date.now() - Date.parse(props.passwordChangedAt) > data.value.effective.maxAgeDays * 86_400_000
  );
});
const unknownAge = computed(
  () =>
    props.password &&
    data.value?.effective.maxAgeDays &&
    (!props.passwordChangedAt || !Number.isFinite(Date.parse(props.passwordChangedAt))),
);
function accept(info: PolicyInfo): void {
  data.value = info;
  inherit.value = info.own === null;
  draft.value = { minLength: 0, classes: 0, maxAgeDays: 0, ...info.own };
  emit('policy', info.effective);
}
async function load(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    accept(await api('GET', `${base.value}/policy`));
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
watch(
  () => props.active,
  (active) => {
    if (active && !data.value) void load();
  },
  { immediate: true },
);
async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  saved.value = false;
  try {
    accept(
      await api('PATCH', `${base.value}/policy`, { policy: inherit.value ? null : draft.value }),
    );
    saved.value = true;
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-4 text-sm" data-testid="entry-settings">
    <p v-if="error" class="text-red-600" role="alert">
      {{ error }}
      <button v-if="!data" class="btn" type="button" @click="load">
        {{ t('entryPanel.refresh') }}
      </button>
    </p>
    <p v-if="!data && busy" class="text-slate-500">{{ t('common.working') }}</p>
    <template v-if="data">
      <h3 class="font-medium">{{ t('entryPanel.passwordPolicy') }}</h3>
      <p class="text-xs text-slate-500">{{ t('entryPanel.policyHint') }}</p>
      <dl
        class="grid grid-cols-1 gap-2 rounded-md bg-slate-50 p-3 dark:bg-slate-900 sm:grid-cols-3"
      >
        <div>
          <dt class="text-xs text-slate-500">{{ t('entryPanel.minLength') }}</dt>
          <dd>{{ data.effective.minLength }}</dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500">{{ t('entryPanel.classes') }}</dt>
          <dd>{{ data.effective.classes }}</dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500">{{ t('entryPanel.maxAge') }}</dt>
          <dd>{{ data.effective.maxAgeDays || t('entryPanel.unlimited') }}</dd>
        </div>
      </dl>
      <p
        v-if="password"
        :class="
          checks.length || expired || unknownAge
            ? 'text-amber-700 dark:text-amber-300'
            : 'text-emerald-700 dark:text-emerald-300'
        "
        data-testid="entry-policy-status"
      >
        {{
          checks.length || expired
            ? t('entryPanel.policyMismatch')
            : unknownAge
              ? t('entryPanel.unknownAge')
              : t('entryPanel.policyMatches')
        }}
      </p>
      <div class="space-y-1">
        <h4 class="font-medium">{{ t('entryPanel.policySources') }}</h4>
        <p v-for="(source, i) in data.sources" :key="i" class="text-xs text-slate-500">
          {{ t(`entryPanel.scopes.${source.scope}`) }} · {{ t('entryPanel.minLength') }}:
          {{ source.policy.minLength || 0 }}, {{ t('entryPanel.classes') }}:
          {{ source.policy.classes || 0 }}, {{ t('entryPanel.maxAge') }}:
          {{ source.policy.maxAgeDays || t('entryPanel.unlimited') }}
        </p>
      </div>
      <form
        v-if="data.canManage"
        class="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800"
        @submit.prevent="save"
      >
        <label class="flex items-center gap-2"
          ><input v-model="inherit" type="checkbox" data-testid="entry-policy-inherit" />{{
            t('entryPanel.inheritPolicy')
          }}</label
        >
        <fieldset v-if="!inherit" class="grid grid-cols-1 gap-2 sm:grid-cols-3" :disabled="busy">
          <label
            ><span class="mb-1 block text-xs">{{ t('entryPanel.minLength') }}</span
            ><input
              v-model.number="draft.minLength"
              type="number"
              min="0"
              max="128"
              required
              class="input"
              data-testid="entry-policy-length"
          /></label>
          <label
            ><span class="mb-1 block text-xs">{{ t('entryPanel.classes') }}</span
            ><input
              v-model.number="draft.classes"
              type="number"
              min="0"
              max="4"
              required
              class="input"
              data-testid="entry-policy-classes"
          /></label>
          <label
            ><span class="mb-1 block text-xs">{{ t('entryPanel.maxAge') }}</span
            ><input
              v-model.number="draft.maxAgeDays"
              type="number"
              min="0"
              max="3650"
              required
              class="input"
              data-testid="entry-policy-age"
          /></label>
        </fieldset>
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="entry-policy-save">
          {{ t('common.save') }}
        </button>
        <p v-if="saved" role="status" class="text-emerald-700 dark:text-emerald-300">
          {{ t('entryPanel.policySaved') }}
        </p>
      </form>
    </template>
  </div>
</template>
