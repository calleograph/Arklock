import { createRouter, createWebHistory } from 'vue-router';
import AuthView from './views/AuthView.vue';
import SecurityView from './views/SecurityView.vue';
import StatusView from './views/StatusView.vue';
import UpdatesView from './views/UpdatesView.vue';
import VaultView from './views/VaultView.vue';
import { useAuthStore } from './stores/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'vault', component: VaultView, meta: { requiresUnlock: true } },
    {
      path: '/security',
      name: 'security',
      component: SecurityView,
      meta: { requiresUnlock: true },
    },
    { path: '/status', name: 'status', component: StatusView },
    {
      path: '/admin/updates',
      name: 'updates',
      component: UpdatesView,
      meta: { requiresUnlock: true, requiresAdmin: true },
    },
    { path: '/login', name: 'login', component: AuthView, meta: { guestOnly: true } },
    { path: '/unlock', name: 'unlock', component: AuthView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.requiresUnlock) {
    if (!auth.isSignedIn) return { name: 'login' };
    if (!auth.unlocked) return { name: 'unlock' };
  }
  if (to.meta.requiresAdmin && auth.user?.role !== 'admin') return { name: 'vault' };
  if (to.name === 'unlock' && (!auth.isSignedIn || auth.unlocked)) {
    return auth.isSignedIn ? { name: 'vault' } : { name: 'login' };
  }
  if (to.meta.guestOnly && auth.isSignedIn) {
    return auth.unlocked ? { name: 'vault' } : { name: 'unlock' };
  }
  return true;
});
