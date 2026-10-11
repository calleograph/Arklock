import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

const SETUP = 'e2e-setup-code-e2e-setup-code-3';
const ADMIN = {
  email: 'ws.admin@example.com',
  name: 'Админ',
  password: 'ws-admin-master-password-1',
};
const MEMBER = {
  email: 'ws.member@example.com',
  name: 'Участник',
  password: 'ws-member-master-password-2',
};

test.describe.configure({ mode: 'serial' });

async function register(page: Page, u: typeof ADMIN, setup?: string): Promise<void> {
  await page.goto('/');
  // для первой записи форма регистрации открывается сама; иначе переходим по ссылке
  try {
    await page.getByTestId('name').waitFor({ timeout: 4000 });
  } catch {
    await page.getByTestId('to-register').click();
  }
  await page.getByTestId('email').fill(u.email);
  await page.getByTestId('name').fill(u.name);
  if (setup) await page.getByTestId('setup-token').fill(setup);
  await page.getByTestId('password').fill(u.password);
  await page.getByTestId('repeat').fill(u.password);
  await page.getByTestId('submit').click();
  await page.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await page.getByTestId('recovery-continue').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
}

async function login(page: Page, u: typeof ADMIN): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('email').fill(u.email);
  await page.getByTestId('password').fill(u.password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
}

async function addEntry(
  page: Page,
  f: { title: string; username?: string; password?: string; url?: string },
) {
  await page.getByTestId('add-entry').click();
  await page.getByTestId('f-title').fill(f.title);
  if (f.username) await page.getByTestId('f-username').fill(f.username);
  if (f.password) await page.getByTestId('f-password').fill(f.password);
  if (f.url) await page.getByTestId('f-url').fill(f.url);
  await page.getByTestId('f-save').click();
  await expect(page.getByTestId('view-title')).toHaveText(f.title);
}

async function newFolder(page: Page, name: string): Promise<void> {
  await page.getByTestId('btn-new-folder').click();
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId('name-ok').click();
  await expect(page.getByTestId('branch-row').filter({ hasText: name })).toBeVisible();
}

const FILE_TEXT = 'СЕКРЕТНОЕ СОДЕРЖИМОЕ ФАЙЛА 7731';
const BLOB_DIR = path.resolve('test-results', 'blobs-workspace');

/** Все файлы хранилища вложений: ни один не должен содержать открытый текст или имя файла. */
function storedFiles(dir = BLOB_DIR): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) out.push(...storedFiles(p));
    else out.push(p);
  }
  return out;
}

async function downloadText(page: Page): Promise<string> {
  await page.getByTestId('tab-files').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('file-download').click(),
  ]);
  expect(download.suggestedFilename()).toBe('договор.txt');
  return readFileSync((await download.path())!, 'utf8');
}

let adminPage: Page;
let memberPage: Page;
let sharedLink = '';

test('administrator builds a structure and works with entries', async ({ browser }) => {
  adminPage = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const page = adminPage;
  await register(page, ADMIN, SETUP);

  // папки и вложенность
  await newFolder(page, 'Финансы');
  await page
    .getByTestId('branch-row')
    .filter({ hasText: 'Финансы' })
    .getByRole('button')
    .nth(1)
    .click();
  await newFolder(page, 'Банки');
  await page
    .getByTestId('branch-row')
    .filter({ hasText: 'Банки' })
    .getByRole('button')
    .nth(1)
    .click();

  // запись типа «сервер» с TOTP, генератором, дополнительным полем и метками
  await page.getByTestId('add-entry').click();
  await page.getByTestId('f-kind').selectOption('server');
  await page.getByTestId('f-title').fill('Сервер банка');
  await page.getByTestId('f-username').fill('root');
  await page.getByTestId('btn-generate').click();
  await expect(page.getByTestId('strength')).toBeVisible();
  const generated = await page.getByTestId('f-password').inputValue();
  expect(generated).toHaveLength(20);
  await page.getByTestId('f-totp').fill('JBSWY3DPEHPK3PXP');
  await page.getByTestId('btn-add-field').click();
  await page.getByTestId('field-name-0').fill('IP');
  await page.getByTestId('field-value-0').fill('203.0.113.7');
  await page.getByTestId('f-tags').fill('prod, bank');
  await page.getByTestId('f-save').click();
  await expect(page.getByTestId('view-title')).toHaveText('Сервер банка');
  await expect(page.getByTestId('view-totp')).toHaveText(/^\d{6}$/);

  // запись лежит в выбранной папке «Банки»
  await expect(page.getByTestId('entry-row').first()).toContainText('Финансы / Банки');

  // поиск и фильтр по метке
  await addEntry(page, {
    title: 'Почта',
    username: 'me@example.com',
    password: 'Tr0ub4dor&3-qq',
    url: 'https://mail.example.com',
  });
  await page.getByTestId('search').fill('сервер');
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await page.getByTestId('search').fill('mail.example');
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await page.getByTestId('search').fill('');
  await page.getByTestId('kind-filter').selectOption('server');
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await page.getByTestId('kind-filter').selectOption('');
  await expect(page.getByTestId('entry-row')).toHaveCount(2);

  // избранное
  await page.getByTestId('entry-row').filter({ hasText: 'Почта' }).click();
  await page.getByTestId('btn-pin').click();
  await page.getByTestId('scope-favorites').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await page.getByTestId('scope-all').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(2);

  // история изменений и возврат версии
  await page.getByTestId('entry-row').filter({ hasText: 'Почта' }).click();
  await page.getByTestId('btn-edit').click();
  await page.getByTestId('f-password').fill('Second-Password-9!x');
  await page.getByTestId('f-save').click();
  await expect(page.getByTestId('view-title')).toHaveText('Почта');
  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('history-row')).toHaveCount(1);
  await page.getByTestId('btn-revert').click();
  await expect(page.getByTestId('tab-history')).toBeVisible();
  await page.getByRole('button', { name: /^Данные$|^Details$/ }).click();
  await page.getByTestId('btn-reveal').click();
  await expect(page.getByTestId('view-password')).toHaveText('Tr0ub4dor&3-qq');

  // корзина и восстановление
  await page.getByTestId('btn-trash').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await page.getByTestId('scope-trash').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await page.getByTestId('entry-row').click();
  await page.getByTestId('restore-entry').click();
  await page.getByTestId('scope-all').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(2);

  // массовое перемещение
  await page.getByTestId('select-all').check();
  await page.getByTestId('bulk-target').selectOption({ label: 'Финансы' });
  await page.getByTestId('bulk-move').click();
  await page
    .getByTestId('branch-row')
    .filter({ hasText: 'Финансы' })
    .getByRole('button')
    .nth(1)
    .click();
  await expect(page.getByTestId('entry-row')).toHaveCount(2);
});

test('a one-time link opens once, anonymously', async ({ browser }) => {
  const page = adminPage;
  await page.getByTestId('entry-row').filter({ hasText: 'Почта' }).click();
  await page.getByTestId('tab-share').click();
  await page.getByTestId('share-views').selectOption('1');
  await page.getByTestId('btn-create-link').click();
  sharedLink = (await page.getByTestId('share-link').textContent())!.trim();
  expect(sharedLink).toMatch(/\/h\/[0-9a-f-]{36}#[A-Za-z0-9_-]{43}$/);

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(sharedLink);
  await guest.getByTestId('handoff-open').click();
  await expect(guest.getByTestId('handoff-username')).toHaveText('me@example.com');
  const second = await (await browser.newContext()).newPage();
  await second.goto(sharedLink);
  await expect(second.getByTestId('handoff-gone')).toBeVisible();
  // ссылка без ключа не работает
  const bare = await (await browser.newContext()).newPage();
  await bare.goto(sharedLink.split('#')[0]!);
  await expect(bare.getByTestId('handoff-bad')).toBeVisible();
});

test('import (CSV), encrypted export and the security inspector', async () => {
  const page = adminPage;
  await page.getByTestId('btn-transfer').click();
  const csv =
    'title,username,password,url,folder\n"Wi-Fi 1",guest,password,,Офис\n"Wi-Fi 2",guest,password,,Офис\n"Wi-Fi 1",guest,password,,Офис\n"VPN",me,Zq8!vN3#xLp0wRt5,https://vpn.example.com,Офис\n';
  await page
    .getByTestId('import-file')
    .setInputFiles({ name: 'passwords.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByTestId('import-preview')).toContainText('4');
  await page.getByTestId('import-run').click();
  await expect(page.getByTestId('import-report')).toContainText(/Создано: 3|Created: 3/, {
    timeout: 60_000,
  });
  await page.getByTestId('tab-export').click();
  await page.getByTestId('export-pass').fill('export-passphrase-long-1');
  await page.getByTestId('export-pass2').fill('export-passphrase-long-1');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-run').click(),
  ]);
  const text = readFileSync((await download.path())!, 'utf8');
  expect(JSON.parse(text).format).toBe('arklock-encrypted');
  expect(text).not.toContain('Tr0ub4dor');
  expect(text).not.toContain('vpn.example.com');
  // открытый экспорт требует явного подтверждения
  await page.getByTestId('export-format').selectOption('csv');
  await expect(page.getByTestId('export-run')).toBeDisabled();
  await page.getByTestId('export-confirm').check();
  await expect(page.getByTestId('export-run')).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '✕' }).click();

  // инспектор: слабый пароль «password» найден локально, без отправки паролей
  const bodies: string[] = [];
  page.on('request', (r) => r.postData() && bodies.push(r.postData()!));
  await page.getByRole('button', { name: /Инспектор|Security inspector/ }).click();
  await expect(page.getByTestId('count-weak')).not.toHaveText('0');
  await expect(page.getByTestId('count-reused')).toHaveText('2');
  expect(bodies.join('')).not.toContain('Zq8!vN3');
});

test('a second user joins a shared vault; revoking access and rotating the key', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const page = adminPage;
  // администратор открывает регистрацию в настройках
  await page.getByTestId('nav-admin').click();
  await page.getByTestId('admin-tab-settings').click();
  await page.getByTestId('set-registration').selectOption('open');

  memberPage = await (await browser.newContext()).newPage();
  await register(memberPage, MEMBER);

  // администратор создаёт общее хранилище
  await page
    .getByRole('link', { name: /Сейф|Locker/ })
    .first()
    .click();
  await expect(page.getByTestId('vault-select')).toBeVisible();
  await page.getByTestId('btn-new-vault').click();
  await page.getByTestId('name-input').fill('Команда');
  await page.getByTestId('name-ok').click();
  await expect(page.getByTestId('vault-select').locator('option:checked')).toHaveText('Команда');
  await addEntry(page, { title: 'Общий сервер', username: 'ops', password: 'Shared-Secret-77!aa' });

  // вложение: шифруется в браузере, на сервере лежит только шифртекст
  await page.getByTestId('tab-files').click();
  await expect(page.getByTestId('files-empty')).toBeVisible();
  await page.getByTestId('file-input').setInputFiles({
    name: 'договор.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(FILE_TEXT),
  });
  await expect(page.getByTestId('file-row')).toContainText('договор.txt');
  const stored = storedFiles();
  expect(stored.length).toBeGreaterThanOrEqual(1);
  for (const f of stored) {
    const raw = readFileSync(f);
    expect(raw.includes(Buffer.from(FILE_TEXT))).toBe(false);
    expect(raw.includes(Buffer.from('договор'))).toBe(false);
  }
  expect(await downloadText(page)).toBe(FILE_TEXT);

  // добавление участника
  await page.getByTestId('btn-vault-settings').click();
  await page.getByTestId('member-search').fill('member');
  await page.getByTestId(`add-${MEMBER.email}`).click();
  await expect(page.getByTestId('member-row').filter({ hasText: MEMBER.email })).toContainText(
    /выдан|issued/,
  );

  // участник видит хранилище и запись, читает её
  await memberPage.reload();
  await memberPage.getByTestId('password').fill(MEMBER.password);
  await memberPage.getByTestId('submit').click();
  await expect(memberPage.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  await memberPage.getByTestId('vault-select').selectOption({ label: 'Команда' });
  await expect(memberPage.getByTestId('entry-row')).toHaveCount(1, { timeout: 30_000 });
  await memberPage.getByTestId('entry-row').click();
  await memberPage.getByTestId('btn-reveal').click();
  await expect(memberPage.getByTestId('view-password')).toHaveText('Shared-Secret-77!aa');
  expect(await downloadText(memberPage)).toBe(FILE_TEXT);

  // отзыв доступа и ротация ключа
  await page.getByTestId(`remove-${MEMBER.email}`).click();
  await expect(page.getByTestId('rotation-hint')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('btn-rotate-hint').click();
  await expect(page.getByTestId('settings-notice')).toBeVisible({ timeout: 90_000 });
  await memberPage.reload();
  await memberPage.getByTestId('password').fill(MEMBER.password);
  await memberPage.getByTestId('submit').click();
  await expect(memberPage.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  await expect(
    memberPage.getByTestId('vault-select').locator('option', { hasText: 'Команда' }),
  ).toHaveCount(0);

  // данные после ротации открываются администратором
  await page
    .getByRole('link', { name: /Сейф|Locker/ })
    .first()
    .click();
  await expect(page.getByTestId('entry-row').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('entry-row').first().click();
  // после ротации ключа файл открывается новым ключом и содержимое прежнее
  expect(await downloadText(page)).toBe(FILE_TEXT);
  for (const f of storedFiles())
    expect(readFileSync(f).includes(Buffer.from(FILE_TEXT))).toBe(false);
  void login;
});

test('two-factor sign-in: enrol, sign out, password alone is not enough, code completes', async ({
  browser,
}) => {
  const { totp, parseTotpInput } = await import('../packages/crypto/dist/index.js');
  const page = adminPage;
  await page.locator('a[href="/security"]').first().click();
  await page.getByTestId('mfa-start').click();
  const secret = (await page.getByTestId('mfa-secret').innerText()).trim();
  // предыдущий шаг времени: следующий вход использует текущий, один шаг дважды не принимается
  const prev = await totp(parseTotpInput(secret), Date.now() - 30_000);
  await page.getByTestId('mfa-enable-code').fill(prev);
  await page.getByTestId('mfa-enable').click();
  await expect(page.getByTestId('mfa-backup-codes').locator('li')).toHaveCount(10);
  const backup = (
    await page.getByTestId('mfa-backup-codes').locator('li').first().innerText()
  ).trim();
  await page.getByTestId('mfa-codes-saved').click();
  await expect(page.getByTestId('mfa-state')).toContainText(/10/);

  await page.getByTestId('signout').click();
  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto('/login');
  await fresh.getByTestId('email').fill(ADMIN.email);
  await fresh.getByTestId('password').fill(ADMIN.password);
  await fresh.getByTestId('submit').click();
  await expect(fresh.getByTestId('mfa-code')).toBeVisible({ timeout: 90_000 });
  // без кода вход не завершается
  await expect(fresh.getByTestId('vault-select')).toHaveCount(0);
  await fresh.getByTestId('mfa-code').fill('000000');
  await fresh.getByTestId('submit').click();
  await expect(fresh.getByTestId('error')).toBeVisible();
  await fresh.getByTestId('mfa-code').fill(await totp(parseTotpInput(secret)));
  await fresh.getByTestId('submit').click();
  await expect(fresh.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  // данные доступны после входа с кодом
  await expect(fresh.getByTestId('entry-row').first()).toBeVisible({ timeout: 30_000 });

  // резервный код работает один раз
  await fresh.getByTestId('signout').click();
  const login2 = async (code: string) => {
    await fresh.goto('/login');
    await fresh.getByTestId('email').fill(ADMIN.email);
    await fresh.getByTestId('password').fill(ADMIN.password);
    await fresh.getByTestId('submit').click();
    await fresh.getByTestId('mfa-code').fill(code);
    await fresh.getByTestId('submit').click();
  };
  await login2(backup);
  await expect(fresh.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  await fresh.getByTestId('signout').click();
  await login2(backup);
  await expect(fresh.getByTestId('error')).toBeVisible({ timeout: 90_000 });
});
