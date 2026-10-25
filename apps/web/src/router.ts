import { createRouter, createWebHistory } from 'vue-router';
import AuthView from './views/AuthView.vue';
import SecurityView from './views/SecurityView.vue';
import StatusView from './views/StatusView.vue';
import AdminView from './views/AdminView.vue';
import HandoffOpenView from './views/HandoffOpenView.vue';
import SsoDoneView from './views/SsoDoneView.vue';
import InspectorView from './views/InspectorView.vue';
import VaultSettingsView from './views/VaultSettingsView.vue';
import WorkspaceView from './views/WorkspaceView.vue';
import { useAuthStore } from './stores/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'vault', component: WorkspaceView, meta: { requiresUnlock: true } },
    {
      path: '/notifications',
      name: 'notifications',
      component: () => import('./views/NotificationsView.vue'),
      meta: { requiresUnlock: true },
    },
    {
      path: '/vault/:id/settings',
      name: 'vault-settings',
      component: VaultSettingsView,
      meta: { requiresUnlock: true },
    },
    // импорт и экспорт живут в администрировании (только главный администратор); старые ссылки ведут туда
    {
      path: '/transfer',
      name: 'transfer',
      redirect: (to) => ({ path: '/admin/transfer', query: to.query }),
    },
    {
      path: '/e/:code([0-9a-f]{12})',
      name: 'entry-link',
      component: () => import('./views/EntryLinkView.vue'),
      meta: { requiresUnlock: true },
    },
    {
      path: '/inspector',
      name: 'inspector',
      component: InspectorView,
      meta: { requiresUnlock: true },
    },
    { path: '/h/:id', name: 'handoff', component: HandoffOpenView },
    { path: '/sso/done', name: 'sso-done', component: SsoDoneView },
    {
      path: '/admin/:tab(users|circles|settings|ledger|overview|resources|containers|backups|logs|storage|diagnostics|certificates|smtp|ldap|sso|saml|syslog|webhooks|invitations|roles|updates|organization|automation|departments|vaults|wizards|transfer)?',
      name: 'admin',
      component: AdminView,
      meta: { requiresUnlock: true, requiresAdmin: true },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
      meta: { requiresUnlock: true },
    },
    {
      path: '/security',
      name: 'security',
      component: SecurityView,
      meta: { requiresUnlock: true },
    },
    { path: '/status', name: 'status', component: StatusView },
    { path: '/help', name: 'help', component: () => import('./views/HelpView.vue') },
    { path: '/login', name: 'login', component: AuthView, meta: { guestOnly: true } },
    { path: '/unlock', name: 'unlock', component: AuthView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

/** Ссылка на запись, открытая до входа: после входа человек попадает на неё, а не на общий список. */
const RETURN_KEY = 'arklock.return';
const rememberReturn = (path: string) => {
  try {
    if (path.startsWith('/e/')) sessionStorage.setItem(RETURN_KEY, path);
  } catch {
    /* без хранилища возврата к ссылке нет: человек откроет её ещё раз */
  }
};
const takeReturn = (): string | null => {
  try {
    const v = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return v && v.startsWith('/e/') ? v : null;
  } catch {
    return null;
  }
};

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.requiresUnlock) {
    if (!auth.isSignedIn) {
      rememberReturn(to.fullPath);
      return { name: 'login' };
    }
    if (!auth.unlocked) {
      rememberReturn(to.fullPath);
      return { name: 'unlock' };
    }
  }
  if (to.name === 'vault' && auth.unlocked) {
    const back = takeReturn();
    if (back) return back;
  }
  if (to.meta.requiresAdmin && auth.user?.role !== 'admin' && !auth.user?.delegated)
    return { name: 'vault' };
  if (to.name === 'unlock' && (!auth.isSignedIn || auth.unlocked)) {
    return auth.isSignedIn ? { name: 'vault' } : { name: 'login' };
  }
  if (to.meta.guestOnly && auth.isSignedIn) {
    return auth.unlocked ? { name: 'vault' } : { name: 'unlock' };
  }
  return true;
});
