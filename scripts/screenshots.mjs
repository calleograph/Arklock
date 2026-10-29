// Снимки экранов для README и визуальной проверки тем: scripts/screenshots.mjs [каталог] [--quick]
// Запускает сервер с тестовой базой в памяти, создаёт учётную запись с примерами записей (вымышленными) и снимает основные
// экраны во всех темах на компьютере и телефоне. Требуется собранный проект (npm run build) и браузер Playwright или
// установленный Edge/Chrome (E2E_CHANNEL=msedge|chrome).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
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
const THEMES = ['glass', 'night', 'grove', 'aurora'];
mkdirSync(OUT, { recursive: true });
mkdirSync('test-results', { recursive: true });
const BLOB_DIR = mkdtempSync(path.resolve('test-results/screenshots-blobs-'));

const server = spawn('node', ['apps/api/dist/main.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    DATABASE_URL: 'pglite:memory',
    BLOB_DIR,
    APP_SECRET: 'screenshots-secret-screenshots-secret-12345',
    WEB_DIST: 'apps/web/dist',
    LOG_LEVEL: 'error',
    TRUSTED_PROXY_HOPS: '0',
    BOOTSTRAP_TOKEN: SETUP,
    APP_PUBLIC_URL: BASE,
    APP_VERSION: readFileSync('VERSION', 'utf8').trim(),
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
  if (f.kind) await tid(page, `f-kind-${f.kind}`).click();
  await tid(page, 'f-title').fill(f.title);
  if (f.username) await tid(page, 'f-username').fill(f.username);
  if (f.password) await tid(page, 'f-password').fill(f.password);
  if (f.url) await tid(page, 'f-url').fill(f.url);
  if (f.totp || f.tags) await page.getByTestId('f-more').evaluate((d) => (d.open = true));
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
    document.documentElement.classList.toggle('dark', t === 'night' || t === 'aurora');
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
  await shot(page, 'login-glass');

  await tid(page, 'email').fill(USER.email);
  await tid(page, 'name').fill(USER.name);
  await tid(page, 'setup-token').fill(SETUP);
  await tid(page, 'password').fill(USER.password);
  await tid(page, 'repeat').fill(USER.password);
  await tid(page, 'submit').click();
  await tid(page, 'recovery-saved').check({ timeout: 90_000 });
  await tid(page, 'recovery-continue').click();
  await tid(page, 'add-entry').waitFor({ timeout: 90_000 });
  assert.equal(
    (await tid(page, 'vault-select').locator('option:checked').textContent()).trim(),
    'Организация',
  );
  assert.equal(await tid(page, 'vault-select').locator('option').count(), 1);
  await tid(page, 'vault-overview').waitFor();
  await shot(page, 'home-glass');

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

  const originalVaultId = await tid(page, 'vault-select').inputValue();
  await tid(page, 'vault-actions').click();
  await tid(page, 'btn-new-vault').click();
  await tid(page, 'name-input').fill('Проверка переноса');
  await tid(page, 'name-ok').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="vault-select"] option:checked')?.textContent?.trim() ===
      'Проверка переноса',
  );
  const temporaryVaultId = await tid(page, 'vault-select').inputValue();
  await addEntry(page, { title: 'Проверка вложений', password: 'Fixture-Password-78!a' });
  await tid(page, 'tab-files').click();
  await tid(page, 'file-input').setInputFiles({
    name: 'transfer.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('synthetic attachment round trip'),
  });
  await tid(page, 'file-row').waitFor();
  await tid(page, 'entry-actions').click();
  await tid(page, 'entry-move').click();
  await tid(page, 'move-target').selectOption(originalVaultId);
  const contentRoute = `**/vaults/${originalVaultId}/attachments/*/content`;
  await page.route(contentRoute, async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    body[0] ^= 1;
    await route.fulfill({ response, body });
  });
  await tid(page, 'btn-move').click();
  await tid(page, 'ws-error').waitFor();
  assert.equal(
    await tid(page, 'entry-row').filter({ hasText: 'Проверка вложений' }).count(),
    1,
    'failed verification must preserve source',
  );
  await page.unroute(contentRoute);
  await tid(page, 'btn-move').click();
  await tid(page, 'entry-row')
    .filter({ hasText: 'Проверка вложений' })
    .waitFor({ state: 'detached' });
  // Поиск находит запись в другом сейфе, не меняя выбор до явного открытия результата.
  await tid(page, 'search').fill('Проверка вложений');
  await tid(page, 'global-search-result').first().waitFor();
  assert.equal(await tid(page, 'vault-select').inputValue(), temporaryVaultId);
  await tid(page, 'global-search-result').first().click();
  await page.waitForFunction(
    (id) => document.querySelector('[data-testid="vault-select"]')?.value === id,
    originalVaultId,
  );
  await tid(page, 'view-title').filter({ hasText: 'Проверка вложений' }).waitFor();
  await tid(page, 'tab-files').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    tid(page, 'file-download').click(),
  ]);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(await download.path(), 'utf8'), 'synthetic attachment round trip');
  await tid(page, 'entry-actions').click();
  await tid(page, 'btn-trash').click();
  await tid(page, 'entry-row')
    .filter({ hasText: 'Проверка вложений' })
    .waitFor({ state: 'detached' });
  const token = await page.evaluate(() => globalThis.sessionStorage.getItem('arklock.token'));
  assert.equal(
    (
      await page.request.delete(`${BASE}/api/v1/vaults/${temporaryVaultId}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status(),
    204,
  );
  console.log('проверено: повреждённая копия, перенос вложения, поиск между сейфами');

  // рабочая область во всех темах
  await tid(page, 'entry-row').first().click();
  await tid(page, 'btn-reveal').click();
  const themes = QUICK ? ['glass', 'night'] : THEMES;
  for (const t of themes) {
    await setTheme(page, t);
    await shot(page, `vault-${t}`);
  }
  await setTheme(page, 'glass');

  // Новые вкладки содержат реальные данные; журнал отличается от истории версий.
  await tid(page, 'tab-access').click();
  await tid(page, 'entry-access').waitFor();
  await page.getByText(USER.name, { exact: false }).first().waitFor();
  await shot(page, 'entry-access-glass');
  await tid(page, 'tab-journal').click();
  await tid(page, 'entry-journal').waitFor();
  await shot(page, 'entry-journal-glass');
  await tid(page, 'tab-settings').click();
  await tid(page, 'entry-settings').waitFor();
  await shot(page, 'entry-settings-glass');
  await tid(page, 'tab-details').click();

  await page.getByTestId('branch-row').filter({ hasText: 'Инфраструктура' }).first().click();
  await tid(page, 'folder-panel').waitFor();
  await shot(page, 'folder-access-glass');
  await tid(page, 'scope-all').click();
  await tid(page, 'vault-overview').waitFor();
  await shot(page, 'home-glass');

  // настройки внешнего вида
  await tid(page, 'menu-toggle').click();
  await tid(page, 'menu-settings').click();
  await tid(page, 'theme-aurora').waitFor();
  for (const t of QUICK ? ['glass'] : ['glass', 'aurora']) {
    await setTheme(page, t);
    await shot(page, `settings-${t}`);
  }
  await setTheme(page, 'glass');

  // безопасность
  await tid(page, 'menu-toggle').click();
  await tid(page, 'menu-security').click();
  await page.getByTestId('sessions').waitFor();
  await shot(page, 'security-glass');

  // администрирование
  await tid(page, 'menu-toggle').click();
  await tid(page, 'menu-full').click();
  await tid(page, 'admin-tab-overview').waitFor();
  await tid(page, 'admin-tab-overview').click();
  await page.waitForTimeout(800);
  await shot(page, 'admin-overview-glass');
  await tid(page, 'admin-tab-settings').click();
  await tid(page, 'settings-group-access').waitFor();
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await shot(page, 'admin-settings-glass');
  await tid(page, 'settings-tab-security').click();
  const recoveryPhrase = 'demonstration-offline-recovery-passphrase-1';
  await tid(page, 'recovery-new-phrase').fill(recoveryPhrase);
  await tid(page, 'recovery-repeat-phrase').fill(recoveryPhrase);
  await tid(page, 'recovery-create-package').click();
  await tid(page, 'recovery-download').waitFor({ timeout: 90_000 });
  const [recoveryDownload] = await Promise.all([
    page.waitForEvent('download'),
    tid(page, 'recovery-download').click(),
  ]);
  const recoveryPath = await recoveryDownload.path();
  assert(recoveryPath);
  assert(
    !(await readFile(recoveryPath, 'utf8')).includes(recoveryPhrase),
    'offline package must not contain its passphrase',
  );
  await tid(page, 'recovery-package-saved').check();
  await tid(page, 'recovery-activate').click();
  await tid(page, 'recovery-fingerprint').waitFor();
  await tid(page, 'menu-toggle').click();
  await tid(page, 'menu-vault').click();
  await tid(page, 'vault-actions').click();
  await tid(page, 'btn-vault-settings').click();
  await tid(page, 'vault-recovery-confirm').check();
  await tid(page, 'vault-recovery-enroll').click();
  await tid(page, 'vault-recovery-status')
    .filter({ hasText: /ключ актуален|current/ })
    .waitFor();
  await shot(page, 'vault-recovery-glass');
  await tid(page, 'menu-toggle').click();
  await tid(page, 'menu-full').click();
  await tid(page, 'admin-tab-settings').click();
  await tid(page, 'settings-tab-security').click();
  await tid(page, 'recovery-import-file').setInputFiles(recoveryPath);
  await tid(page, 'recovery-import-phrase').fill(recoveryPhrase);
  await tid(page, 'recovery-unlock-package').click();
  await tid(page, 'recovery-claim-confirm').check({ timeout: 90_000 });
  await tid(page, 'recovery-claim-confirm').uncheck();
  // Уход со вкладки уничтожает импортированные закрытые ключи.
  await tid(page, 'settings-tab-main').click();
  await tid(page, 'settings-tab-security').click();
  assert.equal(await tid(page, 'recovery-claim-confirm').count(), 0);
  await tid(page, 'recovery-import-file').setInputFiles(recoveryPath);
  await tid(page, 'recovery-import-phrase').fill(recoveryPhrase);
  await tid(page, 'recovery-unlock-package').click();
  await tid(page, 'recovery-claim-confirm').check({ timeout: 90_000 });
  const [recovered] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/admin/corporate-recovery/') &&
        response.url().endsWith('/recover') &&
        response.request().method() === 'POST',
    ),
    tid(page, 'recovery-vault-row').filter({ hasText: 'Организация' }).getByRole('button').click(),
  ]);
  assert.equal(recovered.status(), 200);
  await page
    .getByRole('status')
    .filter({ hasText: /Права владельца|Owner/ })
    .waitFor();
  await tid(page, 'settings-tab-main').click();
  await tid(page, 'settings-tab-security').click();
  await shot(page, 'corporate-recovery-glass');

  // замена офлайн-пакета: подготовка, переподключение сейфа, завершение
  const oldFingerprint = await tid(page, 'recovery-fingerprint').textContent();
  const replacementPhrase = 'replacement-offline-recovery-passphrase-2';
  await tid(page, 'replacement-phrase').fill(replacementPhrase);
  await tid(page, 'replacement-prepare').click();
  await tid(page, 'replacement-download').waitFor({ timeout: 90_000 });
  await Promise.all([page.waitForEvent('download'), tid(page, 'replacement-download').click()]);
  await page.getByTestId('recovery-replacement').getByRole('checkbox').check();
  await tid(page, 'replacement-start').click();
  await tid(page, 'replacement-complete').waitFor();
  await tid(page, 'menu-toggle').click();
  await tid(page, 'menu-vault').click();
  await tid(page, 'vault-actions').click();
  await tid(page, 'btn-vault-settings').click();
  await tid(page, 'vault-recovery-pending-confirm').check();
  await tid(page, 'vault-recovery-pending-enroll').click();
  await tid(page, 'vault-recovery-pending')
    .getByText(/подключён к новому|connected to the new/)
    .waitFor();
  await tid(page, 'menu-toggle').click();
  await tid(page, 'menu-full').click();
  await tid(page, 'admin-tab-settings').click();
  await tid(page, 'settings-tab-security').click();
  await tid(page, 'replacement-complete').click();
  await tid(page, 'replacement-prepare').waitFor();
  assert.notEqual(await tid(page, 'recovery-fingerprint').textContent(), oldFingerprint);
  console.log('проверено: замена офлайн-пакета восстановления');
  console.log(
    'проверено: офлайн-пакет, подключение, восстановление, очистка ключей при уходе со вкладки',
  );
  await tid(page, 'admin-tab-users').click();
  await page.waitForTimeout(500);
  await shot(page, 'admin-users-glass');
  if (!QUICK) {
    await setTheme(page, 'night');
    await shot(page, 'admin-users-night');
    await setTheme(page, 'glass');
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
  await shot(mp, 'mobile-vault-glass');
  await tid(mp, 'entry-row').first().click();
  await tid(mp, 'view-title').waitFor();
  const entryBounds = await tid(mp, 'view-title').boundingBox();
  assert(
    entryBounds && entryBounds.y >= 0 && entryBounds.y < 844,
    'mobile entry must be visible after selection',
  );
  assert(
    await mp.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth),
    'mobile page must not overflow horizontally',
  );
  await shot(mp, 'mobile-entry-glass');
  if (!QUICK) {
    await setTheme(mp, 'aurora');
    await shot(mp, 'mobile-entry-aurora');
  }
  await browser.close();
} finally {
  stop();
}
