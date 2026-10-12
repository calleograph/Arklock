<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from './stores/auth';
import { applyTheme, DEFAULT_THEME, isTheme, PREVIEW, storedTheme, THEMES } from './services/theme';

const { t, locale } = useI18n();
const auth = useAuthStore();
const router = useRouter();

async function signOut(): Promise<void> {
  await auth.signOut();
  await router.replace('/login');
}

function lockNow(): void {
  auth.lock();
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

// Тема из профиля применяется после входа, на любом устройстве
watch(
  () => auth.user?.theme,
  (id) => {
    if (isTheme(id)) applyTheme(id);
  },
  { immediate: true },
);

onMounted(() => {
  applyTheme(storedTheme() ?? DEFAULT_THEME, false);
  document.documentElement.lang = locale.value;
});

const initial = () =>
  (auth.user?.displayName || auth.user?.email || '?').trim().charAt(0).toUpperCase();
</script>

<template>
  <div class="min-h-screen">
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:shadow-lg"
      >{{ t('ui.skip') }}</a
    >
    <header
      class="sticky top-0 z-30 border-b border-slate-200 backdrop-blur dark:border-slate-800"
      style="background: var(--header-bg)"
    >
      <div
        class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6"
      >
        <RouterLink to="/" class="flex items-center gap-2.5" aria-label="Arklock">
          <span
            class="flex size-8 items-center justify-center rounded-lg bg-brand-500 shadow-xs"
            style="color: var(--on-brand)"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 24 24"
              class="size-4.5"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
          </span>
          <span class="leading-tight">
            <span class="block text-base font-semibold tracking-tight">{{ t('app.name') }}</span>
            <span class="hidden text-[11px] text-slate-500 sm:block">{{ t('app.tagline') }}</span>
          </span>
        </RouterLink>

        <nav
          v-if="auth.isSignedIn && auth.unlocked"
          class="order-3 -mx-1 flex w-full items-center gap-0.5 overflow-x-auto px-1 sm:order-none sm:mx-0 sm:w-auto sm:flex-1 sm:overflow-visible"
          :aria-label="t('ui.mainNav')"
        >
          <RouterLink
            to="/"
            class="nav-link whitespace-nowrap"
            active-class="nav-link-active"
            exact-active-class="nav-link-active"
            >{{ t('nav.vault') }}</RouterLink
          >
          <RouterLink
            to="/security"
            class="nav-link whitespace-nowrap"
            exact-active-class="nav-link-active"
            >{{ t('nav.security') }}</RouterLink
          >
          <RouterLink
            to="/settings"
            class="nav-link whitespace-nowrap"
            exact-active-class="nav-link-active"
            data-testid="nav-settings"
            >{{ t('nav.settings') }}</RouterLink
          >
          <RouterLink
            to="/status"
            class="nav-link whitespace-nowrap"
            exact-active-class="nav-link-active"
            >{{ t('nav.status') }}</RouterLink
          >
          <RouterLink
            v-if="auth.user?.role === 'admin' || auth.user?.delegated"
            to="/admin"
            data-testid="nav-admin"
            class="nav-link whitespace-nowrap"
            :class="
              $route.path.startsWith('/admin') && $route.path !== '/admin/updates'
                ? 'nav-link-active'
                : ''
            "
            >{{ t('nav.admin') }}</RouterLink
          >
          <RouterLink
            v-if="auth.user?.role === 'admin'"
            to="/admin/updates"
            data-testid="nav-updates"
            class="nav-link whitespace-nowrap"
            exact-active-class="nav-link-active"
            >{{ t('nav.updates') }}</RouterLink
          >
        </nav>
        <div v-else class="flex-1" />

        <div class="ml-auto flex items-center gap-1.5 text-sm">
          <!-- до входа тему можно выбрать здесь, после входа — в «Настройках» -->
          <div
            v-if="!auth.isSignedIn"
            class="mr-1 flex items-center gap-1"
            role="group"
            :aria-label="t('ui.theme')"
          >
            <button
              v-for="id in THEMES"
              :key="id"
              type="button"
              class="size-4 rounded-full ring-1 ring-slate-300 transition-transform hover:scale-125 dark:ring-slate-600"
              :style="{ background: PREVIEW[id].accent }"
              :title="t(`theme.${id}`)"
              :aria-label="t(`theme.${id}`)"
              @click="applyTheme(id)"
            />
          </div>
          <div
            class="flex overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700"
            role="group"
            :aria-label="t('ui.language')"
          >
            <button
              v-for="l in ['ru', 'en'] as const"
              :key="l"
              type="button"
              class="px-2 py-1 text-xs font-semibold uppercase transition-colors"
              :class="
                locale === l
                  ? 'bg-brand-500'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              "
              :style="locale === l ? 'color: var(--on-brand)' : ''"
              :aria-pressed="locale === l"
              @click="setLocale(l)"
            >
              {{ l }}
            </button>
          </div>
          <template v-if="auth.isSignedIn && auth.unlocked">
            <button
              type="button"
              class="btn-ghost"
              data-testid="lock"
              :title="t('nav.lock')"
              @click="lockNow"
            >
              <svg
                viewBox="0 0 24 24"
                class="size-4"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <rect x="5" y="11" width="14" height="9" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
              <span class="hidden md:inline">{{ t('nav.lock') }}</span>
            </button>
            <button
              type="button"
              class="btn-ghost"
              data-testid="signout"
              :title="t('nav.signOut')"
              @click="signOut"
            >
              <span
                class="flex size-6 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold"
                style="color: var(--on-brand)"
                aria-hidden="true"
                >{{ initial() }}</span
              >
              <span class="hidden md:inline">{{ t('nav.signOut') }}</span>
            </button>
          </template>
        </div>
      </div>
    </header>
    <main id="main" class="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <RouterView />
    </main>
  </div>
</template>
