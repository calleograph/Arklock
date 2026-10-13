<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { generatePassphrase, generatePassword } from '@arklock/crypto';

/** Генератор паролей и парольных фраз с настройками; выбранные настройки запоминаются для пользователя. */
const props = defineProps<{ minLength: number }>();
const emit = defineEmits<{ use: [value: string] }>();
const { t } = useI18n();

const KEY = 'arklock.generator';
interface Options {
  mode: 'password' | 'phrase';
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
  words: number;
  capitalize: boolean;
  appendNumber: boolean;
}
const DEFAULTS: Options = {
  mode: 'password',
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: false,
  words: 5,
  capitalize: true,
  appendNumber: false,
};
function load(): Options {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Options>) };
  } catch {
    return { ...DEFAULTS };
  }
}

const opts = ref<Options>(load());
const preview = ref('');
const error = ref('');
const copied = ref(false);

watch(
  opts,
  (v) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* хранилище недоступно: настройки действуют до закрытия */
    }
  },
  { deep: true },
);

function regenerate(): void {
  error.value = '';
  copied.value = false;
  const o = opts.value;
  try {
    preview.value =
      o.mode === 'password'
        ? generatePassword({
            length: Math.max(o.length, props.minLength),
            lower: o.lower,
            upper: o.upper,
            digits: o.digits,
            symbols: o.symbols,
            avoidAmbiguous: o.avoidAmbiguous,
          })
        : generatePassphrase({
            words: o.words,
            capitalize: o.capitalize,
            appendNumber: o.appendNumber,
          });
  } catch {
    preview.value = '';
    error.value = t('generator.needClass');
  }
}

async function copy(): Promise<void> {
  if (!preview.value) return;
  try {
    await navigator.clipboard.writeText(preview.value);
    copied.value = true;
  } catch {
    error.value = t('generator.copyFailed');
  }
}

watch(() => opts.value.mode, regenerate);
onMounted(regenerate);
</script>

<template>
  <div
    class="space-y-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"
    data-testid="generator"
  >
    <div class="flex gap-2" role="group" :aria-label="t('generator.title')">
      <button
        type="button"
        class="btn"
        :aria-pressed="opts.mode === 'password'"
        data-testid="gen-mode-password"
        @click="opts.mode = 'password'"
      >
        {{ t('generator.password') }}
      </button>
      <button
        type="button"
        class="btn"
        :aria-pressed="opts.mode === 'phrase'"
        data-testid="gen-mode-phrase"
        @click="opts.mode = 'phrase'"
      >
        {{ t('generator.phrase') }}
      </button>
    </div>

    <template v-if="opts.mode === 'password'">
      <label class="flex items-center gap-3">
        <span class="w-20 shrink-0">{{ t('generator.length') }}</span>
        <input
          v-model.number="opts.length"
          type="range"
          min="8"
          max="128"
          class="flex-1"
          data-testid="gen-length"
          @change="regenerate"
        />
        <span class="w-8 text-right font-mono" data-testid="gen-length-value">{{
          opts.length
        }}</span>
      </label>
      <div class="flex flex-wrap gap-x-4 gap-y-2">
        <label class="flex items-center gap-1"
          ><input v-model="opts.lower" type="checkbox" @change="regenerate" />
          {{ t('generator.lower') }}</label
        >
        <label class="flex items-center gap-1"
          ><input v-model="opts.upper" type="checkbox" @change="regenerate" />
          {{ t('generator.upper') }}</label
        >
        <label class="flex items-center gap-1"
          ><input v-model="opts.digits" type="checkbox" @change="regenerate" />
          {{ t('generator.digits') }}</label
        >
        <label class="flex items-center gap-1"
          ><input v-model="opts.symbols" type="checkbox" @change="regenerate" />
          {{ t('generator.symbols') }}</label
        >
        <label class="flex items-center gap-1"
          ><input
            v-model="opts.avoidAmbiguous"
            type="checkbox"
            data-testid="gen-avoid"
            @change="regenerate"
          />
          {{ t('generator.avoidAmbiguous') }}</label
        >
      </div>
    </template>
    <template v-else>
      <label class="flex items-center gap-3">
        <span class="w-20 shrink-0">{{ t('generator.words') }}</span>
        <input
          v-model.number="opts.words"
          type="range"
          min="3"
          max="12"
          class="flex-1"
          @change="regenerate"
        />
        <span class="w-8 text-right font-mono">{{ opts.words }}</span>
      </label>
      <div class="flex flex-wrap gap-x-4 gap-y-2">
        <label class="flex items-center gap-1"
          ><input v-model="opts.capitalize" type="checkbox" @change="regenerate" />
          {{ t('generator.capitalize') }}</label
        >
        <label class="flex items-center gap-1"
          ><input v-model="opts.appendNumber" type="checkbox" @change="regenerate" />
          {{ t('generator.appendNumber') }}</label
        >
      </div>
    </template>

    <p
      class="break-all rounded bg-slate-50 p-2 font-mono dark:bg-slate-800"
      data-testid="generator-preview"
    >
      {{ preview }}
    </p>
    <p v-if="error" class="text-red-700 dark:text-red-300" role="alert">{{ error }}</p>
    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn" data-testid="gen-new" @click="regenerate">
        {{ t('generator.regenerate') }}
      </button>
      <button type="button" class="btn" data-testid="gen-copy" :disabled="!preview" @click="copy">
        {{ copied ? t('common.copied') : t('generator.copy') }}
      </button>
      <button
        type="button"
        class="btn-primary"
        data-testid="gen-use"
        :disabled="!preview"
        @click="emit('use', preview)"
      >
        {{ t('generator.use') }}
      </button>
    </div>
  </div>
</template>
