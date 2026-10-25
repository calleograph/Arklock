<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';

const { t, te } = useI18n();
const auth = useAuthStore();
const isAdmin = computed(() => auth.user?.role === 'admin' || !!auth.user?.delegated);

/** Страницы документации в репозитории проекта: ссылки ведут только на существующие файлы docs/. */
const DOCS_BASE = 'https://github.com/calleograph/Arklock/blob/main/docs/';
const USER_TOPICS = [
  'firstLogin',
  'twoFactor',
  'vaults',
  'access',
  'share',
  'links',
  'devices',
  'lost',
  'history',
  'files',
  'shortcuts',
  'extension',
  'transfer',
] as const;
const ADMIN_TOPICS = [
  'firstSetup',
  'directory',
  'people',
  'departments',
  'chief',
  'recovery',
  'operations',
  'integrations',
  'certificates',
] as const;
const FAQ = ['find', 'create', 'copy', 'totp', 'share', 'locked', 'pending', 'forgot'] as const;
const TERMS = [
  'vault',
  'personalVault',
  'space',
  'folder',
  'entry',
  'group',
  'role',
  'level',
  'key',
  'recovery',
  'corpRecovery',
  'custodian',
  'lock',
  'mfa',
  'totp',
  'ldaps',
  'sso',
  'webhook',
  'syslog',
] as const;
const DOCS = [
  'install',
  'update',
  'backup',
  'directory',
  'saml',
  'corporate',
  'revocation',
  'extension',
  'cli',
  'troubleshooting',
] as const;

const query = ref('');
interface Topic {
  id: string;
  scope: 'user' | 'admin';
  title: string;
  lead: string;
  steps: string[];
  note: string;
}
function topic(scope: 'user' | 'admin', id: string): Topic {
  const base = `guides.${scope}.${id}`;
  const steps: string[] = [];
  for (let i = 1; te(`${base}.s${i}`); i++) steps.push(t(`${base}.s${i}`));
  return {
    id: `${scope}-${id}`,
    scope,
    title: t(`${base}.title`),
    lead: t(`${base}.lead`),
    steps,
    note: te(`${base}.note`) ? t(`${base}.note`) : '',
  };
}
const topics = computed<Topic[]>(() => [
  ...USER_TOPICS.map((id) => topic('user', id)),
  ...(isAdmin.value ? ADMIN_TOPICS.map((id) => topic('admin', id)) : []),
]);
// поиск по заголовку, вступлению, шагам и примечанию
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return topics.value;
  return topics.value.filter((x) =>
    [x.title, x.lead, x.note, ...x.steps].join(' ').toLowerCase().includes(q),
  );
});
const userShown = computed(() => shown.value.filter((x) => x.scope === 'user'));
const adminShown = computed(() => shown.value.filter((x) => x.scope === 'admin'));
const showRest = computed(() => !query.value.trim());
</script>

<template>
  <section
    class="mx-auto grid max-w-5xl gap-6 md:grid-cols-[14rem_minmax(0,1fr)]"
    data-testid="help"
  >
    <nav
      class="md:sticky md:top-16 md:max-h-[calc(100dvh-6rem)] md:self-start md:overflow-y-auto"
      :aria-label="t('help.title')"
      data-testid="help-toc"
    >
      <input
        v-model="query"
        type="search"
        class="input mb-2"
        :placeholder="t('guides.search')"
        :aria-label="t('guides.search')"
        data-testid="help-search"
      />
      <template
        v-for="g in [
          { id: 'user', list: userShown },
          { id: 'admin', list: adminShown },
        ]"
        :key="g.id"
      >
        <div v-if="g.list.length">
          <div
            class="px-2 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500"
          >
            {{ t(`guides.sections.${g.id}`) }}
          </div>
          <a
            v-for="x in g.list"
            :key="x.id"
            :href="`#${x.id}`"
            class="nav-link block w-full whitespace-normal"
            :data-testid="`help-toc-${x.id}`"
          >
            {{ x.title }}
          </a>
        </div>
      </template>
      <template v-if="showRest">
        <a href="#faq" class="nav-link mt-2 block">{{ t('guides.sections.faq') }}</a>
        <a href="#terms" class="nav-link block">{{ t('guides.sections.terms') }}</a>
        <a href="#docs" class="nav-link block">{{ t('guides.sections.docs') }}</a>
      </template>
    </nav>

    <div class="min-w-0 space-y-8">
      <header>
        <h1>{{ t('help.title') }}</h1>
        <p class="mt-1 text-sm text-slate-500">{{ t('help.intro') }}</p>
      </header>

      <p v-if="!shown.length" class="notice notice-warn" role="status">{{ t('guides.nothing') }}</p>

      <article
        v-for="x in shown"
        :id="x.id"
        :key="x.id"
        class="card scroll-mt-20 space-y-2 p-4"
        :data-testid="`help-topic-${x.id}`"
      >
        <h2 class="text-base font-semibold">{{ x.title }}</h2>
        <p class="max-w-prose text-sm text-slate-600 dark:text-slate-300">{{ x.lead }}</p>
        <ol class="list-decimal space-y-1 pl-5 text-sm">
          <li v-for="(s, i) in x.steps" :key="i">{{ s }}</li>
        </ol>
        <p
          v-if="x.note"
          class="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300"
        >
          {{ x.note }}
        </p>
      </article>

      <template v-if="showRest">
        <div id="faq" class="scroll-mt-20">
          <h2 class="mb-2">{{ t('guides.sections.faq') }}</h2>
          <div class="card divide-y divide-slate-200 dark:divide-slate-800">
            <details
              v-for="id in FAQ"
              :key="id"
              class="group px-4 py-3"
              :data-testid="`help-${id}`"
            >
              <summary class="cursor-pointer list-none font-medium">
                {{ t(`help.start.${id}.q`) }}
              </summary>
              <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
                {{ t(`help.start.${id}.a`) }}
              </p>
            </details>
          </div>
        </div>

        <div id="terms" class="scroll-mt-20">
          <h2 class="mb-2">{{ t('guides.sections.terms') }}</h2>
          <dl class="card divide-y divide-slate-200 text-sm dark:divide-slate-800">
            <div v-for="id in TERMS" :key="id" class="px-4 py-3">
              <dt class="font-medium">{{ t(`help.terms.${id}.name`) }}</dt>
              <dd class="mt-1 text-slate-600 dark:text-slate-300">
                {{ t(`help.terms.${id}.text`) }}
              </dd>
            </div>
          </dl>
        </div>

        <div id="docs" class="scroll-mt-20">
          <h2 class="mb-2">{{ t('guides.sections.docs') }}</h2>
          <ul class="card divide-y divide-slate-200 text-sm dark:divide-slate-800">
            <li v-for="id in DOCS" :key="id">
              <a
                :href="DOCS_BASE + t(`help.docs.${id}.file`)"
                target="_blank"
                rel="noopener noreferrer"
                class="block px-4 py-2.5 text-brand-600 hover:bg-slate-50 dark:text-brand-400 dark:hover:bg-slate-800/50"
                :data-testid="`help-doc-${id}`"
              >
                {{ t(`help.docs.${id}.label`) }} ↗
              </a>
            </li>
          </ul>
        </div>
      </template>
    </div>
  </section>
</template>
