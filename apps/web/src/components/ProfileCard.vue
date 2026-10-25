<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../services/api';
import { day, errorMessage } from '../services/helpers';

/** «Мой профиль»: сведения о себе только для чтения; поля из каталога меняются в каталоге, остальные — администратором. */
const { t } = useI18n();
interface Profile {
  name: string;
  email: string;
  role: 'chief' | 'admin' | 'member';
  source: 'local' | 'ldap' | 'oidc' | 'saml';
  title: string | null;
  department: string | null;
  phone: string | null;
  fromDirectory: string[];
  createdAt: string;
}
const p = ref<Profile | null>(null);
const error = ref('');
onMounted(async () => {
  try {
    p.value = await api<Profile>('GET', '/auth/profile');
  } catch (e) {
    error.value = errorMessage(e, t);
  }
});
const rows = (x: Profile) =>
  [
    ['name', x.name],
    ['title', x.title],
    ['department', x.department],
    ['phone', x.phone],
    ['email', x.email],
    ['source', t(`profileCard.source.${x.source}`)],
    ['role', t(`profileCard.role.${x.role}`)],
    ['since', day(x.createdAt)],
  ] as const;
</script>

<template>
  <section class="card max-w-xl space-y-3 p-4 text-sm" data-testid="profile-card">
    <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    <dl v-if="p" class="divide-y divide-slate-200 dark:divide-slate-800">
      <div v-for="[k, v] in rows(p)" :key="k" class="flex justify-between gap-4 py-1.5">
        <dt class="text-slate-500">
          {{ t(`profileCard.f.${k}`) }}
          <span v-if="p.fromDirectory.includes(k)" class="badge ml-1">{{
            t('profileCard.directory')
          }}</span>
        </dt>
        <dd class="text-right font-medium" :data-testid="`profile-${k}`">{{ v || '—' }}</dd>
      </div>
    </dl>
    <p class="text-xs text-slate-500">{{ t('profileCard.note') }}</p>
    <RouterLink to="/settings" class="btn">{{ t('profileCard.settings') }}</RouterLink>
  </section>
</template>
