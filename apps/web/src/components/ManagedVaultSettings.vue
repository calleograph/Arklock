<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import SwitchField from './SwitchField.vue';
import GroupPicker, { type Group } from './GroupPicker.vue';

/**
 * Два режима персональных сейфов рядом: личный приватный (администратор не читает) и персональный корпоративный
 * (по объявленной политике доступ у групп-хранителей). Здесь настраивается второй и объясняется, что реально может главный администратор.
 */
const { t } = useI18n();
const enabled = ref(false);
const guardians = ref<Group[]>([]);
const role = ref<'reader' | 'editor'>('reader');
const busy = ref(false);
const error = ref('');
const notice = ref('');

onMounted(async () => {
  try {
    const s = await api<Record<string, unknown>>('GET', '/admin/settings');
    enabled.value = s['vaults.managedPersonal'] === true;
    role.value = s['vaults.managedRole'] === 'editor' ? 'editor' : 'reader';
    const ids = (s['vaults.managedGuardians'] as string[] | undefined) ?? [];
    if (ids.length) {
      // названия групп известны серверу: выбранные подтягиваются поиском по списку (групп немного)
      const all = await api<{ items: Group[] }>('GET', '/admin/circles?limit=200');
      guardians.value = all.items.filter((g) => ids.includes(g.id));
    }
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});

async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await api('PUT', '/admin/settings', {
      'vaults.managedPersonal': enabled.value,
      'vaults.managedGuardians': guardians.value.map((g) => g.id),
      'vaults.managedRole': role.value,
    });
    notice.value = t('managed.saved');
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card space-y-3 p-4 text-sm" data-testid="managed-settings">
    <div>
      <h2 class="text-base font-semibold">{{ t('managed.settingsTitle') }}</h2>
      <p class="mt-1 max-w-prose text-xs text-slate-500">{{ t('managed.settingsHint') }}</p>
    </div>
    <div class="grid gap-3 md:grid-cols-2">
      <div class="rounded-md border border-slate-200 p-3 dark:border-slate-700">
        <h3 class="font-medium">{{ t('managed.modePrivate') }}</h3>
        <p class="mt-1 text-xs text-slate-500">{{ t('managed.modePrivateText') }}</p>
      </div>
      <div class="rounded-md border border-slate-200 p-3 dark:border-slate-700">
        <h3 class="font-medium">{{ t('managed.modeManaged') }}</h3>
        <p class="mt-1 text-xs text-slate-500">{{ t('managed.modeManagedText') }}</p>
      </div>
    </div>
    <form class="space-y-2" @submit.prevent="save">
      <SwitchField v-model="enabled" :label="t('managed.enable')" data-testid="managed-enabled" />
      <div v-if="enabled" class="grid gap-x-3 gap-y-2 sm:grid-cols-2">
        <div>
          <span class="field-label">{{ t('managed.guardiansLabel') }}</span>
          <GroupPicker
            v-model="guardians"
            :placeholder="t('managed.guardiansPlaceholder')"
            testid="managed-guardians-pick"
          />
        </div>
        <label class="block">
          <span class="field-label">{{ t('managed.roleLabel') }}</span>
          <select v-model="role" class="input" data-testid="managed-role">
            <option value="reader">{{ t('managed.role.reader') }}</option>
            <option value="editor">{{ t('managed.role.editor') }}</option>
          </select>
        </label>
      </div>
      <p v-if="error" class="text-red-600" role="alert">{{ error }}</p>
      <p v-if="notice" class="text-emerald-700" role="status">{{ notice }}</p>
      <button
        type="submit"
        class="btn-primary"
        :disabled="busy || (enabled && !guardians.length)"
        data-testid="managed-save"
      >
        {{ t('common.save') }}
      </button>
    </form>
    <div class="rounded-md bg-slate-50 p-3 text-xs dark:bg-slate-800/50">
      <h3 class="font-medium">{{ t('managed.chiefCan') }}</h3>
      <ul class="mt-1 list-disc space-y-0.5 pl-5">
        <li>{{ t('managed.can1') }}</li>
        <li>{{ t('managed.can2') }}</li>
        <li>{{ t('managed.can3') }}</li>
      </ul>
    </div>
  </section>
</template>
