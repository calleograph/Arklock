<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from './stores/auth';

const { t, locale } = useI18n();
const dark = ref(false);
const auth = useAuthStore();
const router = useRouter();

async function signOut(): Promise<void> {
  await auth.signOut();
  await router.replace('/login');
}

function lockNow(): void {
  auth.lock();
}

function applyTheme(): void {
  document.documentElement.classList.toggle('dark', dark.value);
  try {
    localStorage.setItem('arklock.theme', dark.value ? 'dark' : 'light');
  } catch {
    /* не критично */
  }
}

function toggleTheme(): void {
  dark.value = !dark.value;
  applyTheme();
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

onMounted(() => {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('arklock.theme');
  } catch {
    /* ignore */
  }
  dark.value = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme();
  document.documentElement.lang = locale.value;
});
</script>

<template>
  <div class="min-h-screen">
    <header class="border-b border-slate-200 dark:border-slate-800">
      <div
        class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
      >
        <div>
          <div class="text-lg font-semibold tracking-tight">{{ t('app.name') }}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400">{{ t('app.tagline') }}</div>
        </div>
        <nav
          v-if="auth.isSignedIn && auth.unlocked"
          class="order-3 flex w-full flex-wrap items-center gap-1 text-sm sm:order-none sm:w-auto"
        >
          <RouterLink
            to="/"
            class="rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
            active-class="font-semibold"
            exact-active-class="font-semibold"
            >{{ t('nav.vault') }}</RouterLink
          >
          <RouterLink
            to="/security"
            class="rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
            exact-active-class="font-semibold"
            >{{ t('nav.security') }}</RouterLink
          >
          <RouterLink
            to="/status"
            class="rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
            exact-active-class="font-semibold"
            >{{ t('nav.status') }}</RouterLink
          >
          <RouterLink
            v-if="auth.user?.role === 'admin'"
            to="/admin"
            data-testid="nav-admin"
            class="rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
            >{{ t('nav.admin') }}</RouterLink
          >
          <RouterLink
            v-if="auth.user?.role === 'admin'"
            to="/admin/updates"
            data-testid="nav-updates"
            class="rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
            exact-active-class="font-semibold"
            >{{ t('nav.updates') }}</RouterLink
          >
          <button
            type="button"
            class="rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
            data-testid="lock"
            @click="lockNow"
          >
            {{ t('nav.lock') }}
          </button>
          <button
            type="button"
            class="rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
            data-testid="signout"
            @click="signOut"
          >
            {{ t('nav.signOut') }}
          </button>
        </nav>
        <div class="flex items-center gap-2 text-sm">
          <button
            type="button"
            class="rounded-md border border-slate-300 px-2.5 py-1 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand-500 dark:border-slate-700 dark:hover:bg-slate-800"
            :aria-label="t('ui.theme')"
            @click="toggleTheme"
          >
            {{ dark ? '☾' : '☀' }}
          </button>
          <button
            v-for="l in ['ru', 'en'] as const"
            :key="l"
            type="button"
            class="rounded-md border px-2.5 py-1 uppercase focus-visible:outline-2 focus-visible:outline-brand-500"
            :class="
              locale === l
                ? 'border-brand-500 bg-brand-500 text-white'
                : 'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800'
            "
            :aria-pressed="locale === l"
            @click="setLocale(l)"
          >
            {{ l }}
          </button>
        </div>
      </div>
    </header>
    <main class="mx-auto max-w-5xl px-4 py-8">
      <RouterView />
    </main>
  </div>
</template>
