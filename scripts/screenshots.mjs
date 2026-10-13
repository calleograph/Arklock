// Снимки экранов для README и визуальной проверки тем: scripts/screenshots.mjs [каталог] [--quick]
// Запускает сервер с тестовой базой в памяти, создаёт учётную запись с примерами записей (вымышленными) и снимает основные
// экраны во всех темах на компьютере и телефоне. Требуется собранный проект (npm run build) и браузер Playwright или
// установленный Edge/Chrome (E2E_CHANNEL=msedge|chrome).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

const OUT = path.resolve(
  process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'docs/screenshots',
);
const QUICK = process.argv.includes('--quick');
const PORT = 18199;
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP = 'screenshots-setup-code-screenshots-1';
const USER = {
  email: 'anna@example.com',
  name: 'Анна Смирнова',
  password: 'screenshots-master-password-1',
};
const THEMES = ['corporate', 'light', 'dark', 'forest', 'emerald', 'sunset'];
mkdirSync(OUT, { recursive: true });

const server = spawn('node', ['apps/api/dist/main.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    DATABASE_URL: 'pglite:memory',
    APP_SECRET: 'screenshots-secret-screenshots-secret-12345',
    WEB_DIST: 'apps/web/dist',
    LOG_LEVEL: 'error',
    TRUSTED_PROXY_HOPS: '0',
    BOOTSTRAP_TOKEN: SETUP,
    APP_PUBLIC_URL: BASE,
  },
  stdio: 'ignore',
});
const stop = () => server.kill();
process.on('exit', stop);

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

const tid = (page, id) => page.getByTestId(id);

async function addEntry(page, f) {
  await tid(page, 'add-entry').click();
  if (f.kind) await tid(page, 'f-kind').selectOption(f.kind);
  await tid(page, 'f-title').fill(f.title);
  if (f.username) await tid(page, 'f-username').fill(f.username);
  if (f.password) await tid(page, 'f-password').fill(f.password);
  if (f.url) await tid(page, 'f-url').fill(f.url);
  if (f.totp) await tid(page, 'f-totp').fill(f.totp);
  if (f.tags) await tid(page, 'f-tags').fill(f.tags);
  await tid(page, 'f-save').click();
  await tid(page, 'view-title').waitFor();
}

async function folder(page, name) {
  await tid(page, 'btn-new-folder').click();
  await tid(page, 'name-input').fill(name);
  await tid(page, 'name-ok').click();
  await page.getByTestId('branch-row').filter({ hasText: name }).waitFor();
}

async function shot(page, name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('снимок:', name);
}

async function setTheme(page, id) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.classList.toggle('dark', t === 'dark' || t === 'forest');
  }, id);
}

try {
  await waitReady();
  const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || undefined });
  const ctx = await browser.newContext({
    viewport: { width: 1360, height: 860 },
    locale: 'ru-RU',
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  // вход (до регистрации)
  await page.goto(BASE + '/');
  await page.getByTestId('name').waitFor();
  await shot(page, 'login-corporate');

  await tid(page, 'email').fill(USER.email);
  await tid(page, 'name').fill(USER.name);
  await tid(page, 'setup-token').fill(SETUP);
  await tid(page, 'password').fill(USER.password);
  await tid(page, 'repeat').fill(USER.password);
  await tid(page, 'submit').click();
  await tid(page, 'recovery-saved').check({ timeout: 90_000 });
  await tid(page, 'recovery-continue').click();
  await tid(page, 'add-entry').waitFor({ timeout: 90_000 });

  await folder(page, 'Инфраструктура');
  await folder(page, 'Финансы');
  await folder(page, 'Маркетинг');
  const samples = [
    {
      title: 'Почта компании',
      username: 'anna@example.com',
      password: 'Fj7#kQ2!mXw9-pL',
      url: 'https://mail.example.com',
      tags: 'почта, работа',
    },
    {
      title: 'Сервер баз данных',
      kind: 'server',
      username: 'postgres',
      password: 'Zq8$vT3&nRb6-hY',
      url: 'https://db.example.com',
      totp: 'JBSWY3DPEHPK3PXP',
      tags: 'prod',
    },
    {
      title: 'Банк-клиент',
      username: 'finance-bot',
      password: 'Mw4%cH9@sJd2-gK',
      url: 'https://bank.example.com',
      totp: 'JBSWY3DPEHPK3PXP',
      tags: 'финансы',
    },
    {
      title: 'Рекламный кабинет',
      username: 'ads@example.com',
      password: 'Pc6^bN1*uVx8-eT',
      url: 'https://ads.example.com',
      tags: 'маркетинг',
    },
    {
      title: 'Облачное хранилище',
      username: 'storage-admin',
      password: 'Ys5!dG7#kZq3-wR',
      url: 'https://cloud.example.com',
    },
    {
      title: 'Git-репозиторий',
      kind: 'apikey',
      username: 'ci-token',
      password: 'Hn2@fL8$tCv4-jM',
      url: 'https://git.example.com',
      tags: 'dev',
    },
  ];
  for (const s of samples) await addEntry(page, s);
  await tid(page, 'btn-pin').click();

  // рабочая область во всех темах
  await tid(page, 'entry-row').first().click();
  await tid(page, 'btn-reveal').click();
  const themes = QUICK ? ['corporate', 'dark'] : THEMES;
  for (const t of themes) {
    await setTheme(page, t);
    await shot(page, `vault-${t}`);
  }
  await setTheme(page, 'corporate');

  // настройки внешнего вида
  await tid(page, 'menu-toggle').click();
  await tid(page, 'menu-settings').click();
  await tid(page, 'theme-sunset').waitFor();
  for (const t of QUICK ? ['corporate'] : ['corporate', 'forest']) {
    await setTheme(page, t);
    await shot(page, `settings-${t}`);
  }
  await setTheme(page, 'corporate');

  // безопасность
  await tid(page, 'menu-toggle').click();
  await tid(page, 'menu-security').click();
  await page.getByTestId('sessions').waitFor();
  await shot(page, 'security-corporate');

  // администрирование
  await tid(page, 'menu-toggle').click();
  await tid(page, 'menu-full').click();
  await tid(page, 'admin-tab-overview').waitFor();
  await tid(page, 'admin-tab-overview').click();
  await page.waitForTimeout(800);
  await shot(page, 'admin-overview-corporate');
  await tid(page, 'admin-tab-users').click();
  await page.waitForTimeout(500);
  await shot(page, 'admin-users-corporate');
  if (!QUICK) {
    await setTheme(page, 'dark');
    await shot(page, 'admin-users-dark');
    await setTheme(page, 'corporate');
  }

  // телефон
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'ru-RU',
  });
  const mp = await phone.newPage();
  await mp.goto(BASE + '/login');
  await tid(mp, 'email').fill(USER.email);
  await tid(mp, 'password').fill(USER.password);
  await tid(mp, 'submit').click();
  await tid(mp, 'add-entry').waitFor({ timeout: 90_000 });
  await shot(mp, 'mobile-vault-corporate');
  await tid(mp, 'entry-row').first().click();
  await shot(mp, 'mobile-entry-corporate');
  if (!QUICK) {
    await setTheme(mp, 'forest');
    await shot(mp, 'mobile-entry-forest');
  }
  await browser.close();
} finally {
  stop();
}
