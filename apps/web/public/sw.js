/*
 * Service worker Arklock. Кэширует ТОЛЬКО статические файлы интерфейса (оболочку), чтобы приложение быстро открывалось и
 * ставилось на главный экран. Запросы к API (/api/), страницы получения секрета (/h/) и любые не-GET запросы не кэшируются
 * никогда: ни шифртекст, ни ответы сервера в кэш не попадают. Обновление версии интерфейса подхватывается при следующей загрузке.
 */
const CACHE = 'arklock-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/h/')) return;

  // Хешированные файлы сборки неизменяемы: сначала кэш
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  // Переходы по страницам: сеть, а при её отсутствии — сохранённая оболочка
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) (await caches.open(CACHE)).put('/', res.clone());
          return res;
        } catch {
          const shell = await (await caches.open(CACHE)).match('/');
          return (
            shell ??
            new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })
          );
        }
      })(),
    );
  }
});
