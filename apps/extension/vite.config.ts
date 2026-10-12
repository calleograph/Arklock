import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';

/** PNG-значок: синий квадрат со скруглением и белым замком (рисуется программно, без внешних файлов). */
function icon(size: number): Buffer {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.18;
  const inside = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
    x >= x0 && x < x1 && y >= y0 && y < y1;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    px[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 4;
      const cx = Math.min(x, size - 1 - x);
      const cy = Math.min(y, size - 1 - y);
      const corner = cx < r && cy < r && (r - cx) ** 2 + (r - cy) ** 2 > r * r;
      if (corner) continue; // прозрачный угол
      const body = inside(x, y, size * 0.3, size * 0.48, size * 0.7, size * 0.78);
      const shackleOuter = inside(x, y, size * 0.36, size * 0.24, size * 0.64, size * 0.5);
      const shackleInner = inside(x, y, size * 0.44, size * 0.32, size * 0.56, size * 0.5);
      const white = body || (shackleOuter && !shackleInner);
      px[i] = white ? 255 : 37;
      px[i + 1] = white ? 255 : 99;
      px[i + 2] = white ? 255 : 235;
      px[i + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(px)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Цель сборки: chromium (по умолчанию) или firefox (EXT_TARGET=firefox) — отдельный каталог и манифест. */
const FIREFOX = process.env.EXT_TARGET === 'firefox';
const OUT_DIR = FIREFOX ? 'dist-firefox' : 'dist';

/**
 * Манифест Manifest V3 формируется при сборке.
 * Права минимальны: activeTab + scripting (заполнение только по действию пользователя на текущей вкладке),
 * storage + alarms (сессия в памяти и автоблокировка), доступ к серверу запрашивается у пользователя при входе.
 * Для тестового стенда EXT_TEST_HOSTS добавляет постоянные разрешения на указанные адреса.
 */
function manifestPlugin(): Plugin {
  return {
    name: 'arklock-manifest',
    apply: 'build',
    closeBundle() {
      const out = path.resolve(__dirname, OUT_DIR);
      mkdirSync(path.join(out, 'icons'), { recursive: true });
      for (const s of [16, 48, 128]) writeFileSync(path.join(out, 'icons', `${s}.png`), icon(s));
      const testHosts = (process.env.EXT_TEST_HOSTS ?? '').split(',').filter(Boolean);
      const manifest = {
        manifest_version: 3,
        name: 'Arklock',
        short_name: 'Arklock',
        description:
          'Arklock: search, autofill, TOTP and password generator. Secrets are decrypted only in your browser.',
        version: process.env.EXT_VERSION ?? '0.1.0',
        ...(FIREFOX
          ? {
              // Идентификатор нужен Firefox для хранилища и подписи; для публикации задайте свой: EXT_GECKO_ID
              browser_specific_settings: {
                gecko: {
                  id: process.env.EXT_GECKO_ID ?? 'arklock@example.com',
                  strict_min_version: '140.0',
                  data_collection_permissions: { required: ['none'] },
                },
                gecko_android: { strict_min_version: '142.0' },
              },
            }
          : { minimum_chrome_version: '116' }),
        icons: { '16': 'icons/16.png', '48': 'icons/48.png', '128': 'icons/128.png' },
        action: {
          default_popup: 'popup.html',
          default_title: 'Arklock',
          default_icon: { '16': 'icons/16.png', '48': 'icons/48.png' },
        },
        // Firefox запускает фоновую часть как страницу событий (scripts), Chromium — как сервис-воркер
        background: FIREFOX
          ? { scripts: ['background.js'], type: 'module' }
          : { service_worker: 'background.js', type: 'module' },
        permissions: ['activeTab', 'scripting', 'storage', 'alarms', 'clipboardWrite'],
        optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
        // Только для проверочных сборок: WebDriver открывает окно расширения вкладкой, а Firefox пускает по адресу
        // moz-extension:// лишь на страницы из web_accessible_resources. В боевой сборке этого раздела нет.
        ...(testHosts.length
          ? {
              host_permissions: testHosts,
              web_accessible_resources: [
                { resources: ['popup.html', 'assets/*'], matches: ['<all_urls>'] },
              ],
            }
          : {}),
        content_security_policy: {
          extension_pages:
            "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'none'" +
            (testHosts.length ? '' : "; frame-ancestors 'none'"),
        },
      };
      writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    },
  };
}

export default defineConfig({
  plugins: [manifestPlugin()],
  // Проверочная сборка (EXT_TEST_HOSTS): окно расширения открывается во фрейме обычной страницы, где Firefox не даёт
  // storage.session и alarms; для проверок используется запасная область. В боевой сборке константа ложна и код удаляется.
  define: { __TEST_BUILD__: JSON.stringify(!!process.env.EXT_TEST_HOSTS) },
  base: './',
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2023',
    rollupOptions: {
      input: {
        popup: path.resolve(__dirname, 'popup.html'),
        background: path.resolve(__dirname, 'src/background.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
});
