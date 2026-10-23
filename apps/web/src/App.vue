<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from './stores/auth';
import { useWorkspaceStore } from './stores/workspace';
import { applyTheme, DEFAULT_THEME, isTheme, PREVIEW, storedTheme, THEMES } from './services/theme';
import Icon from './components/Icon.vue';
import GlobalSearchResults from './components/GlobalSearchResults.vue';
import NotificationBell from './components/NotificationBell.vue';

const { t, locale } = useI18n();
const auth = useAuthStore();
const ws = useWorkspaceStore();
const router = useRouter();
const route = useRoute();

/** Бургер-меню: закрывается по клику вне его, по Escape, после выбора пункта и при смене раздела. */
const menuOpen = ref(false);
const menuRoot = ref<HTMLElement | null>(null);
/** Узкий экран: короткие подписи там, где длинная обрезалась бы на середине слова. */
const narrowQuery = window.matchMedia('(max-width: 639px)');
const narrow = ref(narrowQuery.matches);
narrowQuery.addEventListener('change', (e) => (narrow.value = e.matches));
const isAdmin = computed(() => auth.user?.role === 'admin' || !!auth.user?.delegated);

function closeMenu(): void {
  menuOpen.value = false;
}
function onDocumentClick(e: MouseEvent): void {
  if (menuOpen.value && menuRoot.value && !menuRoot.value.contains(e.target as Node)) closeMenu();
}
function onDocumentKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeMenu();
}
watch(
  () => route.fullPath,
  () => closeMenu(),
);
onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onDocumentKey);
});

async function signOut(): Promise<void> {
  closeMenu();
  await auth.signOut();
  await router.replace('/login');
}

function lockNow(): void {
  auth.lock(true);
}

/** Поиск в шапке ищет по паролям: если открыт другой раздел, переходим к списку паролей. */
function onSearch(): void {
  if (route.name !== 'vault') void router.push({ name: 'vault' });
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
      <div class="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5 sm:px-6">
        <RouterLink to="/" class="flex shrink-0 items-center gap-2.5" aria-label="Arklock">
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
          <span class="hidden leading-tight md:block">
            <span class="block text-base font-semibold tracking-tight">{{ t('app.name') }}</span>
            <span class="block text-[11px] text-slate-500">{{ t('app.tagline') }}</span>
          </span>
        </RouterLink>

        <!-- Поиск по паролям: единственное, что нужно в шапке каждый раз -->
        <label
          v-if="auth.isSignedIn && auth.unlocked"
          class="relative mx-auto flex min-w-0 flex-1 items-center md:max-w-xl"
        >
          <span class="sr-only">{{ t('vault.search') }}</span>
          <Icon name="search" class="pointer-events-none absolute left-3 size-4 text-slate-400" />
          <input
            v-model="ws.searchQuery"
            type="search"
            :placeholder="narrow ? t('ws.searchShort') : t('vault.search')"
            :aria-label="t('vault.search')"
            class="input w-full !pl-9"
            data-testid="search"
            @input="onSearch"
            @keydown.esc.prevent="ws.searchQuery = ''"
          />
          <GlobalSearchResults />
        </label>
        <div v-else class="flex-1" />

        <div class="flex shrink-0 items-center gap-1.5 text-sm">
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
            :class="auth.isSignedIn && auth.unlocked ? 'max-sm:hidden' : ''"
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
            <NotificationBell />
            <button
              type="button"
              class="btn-ghost"
              data-testid="lock"
              :title="t('nav.lock')"
              :aria-label="t('nav.lock')"
              @click="lockNow"
            >
              <Icon name="lock" class="size-4" />
            </button>

            <div ref="menuRoot" class="relative">
              <button
                type="button"
                class="burger-btn"
                data-testid="menu-toggle"
                aria-controls="app-menu"
                :aria-expanded="menuOpen"
                :aria-label="menuOpen ? t('menu.close') : t('menu.open')"
                :class="{ 'burger-open': menuOpen }"
                @click="menuOpen = !menuOpen"
              >
                <span class="burger-bar" />
                <span class="burger-bar" />
                <span class="burger-bar" />
              </button>

              <Transition name="drop">
                <div
                  v-if="menuOpen"
                  id="app-menu"
                  class="absolute right-0 top-full z-40 mt-2 w-72 overflow-hidden rounded-2xl border border-slate-200 bg-white text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900"
                  data-testid="menu-panel"
                >
                  <div
                    class="flex items-center gap-3 border-b border-slate-200 p-4 dark:border-slate-700"
                  >
                    <span
                      class="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-500 font-semibold"
                      style="color: var(--on-brand)"
                      aria-hidden="true"
                      >{{ initial() }}</span
                    >
                    <span class="min-w-0">
                      <span class="block truncate font-semibold">{{
                        auth.user?.displayName || auth.user?.email
                      }}</span>
                      <span class="block truncate text-xs text-slate-500">{{
                        auth.user?.email
                      }}</span>
                    </span>
                  </div>

                  <nav class="p-2" :aria-label="t('ui.mainNav')">
                    <RouterLink
                      v-for="(item, i) in [
                        { to: '/', icon: 'inbox', label: t('nav.vault'), id: 'menu-vault' },
                        {
                          to: '/security',
                          icon: 'shield',
                          label: t('nav.security'),
                          id: 'menu-security',
                        },
                        {
                          to: '/settings',
                          icon: 'settings',
                          label: t('nav.settings'),
                          id: 'menu-settings',
                        },
                        { to: '/help', icon: 'help', label: t('help.title'), id: 'menu-help' },
                      ]"
                      :key="item.to"
                      :to="item.to"
                      class="menu-item"
                      :style="{ '--i': i }"
                      :data-testid="item.id"
                      @click="closeMenu"
                    >
                      <Icon :name="item.icon as 'inbox'" class="size-4 opacity-80" />
                      {{ item.label }}
                    </RouterLink>
                  </nav>

                  <!-- на телефоне язык переключается здесь: в шапке ему не хватает места -->
                  <div
                    class="flex items-center justify-between gap-2 border-t border-slate-200 px-4 py-2.5 sm:hidden dark:border-slate-700"
                    role="group"
                    :aria-label="t('ui.language')"
                  >
                    <span class="text-slate-500">{{ t('ui.language') }}</span>
                    <span class="flex rounded-lg bg-slate-100 p-0.5 text-xs dark:bg-slate-800">
                      <button
                        v-for="l in ['ru', 'en'] as const"
                        :key="l"
                        type="button"
                        class="seg uppercase"
                        :class="{ 'seg-on': locale === l }"
                        :aria-pressed="locale === l"
                        @click="setLocale(l)"
                      >
                        {{ l }}
                      </button>
                    </span>
                  </div>
                  <div class="space-y-1 border-t border-slate-200 p-2 dark:border-slate-700">
                    <RouterLink
                      v-if="isAdmin"
                      to="/admin"
                      class="menu-item justify-between font-semibold text-brand-600 dark:text-brand-400"
                      data-testid="menu-full"
                      @click="closeMenu"
                    >
                      <span class="flex items-center gap-3">
                        <Icon name="users" class="size-4" />
                        {{ t('menu.full') }}
                      </span>
                      <span aria-hidden="true">→</span>
                    </RouterLink>
                    <button
                      type="button"
                      class="menu-item w-full text-left"
                      data-testid="signout"
                      @click="signOut"
                    >
                      <Icon name="logout" class="size-4 opacity-80" />
                      {{ t('nav.signOut') }}
                    </button>
                  </div>
                </div>
              </Transition>
            </div>
          </template>
        </div>
      </div>
    </header>
    <main id="main" class="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <RouterView />
    </main>
  </div>
</template>
