<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { errorMessage } from '../services/helpers';
import { recoveryFingerprint, type RecoveryRecipient } from '../services/corporate-recovery';
import { useWorkspaceStore } from '../stores/workspace';
const props = defineProps<{ vaultId: string }>();
const { t } = useI18n();
const ws = useWorkspaceStore();
const vault = computed(() => ws.vaults.find((v) => v.id === props.vaultId));
const data = ref<{
  recipient: RecoveryRecipient | null;
  rescue: { keyVersion: number; recipientId: string } | null;
} | null>(null);
const fingerprint = ref('');
const confirmed = ref(false);
const busy = ref(false);
const error = ref('');
const protectedNow = computed(
  () =>
    !!data.value?.rescue &&
    data.value.rescue.keyVersion === vault.value?.keyVersion &&
    data.value.rescue.recipientId === data.value.recipient?.id,
);
async function load(): Promise<void> {
  if (!vault.value?.canManageMembers) return;
  error.value = '';
  try {
    data.value = await api('GET', `/vaults/${props.vaultId}/recovery`);
    fingerprint.value = data.value?.recipient
      ? await recoveryFingerprint(data.value.recipient)
      : '';
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}
onMounted(load);
watch(
  () => `${vault.value?.id}|${vault.value?.keyVersion}|${vault.value?.canManageMembers}`,
  () => {
    confirmed.value = false;
    void load();
  },
);
async function enroll(): Promise<void> {
  if (busy.value || !confirmed.value || !data.value?.recipient) return;
  busy.value = true;
  error.value = '';
  try {
    await ws.enrollCorporateRecovery(props.vaultId, data.value.recipient);
    confirmed.value = false;
    await load();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section
    v-if="vault?.kind === 'shared' && vault.canManageMembers"
    class="card space-y-3 p-4 text-sm"
    data-testid="vault-corporate-recovery"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="inline-flex items-center gap-1 font-medium">
        {{ t('corpRecovery.title')
        }}<InfoHint :text="t('hint.corpRecovery.text')" :details="t('hint.corpRecovery.details')" />
      </h2>
      <button type="button" class="btn" :disabled="busy" @click="load">
        {{ t('entryPanel.refresh') }}
      </button>
    </div>
    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>
    <p v-if="!data && !error" class="text-slate-500">{{ t('common.working') }}</p>
    <p v-else-if="data && !data.recipient" class="text-slate-500">
      {{ t('corpRecovery.notConfigured') }}
    </p>
    <template v-else-if="data?.recipient">
      <p
        :class="
          protectedNow
            ? 'text-emerald-700 dark:text-emerald-300'
            : 'text-amber-700 dark:text-amber-300'
        "
        data-testid="vault-recovery-status"
      >
        {{
          t(
            protectedNow
              ? 'corpRecovery.protected'
              : data.rescue
                ? 'corpRecovery.stale'
                : 'corpRecovery.notProtected',
          )
        }}
        · v{{ vault.keyVersion }}
      </p>
      <p class="text-xs text-slate-500">{{ t('corpRecovery.enrollmentHint') }}</p>
      <p v-if="data.recipient.enabled === false" class="text-amber-700 dark:text-amber-300">
        {{ t('corpRecovery.disabled') }}
      </p>
      <p class="break-all font-mono text-xs">{{ fingerprint }}</p>
      <template v-if="!protectedNow && data.recipient.enabled !== false"
        ><label class="flex items-start gap-2"
          ><input
            v-model="confirmed"
            data-testid="vault-recovery-confirm"
            type="checkbox"
            :disabled="busy || !vault.unlocked"
            class="mt-1"
          />{{ t('corpRecovery.enrollmentAcknowledgement') }}</label
        ><button
          type="button"
          class="btn-primary"
          :disabled="busy || !confirmed || !vault.unlocked"
          data-testid="vault-recovery-enroll"
          @click="enroll"
        >
          {{ t('corpRecovery.enroll') }}
        </button></template
      >
    </template>
  </section>
</template>
