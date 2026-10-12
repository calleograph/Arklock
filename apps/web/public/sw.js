/*
 * Service worker Arklock. Кэширует ТОЛЬКО статические файлы интерфейса (оболочку), чтобы приложение быстро открывалось и
 * ставилось на главный экран. Запросы к API (/api/), страницы получения секрета (/h/) и любые не-GET запросы не кэшируются
 * никогда: ни шифртекст, ни ответы сервера в кэш не попадают. Обновление версии интерфейса подхватывается при следующей загрузке.
 */
const CACHE = 'arklock-shell-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

/* Потоковое скачивание вложений: страница шлёт расшифрованные куски через MessagePort, ответ на /sw-download/<id> собирается из них. */
const downloads = new Map();
self.addEventListener('message', (event) => {
  const d = event.data;
  if (d && d.type === 'download' && event.ports[0])
    downloads.set(d.id, { name: String(d.name || 'file'), port: event.ports[0] });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/sw-download/')) {
    const id = url.pathname.slice('/sw-download/'.length);
    const d = downloads.get(id);
    if (!d) {
      event.respondWith(new Response('Not found', { status: 404 }));
      return;
    }
    downloads.delete(id);
    const stream = new ReadableStream({
      start(controller) {
        d.port.onmessage = (m) => {
          if (m.data === null) controller.close();
          else if (m.data === 'abort') controller.error(new Error('aborted'));
          else controller.enqueue(new Uint8Array(m.data));
        };
      },
    });
    event.respondWith(
      new Response(stream, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(d.name),
          'cache-control': 'no-store',
        },
      }),
    );
    return;
  }
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
