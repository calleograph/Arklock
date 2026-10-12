import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error — selenium-webdriver поставляется без типов
import { Builder, By, until } from 'selenium-webdriver';
// @ts-expect-error — то же
import firefox from 'selenium-webdriver/firefox.js';

/**
 * Расширение в настоящем Firefox (geckodriver). Собранное расширение (dist-firefox, с постоянным доступом к 127.0.0.1
 * через EXT_TEST_HOSTS) ставится как временное; окно расширения открывается вкладкой по постоянному адресу moz-extension://.
 * Веб-интерфейс (регистрация, проверка записей, завершение сеансов) ведётся обычным браузером Playwright.
 */
const SERVER = 'http://127.0.0.1:18188';
const SETUP = 'e2e-setup-code-e2e-setup-code-8';
const USER = {
  email: 'ff.user@example.com',
  name: 'Firefox',
  password: 'ff-master-password-e2e-1',
};
const GECKO_ID = 'arklock@example.com';
const UUID = '5b1d6a53-1c2c-4b43-9a4d-4e7a8c0b9f01';
const BASE = `moz-extension://${UUID}`;
const EXT = path.resolve('apps', 'extension', 'dist-firefox');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let driver: any;
let site: http.Server;
let sitePort = 0;
let work: string;
let formHandle = '';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const FORM = `<!doctype html><title>Sign in</title>
<form id="f" action="/done" method="post">
  <input name="username" id="u" type="text" autocomplete="username">
  <input name="password" id="p" type="password" autocomplete="current-password">
  <button type="submit">Go</button>
</form>`;

const css = (id: string) => By.css(`[data-testid="${id}"]`);
const find = (id: string, timeout = 60_000) => driver.wait(until.elementLocated(css(id)), timeout);
const shown = async (id: string, timeout = 60_000) => {
  const e = await find(id, timeout);
  await driver.wait(until.elementIsVisible(e), timeout);
  return e;
};
const type = async (id: string, value: string) => {
  const e = await shown(id);
  await e.clear();
  await e.sendKeys(value);
};
const click = async (id: string) => (await shown(id)).click();
const textOf = async (id: string) => (await shown(id)).getText();
const count = async (id: string) => (await driver.findElements(css(id))).length;
/** Ждёт, пока текст элемента будет удовлетворять условию. */
async function waitText(id: string, re: RegExp, timeout = 60_000): Promise<string> {
  let last = '';
  await driver.wait(async () => {
    const els = await driver.findElements(css(id));
    last = els.length ? await els[0].getText() : '';
    return re.test(last);
  }, timeout);
  return last;
}

test.beforeAll(async () => {
  site = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(FORM);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  sitePort = (site.address() as AddressInfo).port;
  work = mkdtempSync(path.join(tmpdir(), 'arklock-ff-'));
  // архив расширения, как его собирает web-ext (так же устанавливается и в магазин)
  execFileSync('npx', ['web-ext', 'build', '--source-dir', EXT, '--artifacts-dir', work], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: path.resolve('apps', 'extension'),
  });
  const zip = path.join(
    work,
    readdirSync(work).find((f) => f.endsWith('.zip'))!,
  );
  const options = new firefox.Options();
  if (process.env.FIREFOX_HEADED !== '1') options.addArguments('-headless');
  if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
  // постоянный адрес окна расширения для проверок
  options.setPreference('extensions.webextensions.uuids', JSON.stringify({ [GECKO_ID]: UUID }));
  driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
  await driver.installAddon(zip, true);
});

test.afterAll(async () => {
  await driver?.quit().catch(() => undefined);
  site?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

/** Открывает окно расширения вкладкой, привязанной к вкладке с формой. */
async function openPopup(): Promise<void> {
  await driver.switchTo().newWindow('tab');
  await driver.get(
    `${BASE}/popup.html?targetUrl=${encodeURIComponent(`http://127.0.0.1:${sitePort}/login`)}`,
  );
}

async function signInPopup(): Promise<void> {
  await type('server', SERVER);
  await type('email', USER.email);
  await type('password', USER.password);
  await click('submit');
}

async function register(page: Page): Promise<void> {
  await page.goto('/');
  try {
    await page.getByTestId('name').waitFor({ timeout: 4000 });
  } catch {
    await page.getByTestId('to-register').click();
  }
  await page.getByTestId('email').fill(USER.email);
  await page.getByTestId('name').fill(USER.name);
  await page.getByTestId('setup-token').fill(SETUP);
  await page.getByTestId('password').fill(USER.password);
  await page.getByTestId('repeat').fill(USER.password);
  await page.getByTestId('submit').click();
  await page.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await page.getByTestId('recovery-continue').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
}

async function webEntry(page: Page, title: string): Promise<void> {
  await page.getByTestId('search').fill(title);
  await page.getByTestId('entry-row').first().click();
  await expect(page.getByTestId('view-title')).toHaveText(title);
  await page.getByTestId('btn-reveal').click();
}

test('Firefox: sign-in, search, create, fill, TOTP, generator, edit, lock and ended session', async ({
  page,
}) => {
  await register(page);

  // страница с формой входа — отдельная вкладка Firefox
  await driver.get(`http://127.0.0.1:${sitePort}/login`);
  formHandle = await driver.getWindowHandle();
  await openPopup();

  // вход: неверный пароль отклоняется, верный открывает список
  await type('server', SERVER);
  await type('email', USER.email);
  await type('password', 'wrong-master-password-1');
  await click('submit');
  await waitText('error', /Invalid|Неверн/i, 90_000);
  await type('password', USER.password);
  await click('submit');
  await shown('new-entry', 90_000);
  expect(await count('entry')).toBe(0);

  // создание записи для этой страницы: адрес вкладки подставлен
  await click('new-entry');
  await type('f-title', 'Тестовый сайт');
  await type('f-username', 'robot@example.com');
  await type('f-password', 'Ext-Secret-4242!');
  expect(await (await shown('f-url')).getAttribute('value')).toBe(`http://127.0.0.1:${sitePort}`);
  await type('f-totp', 'JBSWY3DPEHPK3PXP');
  await click('f-save');
  await shown('entry');

  // запись для другого сайта
  await click('new-entry');
  await type('f-title', 'Другой сайт');
  await type('f-username', 'someone');
  await type('f-password', 'Other-Secret-1!');
  await type('f-url', 'https://bank.example.org');
  await click('f-save');
  await driver.wait(async () => (await count('entry')) === 2, 30_000);

  // подходящая запись показана первой и помечена
  const first = (await driver.findElements(css('entry')))[0];
  expect(await first.getText()).toContain('Тестовый сайт');
  expect(await first.getText()).toMatch(/this site|этот сайт/);

  // запись видна в веб-интерфейсе: сервер хранит шифртекст, ключи те же
  await webEntry(page, 'Тестовый сайт');
  await expect(page.getByTestId('view-password')).toHaveText('Ext-Secret-4242!');

  // заполнение формы на странице
  await (await first.findElement(css('fill'))).click();
  await waitText('status', /Filled|Заполнено/);
  const popupHandle = await driver.getWindowHandle();
  await driver.switchTo().window(formHandle);
  expect(await (await driver.findElement(By.css('#u'))).getAttribute('value')).toBe(
    'robot@example.com',
  );
  expect(await (await driver.findElement(By.css('#p'))).getAttribute('value')).toBe(
    'Ext-Secret-4242!',
  );
  await driver.switchTo().window(popupHandle);

  // TOTP
  await (await first.findElement(css('totp'))).click();
  await waitText('totp-out', /^\d{6}/);

  // запись для чужого сайта: заполнение требует подтверждения, по отказу поле остаётся пустым
  await driver.switchTo().window(formHandle);
  await driver.executeScript(
    "document.getElementById('u').value=''; document.getElementById('p').value='';",
  );
  await driver.switchTo().window(popupHandle);
  const second = (await driver.findElements(css('entry')))[1];
  await (await second.findElement(css('fill'))).click();
  const alert = await driver.wait(until.alertIsPresent(), 15_000);
  expect(await alert.getText()).toContain('bank.example.org');
  await alert.dismiss();
  await driver.switchTo().window(formHandle);
  expect(await (await driver.findElement(By.css('#p'))).getAttribute('value')).toBe('');
  await driver.switchTo().window(popupHandle);

  // генератор
  await click('generate');
  expect((await textOf('gen-password')).length).toBe(20);

  // изменение записи в расширении
  await driver.navigate().refresh();
  await shown('entry');
  const entries = await driver.findElements(css('entry'));
  await (await entries[0].findElement(css('edit'))).click();
  await type('f-title', 'Изменено в Firefox');
  await type('f-password', 'Changed-FF-88!');
  await click('f-save');
  await driver.wait(async () => (await driver.findElements(css('entry'))).length === 2, 30_000);
  await page.getByTestId('search').fill('');
  await page.reload();
  await page.getByTestId('password').fill(USER.password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  await webEntry(page, 'Изменено в Firefox');
  await expect(page.getByTestId('view-password')).toHaveText('Changed-FF-88!');

  // блокировка: сессия и ключи стираются; новое окно просит пароль
  await click('lock');
  await shown('submit');
  await openPopup();
  await shown('submit');
  expect(await count('entry')).toBe(0);

  // отзыв доступа: пользователь завершает остальные сеансы, расширение теряет доступ
  await type('server', SERVER);
  await type('email', USER.email);
  await type('password', USER.password);
  await click('submit');
  await shown('new-entry', 90_000);
  await page.locator('a[href="/security"]').first().click();
  await page.getByTestId('revoke-others').click();
  await expect(page.getByTestId('sessions').locator('button')).toHaveCount(0, { timeout: 30_000 });
  await click('refresh');
  await waitText('error', /ended by the server|завершён сервером/);
  await openPopup();
  await shown('submit'); // ключи стёрты: снова нужен мастер-пароль
  void signInPopup;
});
