import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
// @ts-expect-error — selenium-webdriver поставляется без типов
import { Builder, By, until } from 'selenium-webdriver';
// @ts-expect-error — то же
import firefox from 'selenium-webdriver/firefox.js';

/**
 * Расширение в настоящем Firefox (geckodriver). Проверяется то, что доступно автоматизации:
 *   • собранное расширение (dist-firefox, проверочная сборка) принимается Firefox как временное дополнение: манифест,
 *     страница событий, разрешения — состояние читается из менеджера дополнений браузера;
 *   • окно расширения запускается движком Firefox и показывает форму входа; переключение способов входа работает.
 * Сценарии с вкладками, заполнением форм и сервером (вход, поиск, создание, изменение, TOTP, блокировка, отзыв доступа)
 * в Firefox автоматизировать нельзя: WebDriver не управляет страницами moz-extension верхнего уровня («privileged scope»),
 * а во фрейме обычной страницы у окна расширения нет API tabs, scripting и permissions. Эти же сценарии выполняются
 * на том же коде в Chromium (extension.spec.ts); для Firefox действует ручной перечень проверок из docs/EXTENSION.md.
 */
const GECKO_ID = 'arklock@example.com';
const UUID = '5b1d6a53-1c2c-4b43-9a4d-4e7a8c0b9f01';
const EXT = path.resolve('apps', 'extension', 'dist-firefox');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let driver: any;
let site: http.Server;
let sitePort = 0;
let work: string;
let base = `moz-extension://${UUID}`;

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test.beforeAll(async () => {
  site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      req.url?.startsWith('/frame')
        ? `<!doctype html><title>Arklock</title><iframe id="x" style="width:380px;height:760px;border:0" src="${base}/popup.html"></iframe>`
        : '<!doctype html><title>blank</title>',
    );
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
  options.setPreference('extensions.webextensions.uuids', JSON.stringify({ [GECKO_ID]: UUID }));
  // доступ к системным настройкам нужен для чтения состояния дополнения из менеджера дополнений
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
  driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();
  await driver.installAddon(zip, true);
});

test.afterAll(async () => {
  await driver?.quit().catch(() => undefined);
  site?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

const css = (id: string) => By.css(`[data-testid="${id}"]`);

test('Firefox accepts the extension: manifest, event page, permissions and install state', async () => {
  await driver.setContext(firefox.Context.CHROME);
  const state = await driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
     AddonManager.getAddonByID(arguments[0]).then((a) => done(a ? {
       active: a.isActive, name: a.name, version: a.version, type: a.type,
       permissions: a.permissions ? Array.from(a.permissions.permissions ?? []) : [],
       hasProblems: !!(a.appDisabled || a.userDisabled || a.blocklistState),
     } : null));`,
    GECKO_ID,
  );
  const uuids = JSON.parse(
    await driver.executeScript(
      "return Services.prefs.getStringPref('extensions.webextensions.uuids', '{}')",
    ),
  ) as Record<string, string>;
  await driver.setContext(firefox.Context.CONTENT);
  base = `moz-extension://${uuids[GECKO_ID] ?? UUID}`;
  expect(state, 'дополнение не найдено в менеджере дополнений').not.toBeNull();
  expect(state).toMatchObject({
    active: true,
    name: 'Arklock',
    type: 'extension',
    hasProblems: false,
  });
  expect(state.permissions).toEqual(
    expect.arrayContaining(['activeTab', 'scripting', 'storage', 'alarms', 'clipboardWrite']),
  );
});

test('the extension window runs in Firefox: sign-in form, switching to the token mode', async () => {
  await driver.get(`http://127.0.0.1:${sitePort}/frame`);
  const frame = await driver.wait(until.elementLocated(By.css('#x')), 30_000);
  await driver.switchTo().frame(frame);
  const server = await driver.wait(until.elementLocated(css('server')), 30_000);
  await driver.wait(until.elementIsVisible(server), 10_000);
  for (const id of ['email', 'password', 'submit']) {
    expect(await driver.findElements(css(id)), id).toHaveLength(1);
  }
  // способ входа переключается на токен API, и поле пароля остаётся
  await (await driver.findElement(css('switch'))).click();
  await driver.wait(until.elementLocated(css('token')), 10_000);
  expect(await driver.findElements(css('password'))).toHaveLength(1);
});
