import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { i18n } from './i18n';
import { router } from './router';
import { useAuthStore } from './stores/auth';
import '@fontsource-variable/onest';
import '@fontsource-variable/jetbrains-mono';
import './style.css';

async function bootstrap(): Promise<void> {
  const app = createApp(App).use(createPinia()).use(i18n);
  const auth = useAuthStore();
  await auth.restore();
  app.use(router);

  // Любая работа с экраном продлевает разблокированное состояние: чтение (прокрутка, движение мыши), ввод, касания.
  for (const ev of [
    'pointerdown',
    'pointermove',
    'keydown',
    'wheel',
    'touchstart',
    'touchmove',
    'focusin',
  ] as const) {
    window.addEventListener(ev, () => auth.touch(), { passive: true });
  }
  window.addEventListener('scroll', () => auth.touch(), { passive: true, capture: true });
  // Возврат на вкладку (в том числе после сна компьютера): срок бездействия проверяется сразу, без продления.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') auth.checkIdle();
  });

  // Автоблокировка переводит на экран разблокировки.
  auth.$subscribe(() => {
    const route = router.currentRoute.value;
    if (route.meta.requiresUnlock && auth.isSignedIn && !auth.unlocked)
      void router.replace('/unlock');
    if (route.meta.requiresUnlock && !auth.isSignedIn) void router.replace('/login');
  });

  app.mount('#app');

  // Оболочка интерфейса кэшируется service worker'ом (данные и ответы API — никогда)
  // Событие load могло пройти, пока восстанавливалась сессия: тогда регистрируем сразу.
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    const register = () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}

void bootstrap();
