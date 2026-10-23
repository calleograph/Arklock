<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { generatePassphrase, utf8 } from '@arklock/crypto';
import { api } from '../services/api';
import { errorMessage, vaultLabel } from '../services/helpers';
import { openSink } from '../services/download';
import {
  createCorporateRecoveryPackage,
  MIN_RECOVERY_PASSPHRASE,
  recoveryFingerprint,
  type RecoveryRecipient,
} from '../services/corporate-recovery';
import { useAuthStore } from '../stores/auth';

const props = defineProps<{
  pending: RecoveryRecipient | null;
  vaults: { id: string; name: string; enrolled: boolean; pendingEnrolled?: boolean }[];
}>();
const emit = defineEmits<{ changed: [message: string] }>();
const { t } = useI18n();
const auth = useAuthStore();

const phrase = ref('');
const showPhrase = ref(false);
const draft = ref<Awaited<ReturnType<typeof createCorporateRecoveryPackage>> | null>(null);
const downloaded = ref(false);
const acknowledged = ref(false);
const fingerprint = ref('');
const busy = ref(false);
const error = ref('');
onBeforeUnmount(() => {
  phrase.value = '';
  draft.value = null;
});

async function run(op: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  const release = auth.hold();
  try {
    await op();
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
    release();
  }
}
const generate = () => {
  phrase.value = generatePassphrase({ words: 6 });
  showPhrase.value = true;
};
const prepare = () =>
  run(async () => {
    draft.value = await createCorporateRecoveryPackage(phrase.value);
    fingerprint.value = await recoveryFingerprint(draft.value.recipient);
    phrase.value = '';
    showPhrase.value = false;
  });
const download = () =>
  run(async () => {
    const bytes = utf8(draft.value!.text);
    const sink = await openSink(
      `arklock-corporate-recovery-${draft.value!.recipient.id}.json`,
      bytes.length,
    );
    try {
      await sink.write(bytes);
      await sink.close();
      downloaded.value = true;
    } catch (e) {
      await sink.abort().catch(() => undefined);
      throw e;
    }
  });
const start = () =>
  run(async () => {
    await api('POST', '/admin/corporate-recovery/replacement', {
      ...draft.value!.recipient,
      packageSaved: true,
      proof: draft.value!.proof,
    });
    draft.value = null;
    downloaded.value = false;
    acknowledged.value = false;
    emit('changed', '');
  });
const complete = () =>
  run(async () => {
    await api('POST', '/admin/corporate-recovery/replacement/complete');
    emit('changed', t('corpReplace.done'));
  });
const cancel = () =>
  window.confirm(t('corpReplace.confirmCancel')) &&
  run(async () => {
    await api('DELETE', '/admin/corporate-recovery/replacement');
    emit('changed', t('corpReplace.cancelled'));
  });
</script>

<template>
  <div
    class="space-y-3 border-t border-slate-200 pt-4 text-sm dark:border-slate-800"
    data-testid="recovery-replacement"
  >
    <h3 class="font-medium">{{ t('corpReplace.title') }}</h3>
    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>
    <template v-if="pending">
      <p class="font-medium">{{ t('corpReplace.pendingTitle') }}</p>
      <p class="text-xs text-slate-500">{{ t('corpReplace.pendingHint') }}</p>
      <ul class="divide-y divide-slate-200 dark:divide-slate-800">
        <li
          v-for="v in vaults.filter((x) => x.enrolled)"
          :key="v.id"
          class="flex flex-wrap justify-between gap-2 py-2"
        >
          <span class="break-all">{{ vaultLabel(v, t) }}</span>
          <span
            :class="
              v.pendingEnrolled
                ? 'text-emerald-700 dark:text-emerald-300'
                : 'text-amber-700 dark:text-amber-300'
            "
            >{{ v.pendingEnrolled ? t('corpReplace.connected') : t('corpReplace.waiting') }}</span
          >
        </li>
      </ul>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="btn-primary"
          :disabled="busy"
          data-testid="replacement-complete"
          @click="complete"
        >
          {{ t('corpReplace.complete') }}
        </button>
        <button type="button" class="btn-danger" :disabled="busy" @click="cancel">
          {{ t('corpReplace.cancel') }}
        </button>
      </div>
    </template>
    <template v-else-if="!draft">
      <p class="text-xs text-slate-500">{{ t('corpReplace.intro') }}</p>
      <form class="space-y-2" @submit.prevent="prepare">
        <label class="block"
          ><span class="field-label">{{ t('corpRecovery.phrase') }}</span
          ><input
            v-model="phrase"
            :type="showPhrase ? 'text' : 'password'"
            :minlength="MIN_RECOVERY_PASSPHRASE"
            maxlength="512"
            autocomplete="new-password"
            required
            class="input"
            data-testid="replacement-phrase"
        /></label>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn" @click="generate">
            {{ t('corpRecovery.generatePhrase') }}
          </button>
          <button type="button" class="btn" @click="showPhrase = !showPhrase">
            {{ showPhrase ? t('common.hide') : t('common.show') }}
          </button>
          <button
            type="submit"
            class="btn-primary"
            :disabled="busy || phrase.length < MIN_RECOVERY_PASSPHRASE"
            data-testid="replacement-prepare"
          >
            {{ t('corpReplace.start') }}
          </button>
        </div>
      </form>
    </template>
    <template v-else>
      <p class="rounded-md bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        {{ t('corpRecovery.saveHint') }}
      </p>
      <p class="break-all font-mono text-xs">{{ fingerprint }}</p>
      <button
        type="button"
        class="btn-primary"
        :disabled="busy"
        data-testid="replacement-download"
        @click="download"
      >
        {{ t('corpRecovery.download') }}
      </button>
      <label class="flex items-start gap-2"
        ><input
          v-model="acknowledged"
          type="checkbox"
          :disabled="!downloaded || busy"
          class="mt-1"
        />{{ t('corpRecovery.savedAcknowledgement') }}</label
      >
      <button
        type="button"
        class="btn-primary"
        :disabled="busy || !downloaded || !acknowledged"
        data-testid="replacement-start"
        @click="start"
      >
        {{ t('corpReplace.start') }}
      </button>
    </template>
  </div>
</template>
