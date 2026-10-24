<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import NotificationPreferences from '../components/NotificationPreferences.vue';
import PinSettings from '../components/PinSettings.vue';
import PersonalVaultErase from '../components/PersonalVaultErase.vue';
import { useWorkspaceStore } from '../stores/workspace';
import { DEFAULT_THEME, isTheme, PREVIEW, THEMES, type ThemeId } from '../services/theme';
import { errorMessage, spaceLabel } from '../services/helpers';
import {
  AUTO_LOCK_OPTIONS,
  autoLockMinutes,
  setAutoLockMinutes,
  type AutoLockMinutes,
} from '../services/autolock';

const { t, locale } = useI18n();
const auth = useAuthStore();
const ws = useWorkspaceStore();
// сведения о прежнем личном сейфе приходят вместе со списком сейфов; после F5 в «Настройках» его ещё нет
if (!ws.vaults.length) void ws.loadVaults().catch(() => undefined);
const error = ref('');
const notice = ref('');
const lockMinutes = ref<AutoLockMinutes>(autoLockMinutes());

function chooseLock(minutes: AutoLockMinutes): void {
  lockMinutes.value = minutes;
  setAutoLockMinutes(minutes);
}

const current = (): ThemeId =>
  isTheme(auth.user?.theme) ? (auth.user!.theme as ThemeId) : DEFAULT_THEME;

async function choose(id: ThemeId): Promise<void> {
  error.value = '';
  notice.value = '';
  try {
    await auth.setTheme(id);
    notice.value = t('prefs.themeSaved');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}

// пространство при входе: пусто — организация по умолчанию (прежнее поведение)
const homeSpace = ref(auth.user?.homeSpace ?? '');
const homeNotice = ref('');
async function chooseHome(value: string): Promise<void> {
  error.value = '';
  homeNotice.value = '';
  try {
    await auth.setHomeSpace(value || null);
    homeSpace.value = value;
    homeNotice.value = t('prefs.homeSaved');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
}

function setLocale(value: 'ru' | 'en'): void {
  locale.value = value;
  document.documentElement.lang = value;
  try {
    localStorage.setItem('arklock.locale', value);
  } catch {
    /* не критично */
  }
}
</script>

<template>
  <section class="mx-auto max-w-4xl space-y-8">
    <header>
      <h1>{{ t('prefs.title') }}</h1>
      <p class="mt-1 text-sm text-slate-500">
        {{ t('prefs.signedInAs') }}
        <strong class="text-slate-700 dark:text-slate-200">{{ auth.user?.email }}</strong>
      </p>
    </header>

    <div>
      <h2>{{ t('prefs.appearance') }}</h2>
      <p class="mb-4 mt-1 text-sm text-slate-500">{{ t('prefs.appearanceHint') }}</p>
      <p v-if="error" class="notice notice-error mb-3" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="notice notice-ok mb-3" role="status" data-testid="theme-notice">
        {{ notice }}
      </p>
      <div
        class="grid grid-cols-2 gap-3 sm:grid-cols-3"
        role="radiogroup"
        :aria-label="t('prefs.appearance')"
      >
        <button
          v-for="id in THEMES"
          :key="id"
          type="button"
          role="radio"
          :aria-checked="current() === id"
          :data-testid="`theme-${id}`"
          class="group rounded-xl border p-3 text-left transition-shadow hover:shadow-md"
          :class="
            current() === id
              ? 'border-brand-500 ring-2 ring-brand-500'
              : 'border-slate-200 dark:border-slate-700'
          "
          :style="{ background: PREVIEW[id].bg }"
          @click="choose(id)"
        >
          <span class="mb-2 flex items-center gap-2">
            <span class="size-3 rounded-full" :style="{ background: PREVIEW[id].accent }" />
            <span class="text-xs font-semibold" :style="{ color: PREVIEW[id].text }">{{
              t(`theme.${id}`)
            }}</span>
            <span
              v-if="current() === id"
              class="ml-auto text-xs"
              :style="{ color: PREVIEW[id].accent }"
              >✔</span
            >
          </span>
          <span class="block space-y-1.5 rounded-lg p-2" :style="{ background: PREVIEW[id].card }">
            <span
              class="block h-1.5 w-3/4 rounded"
              :style="{ background: PREVIEW[id].text, opacity: 0.25 }"
            />
            <span class="block h-3 w-1/2 rounded" :style="{ background: PREVIEW[id].accent }" />
          </span>
        </button>
      </div>
    </div>

    <div>
      <h2>{{ t('prefs.autoLock') }}</h2>
      <p class="mb-4 mt-1 text-sm text-slate-500">{{ t('prefs.autoLockHint') }}</p>
      <div class="flex flex-wrap gap-2" role="radiogroup" :aria-label="t('prefs.autoLock')">
        <button
          v-for="m in AUTO_LOCK_OPTIONS"
          :key="m"
          type="button"
          role="radio"
          :aria-checked="lockMinutes === m"
          :data-testid="`autolock-${m}`"
          :class="lockMinutes === m ? 'btn-primary' : 'btn'"
          @click="chooseLock(m)"
        >
          {{ t(`prefs.autoLockOptions.m${m}`) }}
        </button>
      </div>
    </div>

    <PersonalVaultErase v-if="ws.personalDataRestricted" />

    <PinSettings />

    <div>
      <h2>{{ t('prefs.language') }}</h2>
      <div class="mt-3 flex gap-2">
        <button
          v-for="l in ['ru', 'en'] as const"
          :key="l"
          type="button"
          :class="locale === l ? 'btn-primary' : 'btn'"
          :aria-pressed="locale === l"
          @click="setLocale(l)"
        >
          {{ l === 'ru' ? 'Русский' : 'English' }}
        </button>
      </div>
    </div>

    <div>
      <h2>{{ t('prefs.homeTitle') }}</h2>
      <p class="mt-1 text-sm text-slate-500">{{ t('prefs.homeHint') }}</p>
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <select
          :value="homeSpace"
          class="input w-auto max-w-full"
          data-testid="home-space"
          @change="chooseHome(($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ t('prefs.homeDefault') }}</option>
          <option v-for="s in ws.spaces" :key="s.id" :value="s.id">{{ spaceLabel(s, t) }}</option>
          <option v-if="ws.personalAllowed" value="personal">{{ t('prefs.homePersonal') }}</option>
        </select>
        <span
          v-if="homeNotice"
          class="text-sm text-emerald-700 dark:text-emerald-400"
          role="status"
          >{{ homeNotice }}</span
        >
      </div>
    </div>

    <NotificationPreferences />
    <div>
      <h2>{{ t('prefs.account') }}</h2>
      <RouterLink to="/security" class="btn mt-3">{{ t('prefs.security') }}</RouterLink>
    </div>
  </section>
</template>
