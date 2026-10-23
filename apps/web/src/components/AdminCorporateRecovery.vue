<script setup lang="ts">
import InfoHint from './InfoHint.vue';
import CorporateRecoveryReplacement from './CorporateRecoveryReplacement.vue';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { CryptoAuthError, CryptoFormatError, generatePassphrase, utf8 } from '@arklock/crypto';
import { api } from '../services/api';
import { errorMessage, vaultLabel } from '../services/helpers';
import { openSink } from '../services/download';
import {
  createCorporateRecoveryPackage,
  MIN_RECOVERY_PASSPHRASE,
  readCorporateRecoveryPackage,
  recoveryFingerprint,
  wipeRecoverySecrets,
  type RecoveryRecipient,
  type RecoverySecrets,
} from '../services/corporate-recovery';
import { useAuthStore } from '../stores/auth';
import { useWorkspaceStore } from '../stores/workspace';

const { t } = useI18n();
const auth = useAuthStore();
const ws = useWorkspaceStore();
const overview = ref<{
  recipient: RecoveryRecipient | null;
  pending?: RecoveryRecipient | null;
  vaults: {
    id: string;
    name: string;
    keyVersion: number;
    enrolled: boolean;
    pendingEnrolled?: boolean;
  }[];
} | null>(null);
const fingerprint = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');
const phrase = ref('');
const phraseAgain = ref('');
const showPhrase = ref(false);
const draft = ref<Awaited<ReturnType<typeof createCorporateRecoveryPackage>> | null>(null);
const downloaded = ref(false);
const acknowledged = ref(false);
const file = ref<File | null>(null);
const importPhrase = ref('');
const imported = ref(false);
const recoveryConfirmed = ref(false);
let secrets: RecoverySecrets | null = null;
let disposed = false;
function clearSecrets(): void {
  wipeRecoverySecrets(secrets);
  secrets = null;
  imported.value = false;
  importPhrase.value = '';
  phrase.value = '';
  phraseAgain.value = '';
  recoveryConfirmed.value = false;
}
watch(
  () => auth.unlocked,
  (unlocked) => {
    if (!unlocked) clearSecrets();
  },
);
onBeforeUnmount(() => {
  disposed = true;
  clearSecrets();
});
async function load(): Promise<void> {
  overview.value = await api('GET', '/admin/corporate-recovery');
  fingerprint.value = overview.value?.recipient
    ? await recoveryFingerprint(overview.value.recipient)
    : '';
}
async function run(operation: () => Promise<unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  const release = auth.hold();
  try {
    await operation();
  } catch (e) {
    error.value =
      e instanceof Error && e.message === 'recovery_package_mismatch'
        ? t('corpRecovery.packageMismatch')
        : e instanceof CryptoAuthError || e instanceof CryptoFormatError || e instanceof SyntaxError
          ? t('corpRecovery.packageInvalid')
          : errorMessage(e, t);
  } finally {
    busy.value = false;
    release();
  }
}
onMounted(() => run(load));
function generatePhrase(): void {
  phrase.value = generatePassphrase({ words: 6 });
  phraseAgain.value = phrase.value;
  showPhrase.value = true;
}
async function prepare(): Promise<void> {
  if (phrase.value !== phraseAgain.value || phrase.value.length < MIN_RECOVERY_PASSPHRASE) return;
  await run(async () => {
    draft.value = await createCorporateRecoveryPackage(phrase.value);
    phrase.value = '';
    phraseAgain.value = '';
    showPhrase.value = false;
    downloaded.value = false;
    acknowledged.value = false;
  });
}
function download(): void {
  if (!draft.value) return;
  const pkg = draft.value;
  void run(async () => {
    const bytes = utf8(pkg.text);
    const sink = await openSink(
      `arklock-corporate-recovery-${pkg.recipient.id}.json`,
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
}
function activate(): void {
  if (!draft.value || !downloaded.value || !acknowledged.value) return;
  const pkg = draft.value;
  void run(async () => {
    await api('POST', '/admin/corporate-recovery', {
      ...pkg.recipient,
      packageSaved: true,
      proof: pkg.proof,
    });
    draft.value = null;
    await load();
    notice.value = t('corpRecovery.activated');
  });
}
function chooseFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  clearSecrets();
  file.value = input.files?.[0] ?? null;
  input.value = '';
}
function unlockPackage(): void {
  if (!file.value || !overview.value?.recipient || !importPhrase.value) return;
  const selected = file.value;
  if (selected.size > 65536) {
    error.value = t('corpRecovery.packageInvalid');
    return;
  }
  void run(async () => {
    const keys = await readCorporateRecoveryPackage(await selected.text(), importPhrase.value);
    if (disposed || !auth.unlocked) {
      wipeRecoverySecrets(keys);
      throw new Error('locked');
    }
    const recipient = overview.value!.recipient!;
    if (
      keys.id !== recipient.id ||
      keys.publicKey !== recipient.publicKey ||
      keys.signPublicKey !== recipient.signPublicKey
    ) {
      wipeRecoverySecrets(keys);
      throw new Error('recovery_package_mismatch');
    }
    clearSecrets();
    secrets = keys;
    imported.value = true;
    file.value = null;
  });
}
function recover(vault: { id: string; name: string }): void {
  if (!secrets || !recoveryConfirmed.value) return;
  const keys = secrets;
  void run(async () => {
    await ws.recoverCorporateVault(vault.id, keys);
    await load();
    notice.value = t('corpRecovery.recovered', { name: vault.name });
  });
}
function toggleEnabled(): void {
  const recipient = overview.value?.recipient;
  if (!recipient) return;
  void run(async () => {
    await api('PATCH', '/admin/corporate-recovery', { enabled: recipient.enabled === false });
    clearSecrets();
    await load();
  });
}
</script>

<template>
  <section class="card space-y-4 p-4 sm:col-span-2 lg:col-span-3" data-testid="corporate-recovery">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="inline-flex items-center gap-1 font-semibold">
        {{ t('corpRecovery.title')
        }}<InfoHint :text="t('hint.corpRecovery.text')" :details="t('hint.corpRecovery.details')" />
      </h2>
      <button type="button" class="btn" :disabled="busy" @click="run(load)">
        {{ t('entryPanel.refresh') }}
      </button>
    </div>
    <p class="text-sm text-slate-500">{{ t('corpRecovery.intro') }}</p>
    <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
    <p v-if="notice" role="status" class="text-sm text-emerald-700 dark:text-emerald-300">
      {{ notice }}
    </p>
    <p v-if="!overview && busy" class="text-sm text-slate-500">{{ t('common.working') }}</p>
    <template v-if="overview">
      <template v-if="!overview.recipient">
        <form v-if="!draft" class="space-y-3" @submit.prevent="prepare">
          <fieldset class="space-y-3" :disabled="busy">
            <legend class="mb-2 text-sm font-medium">{{ t('corpRecovery.createPackage') }}</legend>
            <p class="text-xs text-slate-500">
              {{ t('corpRecovery.phraseHint', { n: MIN_RECOVERY_PASSPHRASE }) }}
            </p>
            <label class="block text-sm"
              ><span class="field-label">{{ t('corpRecovery.phrase') }}</span
              ><input
                v-model="phrase"
                :type="showPhrase ? 'text' : 'password'"
                :minlength="MIN_RECOVERY_PASSPHRASE"
                maxlength="512"
                autocomplete="new-password"
                required
                class="input"
                data-testid="recovery-new-phrase"
            /></label>
            <label class="block text-sm"
              ><span class="field-label">{{ t('corpRecovery.repeatPhrase') }}</span
              ><input
                v-model="phraseAgain"
                data-testid="recovery-repeat-phrase"
                :type="showPhrase ? 'text' : 'password'"
                maxlength="512"
                autocomplete="new-password"
                required
                class="input"
            /></label>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="btn" @click="generatePhrase">
                {{ t('corpRecovery.generatePhrase') }}</button
              ><button type="button" class="btn" @click="showPhrase = !showPhrase">
                {{ showPhrase ? t('common.hide') : t('common.show') }}
              </button>
            </div>
            <button
              type="submit"
              class="btn-primary"
              :disabled="phrase.length < MIN_RECOVERY_PASSPHRASE || phrase !== phraseAgain"
              data-testid="recovery-create-package"
            >
              {{ t('corpRecovery.createPackage') }}
            </button>
          </fieldset>
        </form>
        <div v-else class="space-y-3 text-sm">
          <p
            class="rounded-md bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          >
            {{ t('corpRecovery.saveHint') }}
          </p>
          <button
            type="button"
            class="btn-primary"
            :disabled="busy"
            data-testid="recovery-download"
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
              data-testid="recovery-package-saved"
            />{{ t('corpRecovery.savedAcknowledgement') }}</label
          >
          <button
            type="button"
            class="btn-primary"
            :disabled="busy || !downloaded || !acknowledged"
            data-testid="recovery-activate"
            @click="activate"
          >
            {{ t('corpRecovery.activate') }}
          </button>
        </div>
      </template>
      <template v-else>
        <div class="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
          <p class="font-medium">{{ t('corpRecovery.configured') }}</p>
          <p class="mt-1 break-all font-mono text-xs" data-testid="recovery-fingerprint">
            {{ fingerprint }}
          </p>
          <p class="mt-2 text-xs text-slate-500">{{ t('corpRecovery.fingerprintHint') }}</p>
        </div>
        <p class="text-xs text-slate-500">{{ t('corpRecovery.enrollmentHint') }}</p>
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span>{{
            t(
              overview.recipient.enabled === false
                ? 'corpRecovery.disabled'
                : 'corpRecovery.enabled',
            )
          }}</span
          ><button
            type="button"
            class="btn"
            :disabled="busy"
            data-testid="recovery-toggle-enabled"
            @click="toggleEnabled"
          >
            {{
              t(
                overview.recipient.enabled === false
                  ? 'corpRecovery.enable'
                  : 'corpRecovery.disable',
              )
            }}
          </button>
        </div>
        <fieldset class="space-y-3" :disabled="busy">
          <legend class="mb-2 text-sm font-medium">{{ t('corpRecovery.restoreAccess') }}</legend>
          <template v-if="!imported">
            <label class="block text-sm"
              ><span class="field-label">{{ t('corpRecovery.file') }}</span
              ><input
                type="file"
                accept=".json,application/json"
                class="input"
                data-testid="recovery-import-file"
                @change="chooseFile"
            /></label>
            <p v-if="file" class="break-all text-xs text-slate-500">{{ file.name }}</p>
            <label class="block text-sm"
              ><span class="field-label">{{ t('corpRecovery.phrase') }}</span
              ><input
                v-model="importPhrase"
                type="password"
                maxlength="512"
                autocomplete="off"
                class="input"
                data-testid="recovery-import-phrase"
                @keydown.enter.prevent="unlockPackage"
            /></label>
            <button
              type="button"
              class="btn"
              :disabled="!file || !importPhrase"
              data-testid="recovery-unlock-package"
              @click="unlockPackage"
            >
              {{ t('corpRecovery.unlockPackage') }}
            </button>
          </template>
          <template v-else
            ><p class="text-sm text-emerald-700 dark:text-emerald-300">
              {{ t('corpRecovery.packageReady') }}
            </p>
            <button type="button" class="btn" @click="clearSecrets">
              {{ t('corpRecovery.forgetKeys') }}</button
            ><label class="flex items-start gap-2 text-sm"
              ><input
                v-model="recoveryConfirmed"
                type="checkbox"
                class="mt-1"
                data-testid="recovery-claim-confirm"
              />{{ t('corpRecovery.recoveryAcknowledgement') }}</label
            ></template
          >
          <ul class="divide-y divide-slate-200 text-sm dark:divide-slate-800">
            <li
              v-for="vault in overview.vaults"
              :key="vault.id"
              class="flex flex-wrap items-center justify-between gap-2 py-3"
              data-testid="recovery-vault-row"
            >
              <div>
                <p class="break-all font-medium">{{ vaultLabel(vault, t) }}</p>
                <p
                  :class="
                    vault.enrolled
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-amber-700 dark:text-amber-300'
                  "
                >
                  {{ t(vault.enrolled ? 'corpRecovery.protected' : 'corpRecovery.notProtected') }} ·
                  v{{ vault.keyVersion }}
                </p>
              </div>
              <button
                type="button"
                class="btn"
                :disabled="
                  !vault.enrolled ||
                  !imported ||
                  !recoveryConfirmed ||
                  overview.recipient.enabled === false
                "
                @click="recover(vault)"
              >
                {{ t('corpRecovery.recover') }}
              </button>
            </li>
            <li v-if="!overview.vaults.length" class="py-2 text-slate-500">
              {{ t('corporate.noVaults') }}
            </li>
          </ul>
        </fieldset>
        <CorporateRecoveryReplacement
          :pending="overview.pending ?? null"
          :vaults="overview.vaults"
          @changed="
            (m: string) =>
              run(async () => {
                clearSecrets();
                await load();
                notice = m;
              })
          "
        />
      </template>
    </template>
  </section>
</template>
