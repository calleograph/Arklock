import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Расширение в настоящем браузере (headed; в CI — под xvfb). Собранное расширение с постоянным доступом к 127.0.0.1
 * (EXT_TEST_HOSTS) загружается в постоянный профиль; вход, поиск, заполнение формы и блокировка проверяются на странице.
 */
const SERVER = 'http://127.0.0.1:18185';
const SETUP = 'e2e-setup-code-e2e-setup-code-5';
const USER = { email: 'ext.user@example.com', name: 'Ext', password: 'ext-master-password-e2e-1' };
const EXT = path.resolve('apps', 'extension', 'dist');

let context: BrowserContext;
let profile: string;
let site: http.Server;
let sitePort = 0;

test.describe.configure({ mode: 'serial' });

const FORM = `<!doctype html><title>Sign in</title>
<form id="f" action="/done" method="post">
  <input name="username" id="u" type="text" autocomplete="username">
  <input name="password" id="p" type="password" autocomplete="current-password">
  <button type="submit">Go</button>
</form>`;

test.beforeAll(async () => {
  site = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(FORM);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  sitePort = (site.address() as AddressInfo).port;
  profile = mkdtempSync(path.join(tmpdir(), 'arklock-ext-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: process.env.E2E_CHANNEL || 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
});

test.afterAll(async () => {
  await context?.close();
  site?.close();
  rmSync(profile, { recursive: true, force: true });
});

async function extensionId(): Promise<string> {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  return new URL(sw.url()).host;
}

async function tabId(url: string): Promise<number> {
  const [sw] = context.serviceWorkers();
  const tabs = (await sw!.evaluate(() => chrome.tabs.query({}))) as { id: number; url?: string }[];
  const t = tabs.find((x) => x.url === url);
  if (!t) throw new Error(`no tab for ${url}`);
  return t.id;
}

async function popupFor(page: Page): Promise<Page> {
  const id = await extensionId();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html?target=${await tabId(page.url())}`);
  return popup;
}

test('the extension signs in, finds the entry for the page and fills the form; a foreign site is not filled silently', async () => {
  // 1. Запись создаётся в веб-интерфейсе
  const web = await context.newPage();
  await web.goto(`${SERVER}/`);
  try {
    await web.getByTestId('name').waitFor({ timeout: 4000 });
  } catch {
    await web.getByTestId('to-register').click();
  }
  await web.getByTestId('email').fill(USER.email);
  await web.getByTestId('name').fill(USER.name);
  await web.getByTestId('setup-token').fill(SETUP);
  await web.getByTestId('password').fill(USER.password);
  await web.getByTestId('repeat').fill(USER.password);
  await web.getByTestId('submit').click();
  await web.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await web.getByTestId('recovery-continue').click();
  await expect(web.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
  await web.getByTestId('add-entry').click();
  await web.getByTestId('f-title').fill('Тестовый сайт');
  await web.getByTestId('f-username').fill('robot@example.com');
  await web.getByTestId('f-password').fill('Ext-Secret-4242!');
  await web.getByTestId('f-url').fill(`http://127.0.0.1:${sitePort}/login`);
  await web.getByTestId('f-totp').fill('JBSWY3DPEHPK3PXP');
  await web.getByTestId('f-save').click();
  await expect(web.getByTestId('view-title')).toHaveText('Тестовый сайт');
  await web.getByTestId('add-entry').click();
  await web.getByTestId('f-title').fill('Другой сайт');
  await web.getByTestId('f-username').fill('someone');
  await web.getByTestId('f-password').fill('Other-Secret-1!');
  await web.getByTestId('f-url').fill('https://bank.example.org');
  await web.getByTestId('f-save').click();
  await expect(web.getByTestId('view-title')).toHaveText('Другой сайт');

  // 2. Страница с формой входа
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${sitePort}/login`);

  // 3. Всплывающее окно: вход мастер-паролем
  const popup = await popupFor(page);
  await popup.getByTestId('server').fill(SERVER);
  await popup.getByTestId('email').fill(USER.email);
  await popup.getByTestId('password').fill('wrong-master-password-1');
  await popup.getByTestId('submit').click();
  await expect(popup.getByTestId('error')).toContainText(/Invalid|Неверн/i, {
    timeout: 90_000,
  });
  await popup.getByTestId('password').fill(USER.password);
  await popup.getByTestId('submit').click();
  await expect(popup.getByTestId('entry').first()).toBeVisible({ timeout: 90_000 });

  // для этой страницы показана только подходящая запись
  await expect(popup.getByTestId('entry')).toHaveCount(2); // записей мало: показываются все, подходящая — первой
  await expect(popup.getByTestId('entry').first()).toContainText('Тестовый сайт');
  await expect(popup.getByTestId('entry').first()).toContainText(/this site|этот сайт/);
  // сессия лежит в памяти браузера, а не на диске: проверяем, что в локальном хранилище нет секретов
  const [sw] = context.serviceWorkers();
  const local = JSON.stringify(await sw!.evaluate(() => chrome.storage.local.get(null)));
  expect(local).not.toContain(USER.password);
  expect(local).not.toContain('Ext-Secret-4242!');
  expect(local).not.toContain('aks_');

  // 4. Заполнение
  await popup.getByTestId('entry').first().getByTestId('fill').click();
  await expect(popup.getByTestId('status')).toContainText(/Filled|Заполнено/);
  await expect(page.locator('#u')).toHaveValue('robot@example.com');
  await expect(page.locator('#p')).toHaveValue('Ext-Secret-4242!');

  // TOTP
  await popup.getByTestId('entry').first().getByTestId('totp').click();
  await expect(popup.getByTestId('totp-out')).toContainText(/^\d{6}/);

  // 4б. Вкладка ушла на другой источник после открытия окна (перенаправление): пароль не заполняется
  const other = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(FORM);
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  try {
    await page.goto(`http://127.0.0.1:${(other.address() as AddressInfo).port}/login`);
    await popup.getByTestId('entry').first().getByTestId('fill').click();
    await expect(popup.getByTestId('status')).toContainText(/changed|сменилась/);
    await expect(page.locator('#p')).toHaveValue('');
  } finally {
    other.close();
  }
  await page.goto(`http://127.0.0.1:${sitePort}/login`);

  // 5. Запись для другого сайта: заполнение требует подтверждения и по отказу не выполняется
  await page.locator('#u').fill('');
  await page.locator('#p').fill('');
  let asked = '';
  popup.on('dialog', async (d) => {
    asked = d.message();
    await d.dismiss();
  });
  await popup.getByTestId('entry').nth(1).getByTestId('fill').click();
  await expect.poll(() => asked).toContain('bank.example.org');
  await expect(page.locator('#p')).toHaveValue('');

  // 6. Генератор
  await popup.getByTestId('generate').click();
  expect(await popup.getByTestId('gen-password').innerText()).toHaveLength(20);

  // 7. Повторное открытие окна без повторного ввода пароля, затем блокировка
  const again = await popupFor(page);
  await expect(again.getByTestId('entry').first()).toBeVisible({ timeout: 30_000 });
  await again.getByTestId('lock').click();
  await expect(again.getByTestId('submit')).toBeVisible();
  const afterLock = JSON.stringify(await sw!.evaluate(() => chrome.storage.session.get(null)));
  expect(afterLock).toBe('{}');
  const third = await popupFor(page);
  await expect(third.getByTestId('submit')).toBeVisible();
});

/** Вход в окно расширения мастер-паролем. */
async function signIn(popup: Page): Promise<void> {
  await popup.getByTestId('server').fill(SERVER);
  await popup.getByTestId('email').fill(USER.email);
  await popup.getByTestId('password').fill(USER.password);
  await popup.getByTestId('submit').click();
  await expect(popup.getByTestId('entry').first()).toBeVisible({ timeout: 90_000 });
}

/** Входит в веб-интерфейс новой вкладкой (токен хранится во вкладке) и находит запись по названию. */
async function webEntry(title: string): Promise<Page> {
  const web = await context.newPage();
  await web.goto(`${SERVER}/login`);
  // новая вкладка получает сеанс от уже открытой вкладки того же браузера; если такой нет — обычный вход
  await expect(web.getByTestId('vault-select').or(web.getByTestId('email'))).toBeVisible({
    timeout: 30_000,
  });
  if (await web.getByTestId('email').isVisible()) {
    await web.getByTestId('email').fill(USER.email);
    await web.getByTestId('password').fill(USER.password);
    await web.getByTestId('submit').click();
  }
  await expect(web.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  await web.getByTestId('search').fill(title);
  await web.getByTestId('entry-row').first().click();
  await expect(web.getByTestId('view-title')).toHaveText(title);
  return web;
}

test('entries are created and edited from the extension, readable in the web app; ending the session locks the extension', async () => {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${sitePort}/login`);
  const popup = await popupFor(page);
  await signIn(popup);

  // создание: адрес предзаполняется адресом вкладки, пароль можно сгенерировать
  await popup.getByTestId('new-entry').click();
  await popup.getByTestId('f-title').fill('Создано в расширении');
  await popup.getByTestId('f-username').fill('ext-created');
  await popup.getByTestId('f-generate').click();
  const generated = await popup.getByTestId('f-password').inputValue();
  expect(generated).toHaveLength(20);
  await expect(popup.getByTestId('f-url')).toHaveValue(`http://127.0.0.1:${sitePort}`);
  await popup.getByTestId('f-totp').fill('not a valid secret !!');
  await popup.getByTestId('f-save').click();
  await expect(popup.getByTestId('f-error')).not.toBeEmpty(); // неверный секрет TOTP отклоняется до отправки
  await popup.getByTestId('f-totp').fill('JBSWY3DPEHPK3PXP');
  await popup.getByTestId('f-save').click();
  await popup.getByTestId('search').fill('Создано');
  await expect(popup.getByTestId('entry')).toHaveCount(1);
  await expect(popup.getByTestId('entry')).toContainText('ext-created');

  // запись читается в веб-интерфейсе: сервер хранит только шифртекст, ключи те же
  let web = await webEntry('Создано в расширении');
  await web.getByTestId('btn-reveal').click();
  await expect(web.getByTestId('view-password')).toHaveText(generated);
  await web.close();

  // изменение: пароль и название; поля, которых нет в форме, сохраняются
  await popup.getByTestId('entry').first().getByTestId('edit').click();
  await expect(popup.getByTestId('f-title')).toHaveValue('Создано в расширении');
  await popup.getByTestId('f-title').fill('Изменено в расширении');
  await popup.getByTestId('f-password').fill('Changed-By-Ext-77!');
  await popup.getByTestId('f-save').click();
  await popup.getByTestId('search').fill('Изменено');
  await expect(popup.getByTestId('entry')).toHaveCount(1);
  web = await webEntry('Изменено в расширении');
  await web.getByTestId('btn-reveal').click();
  await expect(web.getByTestId('view-password')).toHaveText('Changed-By-Ext-77!');

  // отзыв доступа: пользователь завершает остальные сеансы — расширение теряет доступ и стирает ключи
  await await web.getByTestId('menu-toggle').click();
  await web.getByTestId('menu-security').click();
  await web.getByTestId('revoke-others').click();
  await expect(web.getByTestId('sessions').locator('button')).toHaveCount(0, { timeout: 30_000 });
  await popup.getByTestId('refresh').click();
  await expect(popup.getByTestId('submit')).toBeVisible({ timeout: 30_000 });
  await expect(popup.getByTestId('error')).toContainText(/ended by the server|завершён сервером/);
  const [sw] = context.serviceWorkers();
  expect(JSON.stringify(await sw!.evaluate(() => chrome.storage.session.get(null)))).toBe('{}');
  await web.close();
});
