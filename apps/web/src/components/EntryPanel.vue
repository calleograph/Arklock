<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  estimateStrength,
  generatePassphrase,
  generatePassword,
  parseTotpInput,
  totp,
  totpRemaining,
} from '@arklock/crypto';
import {
  blankEntry,
  ENTRY_KINDS,
  normalizeEntry,
  type BranchItem,
  type EntryData,
  type EntryItem,
} from '../services/model';
import { useWorkspaceStore } from '../stores/workspace';
import { errorMessage } from '../services/helpers';
import { api } from '../services/api';
import type { VaultView } from '../stores/workspace';

const props = defineProps<{
  /** Выбранная запись; null — создание новой. */
  item: EntryItem | null;
  creating: boolean;
  branchId: string | null;
  vault: VaultView;
  branches: BranchItem[];
}>();
const emit = defineEmits<{
  (e: 'saved', item: EntryItem): void;
  (e: 'cancel'): void;
  (e: 'changed'): void;
}>();

const { t } = useI18n();
const clone = <T,>(v: T): T => structuredClone(v);
const ws = useWorkspaceStore();

const editing = ref(props.creating);
const form = ref<EntryData>(props.item ? clone(normalizeEntry(props.item.data)) : blankEntry());
const tagsText = ref(form.value.tags.join(', '));
const showPw = ref(false);
const revealed = ref<Set<number>>(new Set());
const error = ref('');
const busy = ref(false);
const tab = ref<'details' | 'history' | 'share'>('details');
const branchChoice = ref<string | null>(props.item?.branchId ?? props.branchId);

watch(
  () => [props.item?.id, props.creating],
  () => {
    editing.value = props.creating;
    form.value = props.item ? clone(normalizeEntry(props.item.data)) : blankEntry();
    tagsText.value = form.value.tags.join(', ');
    showPw.value = false;
    revealed.value = new Set();
    error.value = '';
    tab.value = 'details';
    branchChoice.value = props.item?.branchId ?? props.branchId;
    history.value = null;
    link.value = '';
  },
);

const canEdit = computed(() => !props.item || props.item.access !== 'reader');
const strength = computed(() => estimateStrength(form.value.password));
const branchOptions = computed(() =>
  [...props.branches].sort((a, b) => a.name.localeCompare(b.name)),
);

// ---- TOTP
const code = ref('');
const remaining = ref(30);
let timer: ReturnType<typeof setInterval> | null = null;
async function refreshCode(): Promise<void> {
  const src = (editing.value ? form.value.totp : props.item?.data.totp) ?? '';
  if (!src) {
    code.value = '';
    return;
  }
  try {
    const p = parseTotpInput(src);
    code.value = await totp(p);
    remaining.value = totpRemaining(p.period ?? 30);
  } catch {
    code.value = '';
  }
}
watch(() => [props.item?.id, props.item?.data.totp, form.value.totp, editing.value], refreshCode, {
  immediate: true,
});
timer = setInterval(refreshCode, 1000);
onBeforeUnmount(() => timer && clearInterval(timer));

// ---- буфер обмена
const copied = ref('');
async function copy(label: string, value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = label;
    setTimeout(async () => {
      copied.value = '';
      try {
        if ((await navigator.clipboard.readText()) === value)
          await navigator.clipboard.writeText('');
      } catch {
        /* чтение буфера может быть запрещено */
      }
    }, 30_000);
  } catch {
    /* буфер недоступен */
  }
}

function generate(kind: 'password' | 'phrase'): void {
  form.value.password =
    kind === 'password' ? generatePassword({ length: 20 }) : generatePassphrase({ words: 5 });
  showPw.value = true;
}

function addField(): void {
  form.value.fields.push({ name: '', value: '', secret: false });
}

async function save(): Promise<void> {
  error.value = '';
  if (!form.value.title.trim()) {
    error.value = t('vault.titleRequired');
    return;
  }
  if (form.value.totp) {
    try {
      parseTotpInput(form.value.totp);
    } catch {
      error.value = t('vault.totpInvalid');
      return;
    }
  }
  busy.value = true;
  try {
    form.value.tags = tagsText.value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    form.value.fields = form.value.fields.filter((f) => f.name.trim());
    const saved = await ws.saveEntry(form.value, props.item ?? undefined, branchChoice.value);
    editing.value = false;
    emit('saved', saved);
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

// ---- история
const history = ref<
  { rev: { id: string; version: number; savedAt: string }; data: EntryData | null }[] | null
>(null);
async function loadHistory(): Promise<void> {
  tab.value = 'history';
  if (props.item) history.value = await ws.revisions(props.item);
}
async function revert(id: string): Promise<void> {
  if (!props.item) return;
  busy.value = true;
  try {
    await ws.restoreRevision(props.item, id);
    emit('changed');
    history.value = null;
    tab.value = 'details';
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

// ---- ссылка передачи
const link = ref('');
const share = ref({ passphrase: '', minutes: 60, views: 1, notes: false });
async function createLink(): Promise<void> {
  if (!props.item) return;
  busy.value = true;
  error.value = '';
  try {
    link.value = await ws.createLink(props.item, {
      passphrase: share.value.passphrase,
      expiresInMinutes: Number(share.value.minutes),
      maxViews: Number(share.value.views),
      includeNotes: share.value.notes,
    });
  } catch (e) {
    error.value = errorMessage(e, t);
  } finally {
    busy.value = false;
  }
}

const fmt = (iso: string) => new Date(iso).toLocaleString();
void api;
</script>

<template>
  <section class="card p-4" data-testid="entry-panel">
    <!-- Просмотр -->
    <template v-if="item && !editing">
      <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <h2 class="truncate text-lg font-semibold" data-testid="view-title">
            {{ item.data.title }}
          </h2>
          <div class="mt-1 flex flex-wrap gap-1">
            <span class="badge">{{ t(`kind.${item.data.kind}`) }}</span>
            <span v-for="tag in item.data.tags" :key="tag" class="badge">#{{ tag }}</span>
          </div>
        </div>
        <div class="flex gap-1">
          <button
            v-if="canEdit"
            type="button"
            class="btn"
            data-testid="btn-edit"
            @click="editing = true"
          >
            {{ t('vault.edit') }}
          </button>
          <button
            type="button"
            class="btn"
            :title="t('vault.pin')"
            data-testid="btn-pin"
            @click="ws.setPinned(item, !item.pinned)"
          >
            {{ item.pinned ? '★' : '☆' }}
          </button>
        </div>
      </div>

      <div class="mb-3 flex gap-1 border-b border-slate-200 text-sm dark:border-slate-800">
        <button
          type="button"
          class="px-3 py-1"
          :class="tab === 'details' ? 'border-b-2 border-brand-500 font-medium' : ''"
          @click="tab = 'details'"
        >
          {{ t('vault.details') }}
        </button>
        <button
          type="button"
          class="px-3 py-1"
          :class="tab === 'history' ? 'border-b-2 border-brand-500 font-medium' : ''"
          data-testid="tab-history"
          @click="loadHistory"
        >
          {{ t('vault.history') }}
        </button>
        <button
          type="button"
          class="px-3 py-1"
          :class="tab === 'share' ? 'border-b-2 border-brand-500 font-medium' : ''"
          data-testid="tab-share"
          @click="tab = 'share'"
        >
          {{ t('vault.share') }}
        </button>
      </div>

      <dl v-if="tab === 'details'" class="space-y-3 text-sm">
        <div v-if="item.data.username">
          <dt class="text-xs text-slate-500">{{ t('vault.username') }}</dt>
          <dd class="flex items-center justify-between gap-2">
            <span class="break-all" data-testid="view-username">{{ item.data.username }}</span>
            <button type="button" class="btn" @click="copy('username', item.data.username)">
              {{ copied === 'username' ? t('common.copied') : t('common.copy') }}
            </button>
          </dd>
        </div>
        <div v-if="item.data.password">
          <dt class="text-xs text-slate-500">
            {{ item.data.kind === 'apikey' ? t('vault.secret') : t('vault.password') }}
          </dt>
          <dd class="flex items-center justify-between gap-2">
            <span class="break-all font-mono" data-testid="view-password">{{
              revealed.has(-1) ? item.data.password : '••••••••••'
            }}</span>
            <span class="flex shrink-0 gap-1">
              <button
                type="button"
                class="btn"
                data-testid="btn-reveal"
                @click="
                  revealed.has(-1) ? revealed.delete(-1) : revealed.add(-1);
                  revealed = new Set(revealed);
                "
              >
                {{ revealed.has(-1) ? t('common.hide') : t('common.show') }}
              </button>
              <button
                type="button"
                class="btn"
                data-testid="btn-copy-password"
                @click="copy('password', item.data.password)"
              >
                {{ copied === 'password' ? t('common.copied') : t('common.copy') }}
              </button>
            </span>
          </dd>
        </div>
        <div v-if="item.data.url">
          <dt class="text-xs text-slate-500">{{ t('vault.url') }}</dt>
          <dd class="break-all">
            <a
              v-if="/^https?:\/\//i.test(item.data.url)"
              :href="item.data.url"
              target="_blank"
              rel="noopener noreferrer"
              class="text-brand-600 underline"
              >{{ item.data.url }}</a
            >
            <span v-else>{{ item.data.url }}</span>
          </dd>
        </div>
        <div v-if="code">
          <dt class="text-xs text-slate-500">{{ t('vault.totp') }}</dt>
          <dd class="flex items-center justify-between gap-2">
            <span class="font-mono text-lg tracking-widest" data-testid="view-totp">{{
              code
            }}</span>
            <span class="text-xs text-slate-500">{{ remaining }} {{ t('vault.sec') }}</span>
            <button type="button" class="btn" @click="copy('totp', code)">
              {{ copied === 'totp' ? t('common.copied') : t('common.copy') }}
            </button>
          </dd>
        </div>
        <div v-for="(f, i) in item.data.fields" :key="i">
          <dt class="text-xs text-slate-500">{{ f.name }}</dt>
          <dd class="flex items-center justify-between gap-2">
            <span class="break-all" :class="f.secret ? 'font-mono' : ''">{{
              f.secret && !revealed.has(i) ? '••••••••' : f.value
            }}</span>
            <span class="flex gap-1">
              <button
                v-if="f.secret"
                type="button"
                class="btn"
                @click="
                  revealed.has(i) ? revealed.delete(i) : revealed.add(i);
                  revealed = new Set(revealed);
                "
              >
                {{ revealed.has(i) ? t('common.hide') : t('common.show') }}
              </button>
              <button type="button" class="btn" @click="copy('f' + i, f.value)">
                {{ copied === 'f' + i ? t('common.copied') : t('common.copy') }}
              </button>
            </span>
          </dd>
        </div>
        <div v-if="item.data.notes">
          <dt class="text-xs text-slate-500">{{ t('vault.notes') }}</dt>
          <dd class="whitespace-pre-wrap break-words" data-testid="view-notes">
            {{ item.data.notes }}
          </dd>
        </div>
        <div class="text-xs text-slate-500">
          {{ t('vault.updated') }}: {{ fmt(item.updatedAt) }}
          <span v-if="item.data.expiresAt">
            · {{ t('vault.expires') }}: {{ item.data.expiresAt }}</span
          >
        </div>
      </dl>

      <div v-else-if="tab === 'history'" data-testid="history-list">
        <p v-if="!history" class="text-sm text-slate-500">{{ t('common.working') }}</p>
        <p v-else-if="!history.length" class="text-sm text-slate-500">{{ t('vault.noHistory') }}</p>
        <ul v-else class="divide-y divide-slate-200 text-sm dark:divide-slate-800">
          <li
            v-for="h in history"
            :key="h.rev.id"
            class="flex items-center justify-between gap-2 py-2"
            data-testid="history-row"
          >
            <div class="min-w-0">
              <div class="font-medium">v{{ h.rev.version }} · {{ fmt(h.rev.savedAt) }}</div>
              <div class="truncate text-xs text-slate-500">
                {{ h.data ? `${h.data.title} · ${h.data.username}` : t('vault.undecryptable') }}
              </div>
            </div>
            <button
              v-if="canEdit && h.data"
              type="button"
              class="btn shrink-0"
              :disabled="busy"
              data-testid="btn-revert"
              @click="revert(h.rev.id)"
            >
              {{ t('vault.revert') }}
            </button>
          </li>
        </ul>
      </div>

      <div v-else class="space-y-3 text-sm">
        <p class="text-slate-500">{{ t('vault.shareHint') }}</p>
        <div class="grid grid-cols-2 gap-2">
          <label class="block"
            ><span class="mb-1 block text-xs">{{ t('vault.linkLifetime') }}</span>
            <select v-model="share.minutes" class="input" data-testid="share-minutes">
              <option :value="15">15 {{ t('vault.min') }}</option>
              <option :value="60">1 {{ t('vault.hour') }}</option>
              <option :value="1440">24 {{ t('vault.hour') }}</option>
              <option :value="10080">7 {{ t('vault.days') }}</option>
            </select></label
          >
          <label class="block"
            ><span class="mb-1 block text-xs">{{ t('vault.linkViews') }}</span>
            <select v-model="share.views" class="input" data-testid="share-views">
              <option :value="1">1</option>
              <option :value="3">3</option>
              <option :value="10">10</option>
            </select></label
          >
        </div>
        <label class="block"
          ><span class="mb-1 block text-xs">{{ t('vault.linkPassphrase') }}</span>
          <input
            v-model="share.passphrase"
            type="password"
            autocomplete="off"
            class="input"
            data-testid="share-passphrase"
        /></label>
        <label class="flex items-center gap-2"
          ><input v-model="share.notes" type="checkbox" /> {{ t('vault.linkNotes') }}</label
        >
        <button
          type="button"
          class="btn-primary"
          :disabled="busy"
          data-testid="btn-create-link"
          @click="createLink"
        >
          {{ t('vault.createLink') }}
        </button>
        <div v-if="link" class="rounded-md bg-emerald-50 p-2 dark:bg-emerald-950">
          <p class="break-all font-mono text-xs" data-testid="share-link">{{ link }}</p>
          <button type="button" class="btn mt-2" @click="copy('link', link)">
            {{ copied === 'link' ? t('common.copied') : t('common.copy') }}
          </button>
        </div>
      </div>
      <p v-if="error" class="mt-2 text-sm text-red-600" role="alert">{{ error }}</p>
    </template>

    <!-- Редактор -->
    <form v-else-if="editing" class="space-y-3" data-testid="entry-form" @submit.prevent="save">
      <h2 class="font-semibold">{{ item ? t('vault.edit') : t('vault.add') }}</h2>
      <div class="grid grid-cols-2 gap-2">
        <label class="block text-sm"
          ><span class="mb-1 block">{{ t('vault.kind') }}</span>
          <select v-model="form.kind" class="input" data-testid="f-kind">
            <option v-for="k in ENTRY_KINDS" :key="k" :value="k">{{ t(`kind.${k}`) }}</option>
          </select></label
        >
        <label class="block text-sm"
          ><span class="mb-1 block">{{ t('vault.folder') }}</span>
          <select v-model="branchChoice" class="input" data-testid="f-folder">
            <option :value="null">{{ t('vault.root') }}</option>
            <option v-for="b in branchOptions" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select></label
        >
      </div>
      <label class="block text-sm"
        ><span class="mb-1 block">{{ t('vault.entryTitle') }}</span>
        <input v-model="form.title" required maxlength="200" class="input" data-testid="f-title"
      /></label>
      <template v-if="form.kind !== 'note'">
        <label class="block text-sm"
          ><span class="mb-1 block">{{
            form.kind === 'apikey' ? t('vault.keyId') : t('vault.username')
          }}</span>
          <input
            v-model="form.username"
            maxlength="300"
            autocomplete="off"
            class="input"
            data-testid="f-username"
        /></label>
        <div class="text-sm">
          <span class="mb-1 block">{{
            form.kind === 'apikey' ? t('vault.secret') : t('vault.password')
          }}</span>
          <div class="flex gap-1">
            <input
              v-model="form.password"
              :type="showPw ? 'text' : 'password'"
              autocomplete="new-password"
              class="input font-mono"
              data-testid="f-password"
            />
            <button type="button" class="btn" @click="showPw = !showPw">
              {{ showPw ? t('common.hide') : t('common.show') }}
            </button>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              class="text-brand-600 underline"
              data-testid="btn-generate"
              @click="generate('password')"
            >
              {{ t('vault.generate') }}
            </button>
            <button
              type="button"
              class="text-brand-600 underline"
              data-testid="btn-phrase"
              @click="generate('phrase')"
            >
              {{ t('vault.generatePhrase') }}
            </button>
            <span
              v-if="form.password"
              :class="
                strength.score >= 3
                  ? 'text-emerald-600'
                  : strength.score === 2
                    ? 'text-amber-600'
                    : 'text-red-600'
              "
              data-testid="strength"
              >{{ t(`strength.${strength.score}`) }} · {{ strength.bits }}
              {{ t('vault.bits') }}</span
            >
          </div>
        </div>
        <label class="block text-sm"
          ><span class="mb-1 block">{{ t('vault.url') }}</span>
          <input v-model="form.url" maxlength="500" class="input" data-testid="f-url"
        /></label>
        <label class="block text-sm"
          ><span class="mb-1 block">{{ t('vault.totpSecret') }}</span>
          <input
            v-model="form.totp"
            autocomplete="off"
            spellcheck="false"
            class="input font-mono"
            data-testid="f-totp"
            placeholder="otpauth://… / JBSWY3DPEHPK3PXP"
          />
          <span v-if="code" class="mt-1 block font-mono text-xs text-slate-500"
            >{{ t('vault.totpPreview') }}: {{ code }}</span
          ></label
        >
      </template>
      <label class="block text-sm"
        ><span class="mb-1 block">{{ t('vault.notes') }}</span>
        <textarea
          v-model="form.notes"
          rows="form.kind === 'note' ? 8 : 3"
          maxlength="20000"
          class="input"
          data-testid="f-notes"
        />
      </label>

      <fieldset class="space-y-2">
        <legend class="text-sm">{{ t('vault.fields') }}</legend>
        <div v-for="(f, i) in form.fields" :key="i" class="flex gap-1">
          <input
            v-model="f.name"
            :placeholder="t('vault.fieldName')"
            class="input"
            :data-testid="`field-name-${i}`"
          />
          <input
            v-model="f.value"
            :type="f.secret ? 'password' : 'text'"
            :placeholder="t('vault.fieldValue')"
            class="input"
            :data-testid="`field-value-${i}`"
          />
          <label class="flex items-center gap-1 text-xs"
            ><input v-model="f.secret" type="checkbox" />{{ t('vault.secretField') }}</label
          >
          <button type="button" class="btn" @click="form.fields.splice(i, 1)">×</button>
        </div>
        <button type="button" class="btn" data-testid="btn-add-field" @click="addField">
          {{ t('vault.addField') }}
        </button>
      </fieldset>

      <div class="grid grid-cols-2 gap-2">
        <label class="block text-sm"
          ><span class="mb-1 block">{{ t('vault.tags') }}</span>
          <input v-model="tagsText" class="input" data-testid="f-tags" placeholder="work, prod"
        /></label>
        <label class="block text-sm"
          ><span class="mb-1 block">{{ t('vault.expires') }}</span>
          <input v-model="form.expiresAt" type="date" class="input"
        /></label>
      </div>

      <p v-if="error" class="text-sm text-red-600" role="alert" data-testid="form-error">
        {{ error }}
      </p>
      <div class="flex gap-2">
        <button type="submit" class="btn-primary" :disabled="busy" data-testid="f-save">
          {{ t('common.save') }}
        </button>
        <button
          type="button"
          class="btn"
          @click="
            item ? ((editing = false), (form = clone(normalizeEntry(item.data)))) : emit('cancel')
          "
        >
          {{ t('common.cancel') }}
        </button>
      </div>
    </form>
    <p v-else class="text-sm text-slate-500">{{ t('vault.selectEntry') }}</p>
    <span class="hidden">{{ vault.id }}</span>
  </section>
</template>
