import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { i18n } from './i18n';
import { router } from './router';
import { useAuthStore } from './stores/auth';
import './style.css';

async function bootstrap(): Promise<void> {
  const app = createApp(App).use(createPinia()).use(i18n);
  const auth = useAuthStore();
  await auth.restore();
  app.use(router);

  // Любая активность продлевает время до автоблокировки.
  for (const ev of ['pointerdown', 'keydown', 'visibilitychange'] as const) {
    window.addEventListener(ev, () => auth.touch(), { passive: true });
  }

  // Автоблокировка переводит на экран разблокировки.
  auth.$subscribe(() => {
    const route = router.currentRoute.value;
    if (route.meta.requiresUnlock && auth.isSignedIn && !auth.unlocked)
      void router.replace('/unlock');
    if (route.meta.requiresUnlock && !auth.isSignedIn) void router.replace('/login');
  });

  app.mount('#app');

  // Оболочка интерфейса кэшируется service worker'ом (данные и ответы API — никогда)
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    });
  }
}

void bootstrap();
