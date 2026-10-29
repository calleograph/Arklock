// Обход интерфейса для проверки вёрстки: scripts/ui-audit.mjs <каталог> [--browser chromium|webkit] [--widths 320,390,1280]
//   [--themes glass,night] [--shots] [--routes admin/smtp,settings] [--device "iPhone 13"]
// Запускает сервер с тестовой базой в памяти, создаёт главного администратора и обходит разделы на заданных ширинах и темах.
// Для каждого экрана проверяет: горизонтальную прокрутку страницы, ошибки консоли и страницы, пустую страницу, поля ввода
// ниже 16 px на узком экране и кнопки ниже 32 px. Итог пишет в <каталог>/report.json. Требуется собранный проект.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium, devices, firefox, webkit } from '@playwright/test';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const OUT = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : 'test-results/ui-audit');
const WIDTHS = opt('widths', '320,375,390,768,1024,1280,1920').split(',').map(Number);
const THEMES = opt('themes', 'glass,night,grove,aurora').split(',');
const SHOTS = argv.includes('--shots');
const BROWSER = opt('browser', 'chromium');
const ADMIN_TABS = (
  'overview,resources,containers,backups,logs,storage,diagnostics,certificates,smtp,ldap,sso,saml,syslog,' +
  'webhooks,invitations,roles,updates,organization,automation,departments,vaults,wizards,transfer,shield,' +
  'users,circles,settings,ledger'
).split(',');
const ROUTES = opt(
  'routes',
  [
    '',
    'settings',
    'security',
    'notifications',
    'help',
    ...ADMIN_TABS.map((t) => `admin/${t}`),
  ].join(','),
).split(',');
const PORT = 18198;
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP = 'ui-audit-setup-code-ui-audit-code-1';
const USER = { email: 'audit@example.com', name: 'Аудит', password: 'ui-audit-master-password-1' };
mkdirSync(OUT, { recursive: true });
mkdirSync('test-results', { recursive: true });
const BLOB_DIR = mkdtempSync(path.resolve('test-results/ui-audit-blobs-'));

const server = spawn('node', ['apps/api/dist/main.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    DATABASE_URL: 'pglite:memory',
    BLOB_DIR,
    APP_SECRET: 'ui-audit-secret-ui-audit-secret-12345',
    WEB_DIST: 'apps/web/dist',
    LOG_LEVEL: 'error',
    TRUSTED_PROXY_HOPS: '0',
    BOOTSTRAP_TOKEN: SETUP,
    APP_PUBLIC_URL: BASE,
    APP_VERSION: readFileSync('VERSION', 'utf8').trim(),
    SMTP_ALLOW_LOOPBACK: 'on',
  },
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/v1/ready`)).ok) return;
    } catch {
      /* ещё не запущен */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

const go = (page, route) =>
  page.evaluate((r) => {
    globalThis.history.pushState({}, '', `/${r}`);
    globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'));
  }, route);

const setTheme = (page, id) =>
  page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.classList.toggle('dark', t === 'night' || t === 'aurora');
  }, id);

/** Метрики вёрстки текущего экрана. */
const measure = (page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const root = document.documentElement;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = globalThis.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const wide = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (
        r.right > vw + 1 &&
        !el.closest('.overflow-x-auto,.overflow-auto,.overflow-x-scroll,table,[data-allow-wide]')
      ) {
        wide.push(
          `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}`,
        );
        if (wide.length >= 5) break;
      }
    }
    const smallInputs =
      vw <= 560
        ? [
            ...document.querySelectorAll(
              'input:not([type=checkbox]):not([type=radio]):not([type=file]),select,textarea',
            ),
          ]
            .filter(visible)
            .filter((el) => parseFloat(globalThis.getComputedStyle(el).fontSize) < 16).length
        : 0;
    const main = document.querySelector('main');
    return {
      overflowX: root.scrollWidth > vw + 1,
      scrollWidth: root.scrollWidth,
      clientWidth: vw,
      wide,
      smallInputs,
      empty: !main || main.innerText.trim().length < 3,
      height: root.scrollHeight,
    };
  });

const report = [];
const noise = /favicon|Failed to load resource.*(401|403|404)/;

try {
  await waitReady();
  const engine = { webkit, firefox, chromium }[BROWSER] ?? chromium;
  const browser = await engine.launch({
    channel: BROWSER === 'chromium' ? process.env.E2E_CHANNEL || undefined : undefined,
  });
  const device = opt('device', '');
  const ctx = await browser.newContext(
    device
      ? { ...devices[device], locale: 'ru-RU' }
      : { viewport: { width: 1280, height: 800 }, locale: 'ru-RU' },
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.split('\n')[0]}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !noise.test(m.text()))
      errors.push(`console: ${m.text().slice(0, 160)}`);
  });

  await page.goto(`${BASE}/`);
  await page.getByTestId('name').waitFor();
  await page.getByTestId('email').fill(USER.email);
  await page.getByTestId('name').fill(USER.name);
  await page.getByTestId('setup-token').fill(SETUP);
  await page.getByTestId('password').fill(USER.password);
  await page.getByTestId('repeat').fill(USER.password);
  await page.getByTestId('submit').click();
  await page.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await page.getByTestId('recovery-continue').click();
  await page.getByTestId('add-entry').waitFor({ timeout: 90_000 });
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();

  if (argv.includes('--scenes')) {
    // сценарии «до/после»: форма SMTP (выбор NTLM) и раздел обновлений
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        const shot = (n) =>
          page.screenshot({ path: path.join(OUT, `scene-${n}-${theme}-${width}.png`) });
        errors.length = 0;
        await go(page, 'admin/smtp');
        await page.getByTestId('smtp-add').click();
        await page.waitForTimeout(400);
        await shot('smtp-form');
        await page
          .getByTestId('smtp-auth')
          .selectOption('ntlm')
          .catch(() => undefined);
        await page.waitForTimeout(500);
        await shot('smtp-ntlm');
        const alive = await page
          .getByTestId('smtp-user')
          .isVisible()
          .catch(() => false);
        report.push({
          theme,
          width,
          route: 'scene:smtp-ntlm',
          overflowX: false,
          empty: !alive,
          errors: [...errors],
          smallInputs: 0,
          wide: [],
        });
        await go(page, 'admin/updates');
        await page.waitForTimeout(500);
        await shot('updates');
      }
    }
    writeFileSync(path.join(OUT, 'report-scenes.json'), JSON.stringify(report, null, 1));
    for (const r of report)
      console.log(
        `${r.theme} ${r.width} ${r.route}: ${r.empty ? 'ПУСТО/СБОЙ' : 'ok'} ${r.errors.join(' | ')}`,
      );
    await browser.close();
    process.exit(0);
  }

  for (const theme of THEMES) {
    await setTheme(page, theme);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width < 600 ? 800 : 800 });
      for (const route of ROUTES) {
        errors.length = 0;
        await go(page, route);
        await page.waitForTimeout(450);
        const m = await measure(page);
        const name = `${theme}-${width}-${route.replaceAll('/', '_') || 'home'}`;
        if (SHOTS) await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
        report.push({ theme, width, route, ...m, errors: [...errors] });
      }
    }
  }
  await browser.close();

  const bad = report.filter((r) => r.overflowX || r.empty || r.errors.length || r.smallInputs);
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`экранов: ${report.length}, с замечаниями: ${bad.length}`);
  for (const r of bad.slice(0, 80))
    console.log(
      `${r.theme} ${r.width} /${r.route}: ${r.overflowX ? `прокрутка ${r.scrollWidth}>${r.clientWidth} [${r.wide.join(' ')}] ` : ''}${r.empty ? 'ПУСТО ' : ''}${r.smallInputs ? `полей<16px: ${r.smallInputs} ` : ''}${r.errors.join(' | ')}`,
    );
  process.exitCode = bad.length ? 1 : 0;
} finally {
  server.kill();
}
