<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';

const { t } = useI18n();
const auth = useAuthStore();
const isAdmin = computed(() => auth.user?.role === 'admin' || !!auth.user?.delegated);

/** Страницы документации в репозитории проекта: ссылки ведут только на существующие файлы docs/. */
const DOCS_BASE = 'https://github.com/calleograph/Arklock/blob/main/docs/';
const START = ['find', 'create', 'copy', 'totp', 'share', 'locked', 'pending', 'forgot'] as const;
const ADMIN = ['newUser', 'access', 'personal', 'ldap', 'backup', 'update'] as const;
const TERMS = [
  'vault',
  'personalVault',
  'space',
  'folder',
  'entry',
  'group',
  'key',
  'recovery',
  'corpRecovery',
  'custodian',
  'lock',
  'mfa',
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
</script>

<template>
  <section class="mx-auto max-w-3xl space-y-8" data-testid="help">
    <header>
      <h1>{{ t('help.title') }}</h1>
      <p class="mt-1 text-sm text-slate-500">{{ t('help.intro') }}</p>
    </header>

    <div>
      <h2 class="mb-2">{{ t('help.sections.start') }}</h2>
      <div class="card divide-y divide-slate-200 dark:divide-slate-800">
        <details v-for="id in START" :key="id" class="group px-4 py-3" :data-testid="`help-${id}`">
          <summary class="cursor-pointer list-none font-medium">
            {{ t(`help.start.${id}.q`) }}
          </summary>
          <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {{ t(`help.start.${id}.a`) }}
          </p>
        </details>
      </div>
    </div>

    <div v-if="isAdmin">
      <h2 class="mb-2">{{ t('help.sections.admin') }}</h2>
      <div class="card divide-y divide-slate-200 dark:divide-slate-800">
        <details v-for="id in ADMIN" :key="id" class="group px-4 py-3" :data-testid="`help-${id}`">
          <summary class="cursor-pointer list-none font-medium">
            {{ t(`help.admin.${id}.q`) }}
          </summary>
          <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {{ t(`help.admin.${id}.a`) }}
          </p>
        </details>
      </div>
    </div>

    <div>
      <h2 class="mb-2">{{ t('help.sections.terms') }}</h2>
      <dl class="card divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <div v-for="id in TERMS" :key="id" class="px-4 py-3">
          <dt class="font-medium">{{ t(`help.terms.${id}.name`) }}</dt>
          <dd class="mt-1 text-slate-600 dark:text-slate-300">{{ t(`help.terms.${id}.text`) }}</dd>
        </div>
      </dl>
    </div>

    <div>
      <h2 class="mb-2">{{ t('help.sections.docs') }}</h2>
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
  </section>
</template>
