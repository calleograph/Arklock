import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { X509Certificate } from 'node:crypto';
import { fakeSmtp, makePki } from '../apps/api/test/smtp-fake.js';
import { makeChain } from '../apps/api/test/pki.js';

const SETUP = 'e2e-setup-code-e2e-setup-code-u1';
const CHIEF = {
  email: 'ui.chief@example.com',
  name: 'Главный',
  password: 'ui-chief-master-password-1',
};
const MEMBER = {
  email: 'ui.member@example.com',
  name: 'Сотрудник',
  password: 'ui-member-master-password-2',
};

test.describe.configure({ mode: 'serial' });

/** Разделы администрирования берутся из маршрута: новый раздел без проверки навигации не пройдёт этот тест. */
const ADMIN_TABS = (() => {
  const src = readFileSync('apps/web/src/router.ts', 'utf8');
  const m = /path: '\/admin\/:tab\(([^)]+)\)\?'/.exec(src);
  if (!m) throw new Error('маршрут администрирования не найден');
  return m[1]!.split('|');
})();

async function register(page: Page, u: typeof CHIEF, setup?: string): Promise<void> {
  await page.goto('/');
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
  await expect(page.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
}
const expandAll = (page: Page) => page.getByTestId('admin-nav-expand-all').click();
const tokenOf = (page: Page) => page.evaluate(() => sessionStorage.getItem('arklock.token'));

let chief: Page;
let member: Page;
let browser: Browser;
const external: string[] = [];

test.beforeAll(async ({ browser: b, baseURL }) => {
  browser = b;
  chief = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
  // приложение не должно ходить за шрифтами и ресурсами наружу
  chief.on('request', (r) => {
    if (
      !r.url().startsWith(baseURL!) &&
      !r.url().startsWith('data:') &&
      !r.url().startsWith('blob:')
    )
      external.push(r.url());
  });
  await register(chief, CHIEF, SETUP);
  const token = await tokenOf(chief);
  const put = await chief.request.put('/api/v1/admin/settings', {
    headers: { authorization: `Bearer ${token}` },
    data: { 'registration.mode': 'open' },
  });
  expect(put.status()).toBe(200);
  member = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
  await register(member, MEMBER);
});

test('an ordinary employee has no import/export and the server refuses it', async () => {
  await member.getByTestId('menu-toggle').click();
  await expect(member.getByTestId('menu-transfer')).toHaveCount(0);
  await expect(member.getByTestId('menu-full')).toHaveCount(0);
  await member.keyboard.press('Escape');
  await member.goto('/admin/transfer');
  await expect(member).not.toHaveURL(/admin/);
  await member.goto('/transfer');
  await expect(member).not.toHaveURL(/transfer/);
  const token = await tokenOf(member);
  for (const body of [
    { action: 'export', phase: 'begin' },
    { action: 'import', phase: 'begin' },
  ]) {
    const r = await member.request.post('/api/v1/audit/event', {
      headers: { authorization: `Bearer ${token}` },
      data: body,
    });
    expect(r.status()).toBe(403);
  }
});

test('the chief administrator opens import and export inside the admin layout', async () => {
  await chief.getByTestId('menu-toggle').click();
  await expect(chief.getByTestId('menu-transfer')).toHaveCount(0);
  await chief.getByTestId('menu-full').click();
  await chief.getByTestId('admin-tab-transfer').click();
  await expect(chief.getByTestId('transfer-page')).toBeVisible();
  await expect(chief.getByTestId('admin-nav')).toBeVisible();
  await expect(chief.getByTestId('admin-tab-transfer')).toHaveAttribute('aria-current', 'page');
  // старая ссылка ведёт в администрирование, F5 оставляет страницу и меню
  await chief.reload();
  await expect(chief.getByTestId('transfer-page')).toBeVisible();
  await expect(chief.getByTestId('admin-nav')).toBeVisible();
  await chief.goBack();
  await expect(chief.getByTestId('admin-nav')).toBeVisible();
});

test('the admin menu stays on every administrative route', async () => {
  const missing: string[] = [];
  for (const tab of ADMIN_TABS) {
    await chief.goto(`/admin/${tab}`);
    await chief.waitForLoadState('networkidle');
    if (!(await chief.getByTestId('admin-nav').isVisible())) missing.push(tab);
    if (!(await chief.getByTestId('admin-group-toggle-overview').isVisible()))
      missing.push(`${tab}: группы`);
  }
  expect(missing, missing.join(', ')).toEqual([]);
  // переходы кликами по пунктам тоже не убирают меню
  await chief.goto('/admin/overview');
  await expandAll(chief);
  const ids = await chief
    .locator('[data-testid^="admin-tab-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!));
  expect(ids.length).toBeGreaterThan(20);
  for (const id of ids) {
    await chief.getByTestId(id).click();
    await expect(chief.getByTestId('admin-nav')).toBeVisible();
    await expect(chief.getByTestId(id)).toHaveAttribute('aria-current', 'page');
  }
});

test('groups collapse to titles only; collapse-all / expand-all; the state survives F5', async () => {
  await chief.goto('/admin/users');
  await expandAll(chief);
  const items = chief.locator('[data-testid^="admin-tab-"]');
  const all = await items.count();
  expect(all).toBeGreaterThan(20);
  const width = (await chief.getByTestId('admin-nav').boundingBox())!.width;
  // одна группа: пропадают только её подпункты
  await chief.getByTestId('admin-group-toggle-integrations').click();
  await expect(chief.getByTestId('admin-tab-ldap')).toBeHidden();
  await expect(chief.getByTestId('admin-group-toggle-integrations')).toBeVisible();
  await expect(chief.getByTestId('admin-tab-users')).toBeVisible();
  // свернуть всё: остаются названия групп, пунктов нет, ширина меню прежняя
  await chief.getByTestId('admin-nav-collapse-all').click();
  await expect(chief.locator('[data-testid^="admin-tab-"]:visible')).toHaveCount(0);
  const groups = chief.locator('[data-testid^="admin-group-toggle-"]');
  expect(await groups.count()).toBeGreaterThanOrEqual(7);
  for (const g of await groups.all()) await expect(g).toBeVisible();
  expect((await chief.getByTestId('admin-nav').boundingBox())!.width).toBeCloseTo(width, 0);
  await chief.screenshot({ path: 'docs/screenshots/ui-admin-collapsed.png' });
  // F5: свёрнутое состояние и страница сохраняются
  await chief.reload();
  await expect(chief.getByTestId('admin-nav-collapse-all')).toBeVisible();
  await expect(chief.locator('[data-testid^="admin-tab-"]:visible')).toHaveCount(0);
  // после F5 свёрнутая группа текущей страницы только подсвечена
  await expect(chief.getByTestId('admin-group-toggle-people')).toHaveAttribute(
    'data-group-active',
    'true',
  );
  // переход на другую страницу («Назад») раскрывает её группу и подсвечивает пункт
  await expandAll(chief);
  await chief.getByTestId('admin-tab-syslog').click();
  await chief.getByTestId('admin-nav-collapse-all').click();
  await chief.goBack();
  await expect(chief.getByTestId('admin-tab-users')).toBeVisible();
  await expect(chief.getByTestId('admin-tab-users')).toHaveAttribute('aria-current', 'page');
  // развернуть всё
  await expandAll(chief);
  await expect(chief.locator('[data-testid^="admin-tab-"]:visible')).toHaveCount(all);
  await chief.screenshot({ path: 'docs/screenshots/ui-admin-expanded.png' });
});

test('the daily workspace uses one control height and a calm layout', async () => {
  await chief.setViewportSize({ width: 1366, height: 768 });
  await chief.goto('/');
  await expect(chief.getByTestId('add-entry')).toBeVisible({ timeout: 60_000 });
  for (const title of ['Почта', 'VPN', 'Бухгалтерия — банк']) {
    await chief.getByTestId('add-entry').click();
    await chief.getByTestId('f-title').fill(title);
    await chief.getByTestId('f-username').fill('user');
    await chief.getByTestId('f-password').fill('Zq8!vN3#xLp0wRt5');
    await chief.getByTestId('f-save').click();
    await expect(chief.getByTestId('view-title')).toHaveText(title);
  }
  await chief.screenshot({ path: 'docs/screenshots/ui-workspace-chief.png' });
  const heights = await chief.evaluate(() =>
    [...document.querySelectorAll('.btn, .btn-primary, .btn-danger, select.input, input.input')]
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => ({
        cls: (e as HTMLElement).className.split(' ')[0],
        h: Math.round(e.getBoundingClientRect().height),
        txt: (e.textContent || (e as HTMLInputElement).placeholder || '').trim().slice(0, 20),
      })),
  );
  expect(heights.length).toBeGreaterThan(3);
  const bad = heights.filter((x) => x.h !== 36);
  expect(bad, JSON.stringify(bad)).toEqual([]);
});

test('one type scale, one control height, local fonts, no external requests', async () => {
  for (const url of ['/admin/users', '/admin/transfer', '/']) {
    await chief.goto(url);
    await chief.waitForLoadState('networkidle');
    const m = await chief.evaluate(() => {
      const px = (el: Element, k: 'fontSize' | 'height' | 'borderRadius') =>
        parseFloat(getComputedStyle(el)[k]);
      const input = document.querySelector('input.input, select.input');
      const btn = document.querySelector('.btn, .btn-primary');
      return {
        body: px(document.body, 'fontSize'),
        h1: document.querySelector('h1') ? px(document.querySelector('h1')!, 'fontSize') : 18,
        input: input ? px(input, 'height') : null,
        btn: btn ? px(btn, 'height') : null,
        inputRadius: input ? px(input, 'borderRadius') : 6,
        btnRadius: btn ? px(btn, 'borderRadius') : 6,
        sizes: [
          ...new Set(
            [...document.querySelectorAll('body *')]
              .filter(
                (e) =>
                  e.childNodes.length &&
                  [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()),
              )
              .map((e) => getComputedStyle(e).fontSize),
          ),
        ],
        family: getComputedStyle(document.body).fontFamily,
      };
    });
    expect(m.body, url).toBe(14);
    expect(m.h1, url).toBe(18);
    if (m.input && m.btn) expect(Math.abs(m.input - m.btn), url).toBeLessThanOrEqual(1);
    expect(m.inputRadius).toBe(6);
    expect(m.btnRadius).toBe(6);
    expect(m.family).toContain('Onest');
    // в тексте только 12, 14 и 18 px (плюс крупные показатели 24 px и заставка входа)
    const odd = m.sizes.filter((s) => !['12px', '14px', '18px', '24px'].includes(s));
    expect(odd, `${url}: ${odd.join(' ')}`).toEqual([]);
  }
  const fonts = await chief.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
  });
  expect(fonts.join(' ')).toContain('Onest');
  expect(external, external.join('\n')).toEqual([]);
});

test('hints are not clipped by their containers', async () => {
  await chief.setViewportSize({ width: 1366, height: 768 });
  const clipped: string[] = [];
  let seen = 0;
  for (const url of [
    '/admin/settings?section=security',
    '/admin/settings?section=network',
    '/admin/users',
    '/admin/transfer?tab=export',
    '/admin/overview',
    '/admin/smtp',
  ]) {
    await chief.goto(url);
    await chief.waitForLoadState('networkidle');
    const hints = chief.getByTestId('info-hint');
    const n = Math.min(await hints.count(), 8);
    for (let i = 0; i < n; i++) {
      const hint = hints.nth(i);
      if (!(await hint.isVisible())) continue;
      await hint.scrollIntoViewIfNeeded();
      await hint.hover();
      const ok = await chief.evaluate(() => {
        const trigger = document.querySelector('[data-testid="info-hint"][aria-describedby]');
        const tip = trigger && document.getElementById(trigger.getAttribute('aria-describedby')!);
        if (!tip) return null;
        const r = tip.getBoundingClientRect();
        const probes = [
          [r.left + 8, r.top + 8],
          [r.right - 8, r.top + 8],
          [r.left + 8, r.bottom - 8],
          [r.right - 8, r.bottom - 8],
        ];
        const inView =
          r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
        const covered = probes.filter(([x, y]) => !tip.contains(document.elementFromPoint(x!, y!)));
        return inView && !covered.length
          ? true
          : JSON.stringify({
              inView,
              covered: covered.length,
              r: [r.left, r.top, r.right, r.bottom].map(Math.round),
              by:
                covered[0] && document.elementFromPoint(covered[0][0]!, covered[0][1]!)?.className,
            });
      });
      if (ok === null) continue;
      seen++;
      if (ok !== true) clipped.push(`${url} #${i} ${String(ok)}`);
      await chief.mouse.move(0, 0);
    }
  }
  expect(seen).toBeGreaterThan(3);
  expect(clipped, clipped.join('\n')).toEqual([]);
});

test('laptop sizes and all four themes keep the admin layout usable', async () => {
  const themes = ['glass', 'night', 'grove', 'aurora'];
  for (const [w, h] of [
    [1280, 800],
    [1366, 768],
    [1440, 900],
    [1512, 982],
    [1920, 1080],
    [1093, 614], // 1366×768 при масштабе 125 %
    [911, 512], // 1366×768 при масштабе 150 %
    [390, 844],
  ] as const) {
    await chief.setViewportSize({ width: w, height: h });
    for (const url of ['/admin/users', '/admin/transfer', '/admin/updates', '/']) {
      await chief.goto(url);
      await chief.waitForLoadState('networkidle');
      const over = await chief.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(over, `${w}×${h} ${url}`).toBeLessThanOrEqual(0);
      if (url.startsWith('/admin')) await expect(chief.getByTestId('admin-nav')).toBeVisible();
    }
    if (w === 1280) await chief.screenshot({ path: 'docs/screenshots/ui-1280.png' });
  }
  await chief.setViewportSize({ width: 1366, height: 768 });
  for (const theme of themes) {
    await chief.goto('/admin/transfer');
    await chief.evaluate((id) => {
      document.documentElement.dataset.theme = id;
      document.documentElement.classList.toggle('dark', ['night', 'aurora'].includes(id));
    }, theme);
    await expect(chief.getByTestId('admin-nav')).toBeVisible();
    await expect(chief.getByTestId('transfer-page')).toBeVisible();
  }
});

test('each employee picks a theme that applies at once, survives F5 and a new sign-in', async ({
  baseURL,
}) => {
  const themeOf = (p: Page) => p.evaluate(() => document.documentElement.dataset.theme);
  const pick = async (p: Page, id: string) => {
    await p.goto('/settings');
    await p.getByTestId(`theme-${id}`).click();
    expect(await themeOf(p)).toBe(id);
    await expect(p.getByTestId(`theme-${id}`)).toHaveAttribute('aria-checked', 'true');
  };
  await pick(chief, 'night');
  await pick(member, 'grove');
  for (const [page, id] of [
    [chief, 'night'],
    [member, 'grove'],
  ] as const) {
    await page.reload();
    expect(await themeOf(page)).toBe(id);
  }
  // новый вход с «другого устройства» получает сохранённую тему
  const device = await (
    await browser.newContext({ viewport: { width: 1366, height: 768 } })
  ).newPage();
  await device.goto(baseURL!);
  await device.getByTestId('email').fill(MEMBER.email);
  await device.getByTestId('password').fill(MEMBER.password);
  await device.getByTestId('submit').click();
  await expect(device.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  expect(await themeOf(device)).toBe('grove');
  // тёмная тема не оставляет светлых страниц в разделах администрирования
  await chief.goto('/admin/users');
  expect(
    await chief.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
  ).toBe('rgb(14, 16, 36)');
  for (const tab of ['users', 'updates', 'transfer', 'settings']) {
    await chief.goto(`/admin/${tab}`);
    await expect(chief.getByTestId('admin-nav')).toBeVisible();
    const over = await chief.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over, tab).toBeLessThanOrEqual(0);
  }
  expect(external).toEqual([]);
});

test('«Что нового»: сообщение после обновления показывается один раз и помнится на сервере', async ({
  baseURL,
}) => {
  // у нового сотрудника сообщения нет: примечания о прошлых версиях ему не нужны
  await member.goto('/');
  await expect(member.getByTestId('vault-select')).toBeVisible();
  await expect(member.getByTestId('updated-banner')).toHaveCount(0);
  // имитируем сотрудника, который последний раз читал примечания давно
  const token = await tokenOf(member);
  const put = await member.request.put('/api/v1/auth/preferences', {
    headers: { authorization: `Bearer ${token}` },
    data: { seenRelease: '1.70.0' },
  });
  expect(put.status()).toBe(204);
  await member.reload();
  await expect(member.getByTestId('updated-banner')).toBeVisible();
  await member.getByTestId('banner-open').click();
  const dialog = member.getByTestId('whatsnew-dialog');
  await expect(dialog).toBeVisible();
  // сводка пропущенных версий: несколько выпусков, а не один
  expect(await dialog.locator('[data-testid^="release-"]').count()).toBeGreaterThan(3);
  await expect(dialog.getByTestId('whatsnew-full')).toHaveAttribute('href', /releases\/tag\/v/);
  await member.getByTestId('whatsnew-close').click();
  await expect(member.getByTestId('updated-banner')).toHaveCount(0);
  // после F5 и на другом устройстве сообщение не повторяется
  await member.reload();
  await expect(member.getByTestId('vault-select')).toBeVisible();
  await expect(member.getByTestId('updated-banner')).toHaveCount(0);
  const device = await (
    await browser.newContext({ viewport: { width: 1366, height: 768 } })
  ).newPage();
  await device.goto(baseURL!);
  await device.getByTestId('email').fill(MEMBER.email);
  await device.getByTestId('password').fill(MEMBER.password);
  await device.getByTestId('submit').click();
  await expect(device.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  await expect(device.getByTestId('updated-banner')).toHaveCount(0);
  // кнопка в меню открывает окно текущей версии и без сообщения
  await device.getByTestId('menu-toggle').click();
  await device.getByTestId('menu-whatsnew').click();
  await expect(device.getByTestId('whatsnew-dialog')).toBeVisible();
  await expect(device.getByTestId('whatsnew-dialog')).toContainText(
    `Arklock ${readFileSync('VERSION', 'utf8').trim()}`,
  );
  await device.screenshot({ path: 'docs/screenshots/whatsnew.png' });
  // администратору видно то же в разделе «Обновления»
  await chief.goto('/admin/updates');
  await expect(chief.getByTestId('updates-whatsnew')).toBeVisible();
  await expect(chief.getByTestId('last-install')).toBeVisible();
  expect(external).toEqual([]);
});

test('«Защита веб-приложения»: вкладки внутри административного меню, правило, блокировка и события', async () => {
  await chief.setViewportSize({ width: 1366, height: 768 });
  await chief.goto('/admin/shield');
  await expect(chief.getByTestId('shield-panel')).toBeVisible();
  await expect(chief.getByTestId('admin-nav')).toBeVisible();
  await expect(chief.getByTestId('shield-overview')).toBeVisible();
  await expect(chief.getByTestId('ov-failed')).toBeVisible();
  // вкладки меняются, левое меню остаётся
  for (const id of ['login', 'ips', 'blocks', 'requests', 'events', 'advanced']) {
    await chief.getByTestId(`shield-tab-${id}`).click();
    await expect(chief.getByTestId(`shield-${id}`)).toBeVisible();
    await expect(chief.getByTestId('admin-nav')).toBeVisible();
  }
  const over = await chief.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);

  // правило подсети: изменение защиты просит пароль
  await chief.getByTestId('shield-tab-ips').click();
  await expect(chief.getByTestId('your-ip')).toBeVisible();
  await chief.getByTestId('rule-cidr').fill('192.0.2.0/24');
  await chief.getByTestId('rule-add').click();
  await chief.getByTestId('shield-password').fill(CHIEF.password);
  await chief.getByTestId('shield-reauth-ok').click();
  await expect(chief.getByTestId('rule-192.0.2.0/24')).toBeVisible();
  // включение в режиме подтверждения (консоль сервера — 127.0.0.1 — разрешена всегда, поэтому тест не отрезает себя)
  await chief.getByTestId('access-enable').click();
  await chief.getByTestId('access-ack').check();
  await chief.getByTestId('access-start').click();
  await expect(chief.getByTestId('access-pending')).toBeVisible();
  await chief.getByTestId('access-confirm').click();
  await expect(chief.getByTestId('access-pending')).toHaveCount(0);
  await expect(chief.getByTestId('access-state')).toHaveAttribute('data-enabled', 'true');
  await chief.getByTestId('access-disable').click();
  await expect(chief.getByTestId('access-state')).toHaveAttribute('data-enabled', 'false');

  // ручная блокировка и снятие
  await chief.getByTestId('shield-tab-blocks').click();
  await chief.getByTestId('block-ip').fill('192.0.2.99');
  await chief.getByTestId('block-reason').fill('Проверка блокировки');
  await chief.getByTestId('block-add').click();
  await expect(chief.getByTestId('block-192.0.2.99')).toBeVisible();
  chief.once('dialog', (d) => void d.accept());
  await chief.getByTestId('block-192.0.2.99').getByTestId('block-release').click();
  await expect(chief.getByTestId('block-192.0.2.99')).toHaveCount(0);

  // события: изменения защиты записаны, фильтр по уровню работает
  await chief.getByTestId('shield-tab-events').click();
  await chief.getByTestId('ev-period').selectOption('all');
  await chief.getByTestId('ev-apply').click();
  await expect(chief.getByTestId('ev-table')).toContainText(/Изменена защита|Protection changed/);
  await chief.screenshot({ path: 'docs/screenshots/shield-events.png' });
  await chief.getByTestId('shield-tab-overview').click();
  await chief.screenshot({ path: 'docs/screenshots/shield-overview.png' });
  // обычному сотруднику раздел недоступен
  await member.goto('/admin/shield');
  await expect(member).not.toHaveURL(/admin/);
});

test('после нескольких ошибок вход требует проверку, решает её в браузере и пускает владельца', async ({
  baseURL,
}) => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  await page.goto(baseURL!);
  for (let i = 0; i < 6; i++) {
    await page.getByTestId('email').fill(MEMBER.email);
    await page.getByTestId('password').fill(`wrong-password-${i}-wrong`);
    await page.getByTestId('submit').click();
    await expect(page.getByTestId('submit')).toBeEnabled({ timeout: 90_000 });
  }
  // верный пароль: браузер сам решает задание, пользователь ничего не вводит
  await page.getByTestId('email').fill(MEMBER.email);
  await page.getByTestId('password').fill(MEMBER.password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('vault-select')).toBeVisible({ timeout: 120_000 });
  await ctx.close();
});

/** Создаёт папку кнопкой «Создать папку» в центре и ждёт её в списке папок текущего расположения. */
async function createFolderHere(page: Page, name: string): Promise<void> {
  await page.getByTestId('btn-create-folder').click();
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId('name-ok').click();
  await expect(page.getByTestId(`tile-open-${name}`)).toBeVisible();
}
const openTile = (page: Page, name: string) => page.getByTestId(`tile-open-${name}`).click();
const current = (page: Page) => page.getByTestId('crumb-current');
const activeRow = (page: Page) => page.locator('[data-testid="branch-row"].nav-link-active');

test('проводник сейфа: папки и записи в центре, путь, синхронизация с деревом, F5', async () => {
  await chief.setViewportSize({ width: 1366, height: 768 });
  await chief.goto('/');
  await expect(chief.getByTestId('add-entry')).toBeVisible({ timeout: 60_000 });
  await expect(chief.getByTestId('crumb-up')).toHaveCount(0); // в корне подняться некуда

  // сценарий 1: структура создаётся там, где пользователь находится
  await createFolderHere(chief, 'Инфраструктура');
  await openTile(chief, 'Инфраструктура');
  await expect(current(chief)).toHaveText('Инфраструктура');
  await expect(activeRow(chief)).toContainText('Инфраструктура'); // слева выделена та же папка
  await expect(chief).toHaveURL(/folder=/);
  await createFolderHere(chief, 'Серверы');
  await openTile(chief, 'Серверы');
  await createFolderHere(chief, 'Linux');
  await openTile(chief, 'Linux');
  await createFolderHere(chief, 'Production');
  await openTile(chief, 'Production');
  await expect(current(chief)).toHaveText('Production');
  // длинный путь свёрнут: корень, «…» и три последних уровня
  await expect(chief.getByTestId('crumb-more')).toBeVisible();
  await chief.getByTestId('add-entry').click();
  await chief.getByTestId('f-title').fill('root-вход Production');
  await chief.getByTestId('f-save').click();
  await expect(chief.getByTestId('view-title')).toHaveText('root-вход Production');
  const row = chief.getByTestId('entry-row').filter({ hasText: 'root-вход Production' });
  await expect(row).toContainText('Инфраструктура / Серверы / Linux / Production');

  // сценарий 2: подъём «наверх» и по свёрнутому пути; запись видна только в своей папке
  await chief.getByTestId('crumb-up').click();
  await expect(current(chief)).toHaveText('Linux');
  await expect(row).toHaveCount(0);
  await openTile(chief, 'Production');
  await chief.getByTestId('crumb-more').click();
  await chief.getByTestId('breadcrumbs').getByRole('button', { name: 'Инфраструктура' }).click();
  await expect(current(chief)).toHaveText('Инфраструктура');
  await openTile(chief, 'Серверы');
  await openTile(chief, 'Linux');
  await reloadKeeps(chief, 'Linux');
  // другая папка слева: центр следует за деревом
  await createFolderHere(chief, 'Production 2');
  await chief.getByTestId('crumb-root').click();
  await expect(current(chief)).toHaveCount(0);
  await chief
    .getByTestId('branch-row')
    .getByRole('button', { name: 'Инфраструктура', exact: true })
    .click();
  await expect(current(chief)).toHaveText('Инфраструктура');
  await expect(chief.getByTestId('tile-open-Серверы')).toBeVisible();
  await chief.goBack(); // «Назад» возвращает на предыдущую папку
  await expect(chief.getByTestId('crumb-current')).toHaveCount(0);

  // сценарий 3: действия над папкой из центра
  await createFolderHere(chief, 'Бухгалтерия');
  await chief.getByTestId('tile-menu-Бухгалтерия').click();
  await chief.getByTestId('folder-rename').click();
  await chief.getByTestId('name-input').fill('Финансы');
  await chief.getByTestId('name-ok').click();
  await expect(chief.getByTestId('tile-open-Финансы')).toBeVisible();
  await chief.getByTestId('tile-menu-Финансы').click();
  await chief.getByTestId('folder-move').selectOption({ label: 'Инфраструктура' });
  await expect(chief.getByTestId('tile-open-Финансы')).toHaveCount(0);
  await openTile(chief, 'Инфраструктура');
  await expect(chief.getByTestId('tile-open-Финансы')).toBeVisible();
  await chief.getByTestId('tile-menu-Финансы').click();
  await chief.getByTestId('folder-pin').click();
  await chief.getByTestId('scope-favorites').click();
  await expect(chief.getByTestId('favorite-folder-Финансы')).toBeVisible();
  await expect(chief.getByTestId('folder-section')).toHaveCount(0); // «Избранное» — не просмотр папки
  await expect(chief.getByTestId('breadcrumbs')).toHaveCount(0);
  await chief.getByTestId('scope-all').click();
  await chief
    .getByTestId('branch-row')
    .getByRole('button', { name: 'Инфраструктура', exact: true })
    .click();
  await chief.getByTestId('tile-menu-Финансы').click();
  chief.once('dialog', (d) => void d.accept());
  await chief.getByTestId('folder-delete').click();
  await expect(chief.getByTestId('tile-open-Финансы')).toHaveCount(0);
  await chief.getByTestId('scope-trash').click();
  await chief.getByTestId('restore-branch').click();
  await chief.getByTestId('scope-all').click();
  await chief
    .getByTestId('branch-row')
    .getByRole('button', { name: 'Инфраструктура', exact: true })
    .click();
  await expect(chief.getByTestId('tile-open-Финансы')).toBeVisible();

  // поиск — отдельный режим: папки скрыты, записи ищутся и во вложенных папках
  await chief.getByTestId('search').fill('root-вход');
  await expect(chief.getByTestId('folder-section')).toHaveCount(0);
  await expect(
    chief.getByTestId('entry-row').filter({ hasText: 'root-вход Production' }),
  ).toBeVisible();
  await chief.getByTestId('search').fill('');
  await expect(chief.getByTestId('folder-section')).toBeVisible();

  // чужой сотрудник по прямой ссылке на папку ничего не получает
  const folder = new URL(chief.url()).searchParams.get('folder');
  expect(folder).toBeTruthy();
  await member.goto(`/?folder=${folder}`);
  await expect(member.getByTestId('vault-select')).toBeVisible({ timeout: 60_000 });
  await expect(member.getByTestId('crumb-current')).toHaveCount(0);
  await expect(member.getByTestId('tile-open-Серверы')).toHaveCount(0);
});

/** F5 на странице папки: путь, дерево и адрес сохраняются. */
async function reloadKeeps(page: Page, name: string): Promise<void> {
  await page.reload();
  await expect(page.getByTestId('crumb-current')).toHaveText(name, { timeout: 60_000 });
  await expect(activeRow(page)).toContainText(name);
  await expect(page).toHaveURL(/folder=/);
}

test('проводник: без горизонтальной прокрутки на ноутбуках и телефоне, во всех темах', async () => {
  await chief.goto('/');
  await expect(chief.getByTestId('add-entry')).toBeVisible({ timeout: 60_000 });
  await chief
    .getByTestId('branch-row')
    .getByRole('button', { name: 'Инфраструктура', exact: true })
    .click();
  // снимки для документации: уровень с вложенными папками
  for (const [w, h, name] of [
    [1366, 768, 'ui-explorer-1366'],
    [390, 844, 'ui-explorer-390'],
  ] as const) {
    await chief.setViewportSize({ width: w, height: h });
    await expect(chief.getByTestId('folder-tile').first()).toBeVisible();
    await chief.screenshot({ path: `docs/screenshots/${name}.png` });
  }
  // много папок в одном месте: список записей всё равно виден на ноутбуке при масштабе 100, 125 и 150 %
  for (let i = 1; i <= 10; i++) await createFolderHere(chief, `Раздел ${i}`);
  await chief.getByTestId('add-entry').click();
  await chief.getByTestId('f-title').fill('Запись корня раздела');
  await chief.getByTestId('f-save').click();
  await expect(chief.getByTestId('view-title')).toHaveText('Запись корня раздела');
  for (const [w, h] of [
    [1366, 768],
    [1093, 614],
    [911, 512],
  ] as const) {
    await chief.setViewportSize({ width: w, height: h });
    await chief.waitForTimeout(300);
    const m = await chief.evaluate(() => {
      const r = document.querySelector('[data-testid="entry-row"]')!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, h: innerHeight };
    });
    expect(m.top, `${w}×${h}`).toBeGreaterThanOrEqual(0);
    expect(m.bottom, `${w}×${h}`).toBeLessThanOrEqual(m.h);
  }
  await chief.setViewportSize({ width: 1366, height: 768 });
  await openTile(chief, 'Серверы');
  await openTile(chief, 'Linux');
  await openTile(chief, 'Production');
  for (const [w, h] of [
    [1280, 800],
    [1366, 768],
    [1440, 900],
    [1512, 982],
    [1920, 1080],
    [390, 844],
  ] as const) {
    await chief.setViewportSize({ width: w, height: h });
    await expect(chief.getByTestId('breadcrumbs')).toBeVisible();
    const over = await chief.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over, `${w}×${h}`).toBeLessThanOrEqual(0);
  }
  await chief.setViewportSize({ width: 1366, height: 768 });
  for (const theme of ['glass', 'night', 'grove', 'aurora']) {
    await chief.evaluate((id) => {
      document.documentElement.dataset.theme = id;
      document.documentElement.classList.toggle('dark', ['night', 'aurora'].includes(id));
    }, theme);
    await expect(chief.getByTestId('breadcrumbs')).toBeVisible();
    const crumb = await chief.getByTestId('crumb-current').evaluate((el) => {
      const c = getComputedStyle(el);
      const bg = getComputedStyle(document.body).backgroundColor;
      return { color: c.color, bg };
    });
    expect(crumb.color, theme).not.toBe(crumb.bg);
  }
});

test('чистая установка: «Современный и лёгкий» на всех экранах до входа, без цветных кружков, прежние значения переносятся', async ({
  browser,
  baseURL,
}) => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const html = () =>
    page.evaluate(() => [
      document.documentElement.dataset.theme,
      document.documentElement.className,
    ]);
  await page.goto(baseURL!);
  await page.getByTestId('email').waitFor({ timeout: 60_000 });
  expect(await html()).toEqual(['glass', '']);
  // в шапке нет переключателя темы (раньше — ряд цветных кружков)
  await expect(page.getByRole('group', { name: /^(Theme|Тема)$/ })).toHaveCount(0);
  await expect(page.locator('header button.rounded-full')).toHaveCount(0);
  // вход, справка, регистрация и восстановление — одна и та же тема
  for (const path of ['/login', '/help']) {
    await page.goto(baseURL! + path);
    expect((await html())[0], path).toBe('glass');
  }
  // значения, сохранённые прежними версиями в браузере, переходят на ближайшую из четырёх тем без ошибок
  const mapped = {
    corporate: 'glass',
    sunset: 'glass',
    light: 'grove',
    emerald: 'grove',
    dark: 'night',
    forest: 'night',
  };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const [old, now] of Object.entries(mapped)) {
    await page.evaluate((v) => localStorage.setItem('arklock.theme', v), old);
    await page.reload();
    const [theme, cls] = await html();
    expect(theme, old).toBe(now);
    expect(cls.includes('dark'), old).toBe(now === 'night');
  }
  await page.evaluate(() => localStorage.setItem('arklock.theme', 'neon'));
  await page.reload();
  expect((await html())[0]).toBe('glass');
  // очистка кэша браузера: без сохранённого значения снова тема по умолчанию
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  expect((await html())[0]).toBe('glass');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('модальные окна одинаково оформлены во всех четырёх темах: светлая подложка, непрозрачное окно, подсказки поверх', async () => {
  await chief.goto('/');
  await expect(chief.getByTestId('add-entry')).toBeVisible({ timeout: 60_000 });
  const themes = ['glass', 'night', 'grove', 'aurora'];
  const rgba = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
  for (const [w, h] of [
    [1280, 800],
    [1366, 768],
  ] as const) {
    await chief.setViewportSize({ width: w, height: h });
    for (const theme of themes) {
      await chief.evaluate((id) => {
        document.documentElement.dataset.theme = id;
        document.documentElement.classList.toggle('dark', ['night', 'aurora'].includes(id));
      }, theme);
      await chief.getByTestId('add-entry').click();
      const dialog = chief.getByTestId('entry-panel');
      await expect(dialog).toHaveAttribute('role', 'dialog');
      const look = await chief.evaluate(() => {
        const panel = document.querySelector('[data-testid="entry-panel"]') as HTMLElement;
        const modal = panel.querySelector('.modal') as HTMLElement;
        const cs = getComputedStyle(modal);
        const root = getComputedStyle(document.documentElement);
        return {
          scrim: getComputedStyle(panel).backgroundColor,
          bg: cs.backgroundColor,
          dialogBg: root.getPropertyValue('--dialog-bg').trim(),
          radius: cs.borderTopLeftRadius,
          shadow: cs.boxShadow !== 'none',
          inputBg: getComputedStyle(modal.querySelector('input.input') as HTMLElement)
            .backgroundColor,
        };
      });
      const light = theme === 'glass' || theme === 'grove';
      const [, , , a] = rgba(look.scrim);
      // подложка полупрозрачная и не мрачная: в светлых темах её плотность заметно ниже прежних 60 %
      expect(a, `${theme} подложка`).toBeLessThanOrEqual(light ? 0.3 : 0.65);
      // окно непрозрачное и берёт цвет токена темы, а не серый «стеклянный»
      expect(
        rgba(look.bg).length === 3 || rgba(look.bg)[3] === 1,
        `${theme} окно непрозрачно`,
      ).toBe(true);
      expect(look.shadow).toBe(true);
      expect(look.radius).not.toBe('0px');
      // в «Корпоративном минимализме» окно и поля белые по замыслу и отделены рамкой
      if (theme !== 'grove') expect(look.inputBg, `${theme} поле`).not.toBe(look.bg);
      if (theme === 'glass') expect(look.bg).toBe('rgb(248, 251, 255)');
      await chief.screenshot({ path: `docs/screenshots/ui-modal-${theme}-${w}.png` });
      // подсказка внутри окна открывается поверх него и не обрезается
      const hint = dialog.getByTestId('info-hint').first();
      if (await hint.count()) {
        await hint.hover();
        const shown = await chief.evaluate(() => {
          const trigger = document.querySelector('[data-testid="info-hint"][aria-describedby]');
          const tip = trigger && document.getElementById(trigger.getAttribute('aria-describedby')!);
          if (!tip) return false;
          const r = tip.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + 8, r.top + 8);
          return (
            r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && tip.contains(top)
          );
        });
        expect(shown, `${theme} подсказка`).toBe(true);
        await chief.mouse.move(0, 0);
      }
      await chief.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
  }
  await chief.evaluate(() => {
    document.documentElement.dataset.theme = 'glass';
    document.documentElement.classList.remove('dark');
  });
  await chief.setViewportSize({ width: 1366, height: 768 });
});

test('защита входа: проверка настроек до применения, пробная проверка, применение и отмена', async () => {
  await chief.setViewportSize({ width: 1366, height: 768 });
  await chief.goto('/admin/shield');
  await chief.getByTestId('shield-tab-login').click();
  await expect(chief.getByTestId('shield-login')).toBeVisible();
  // названия: вычислительное задание не выдаётся за CAPTCHA
  await expect(chief.getByTestId('login-mechanism')).toContainText(
    /вычислительное задание|computational task/,
  );
  await expect(chief.getByTestId('shield-login')).not.toContainText(/CAPTCHA\s+включ/i);
  await expect(chief.getByTestId('policy-summary')).toContainText(/\d+ (ошибок|failures)/);

  // «Применить» недоступно, пока настройки не проверены
  await expect(chief.getByTestId('shield-save-login')).toBeDisabled();
  await chief.getByTestId('set-captcha-after').fill('0');
  await chief.getByTestId('shield-check-login').click();
  await expect(chief.getByTestId('policy-errors')).toContainText(
    /вне допустимых границ|out of the allowed range/,
  );
  await expect(chief.getByTestId('shield-save-login')).toBeDisabled();

  // рискованные, но допустимые значения: предупреждение, применить можно только после подтверждения
  await chief.getByTestId('set-captcha-after').fill('2');
  await chief.getByTestId('shield-check-login').click();
  await expect(chief.getByTestId('policy-ok')).toBeVisible();
  await expect(chief.getByTestId('policy-warnings')).toContainText(/второй ошибки|second failure/);
  await expect(chief.getByTestId('shield-save-login')).toBeDisabled();
  await chief.getByTestId('policy-ack').check();
  await expect(chief.getByTestId('shield-save-login')).toBeEnabled();
  // после правки значения прежняя проверка недействительна
  await chief.getByTestId('set-captcha-after').fill('3');
  await expect(chief.getByTestId('policy-stale')).toBeVisible();
  await expect(chief.getByTestId('shield-save-login')).toBeDisabled();
  // отмена возвращает действующие значения
  await chief.getByTestId('shield-revert-login').click();
  await expect(chief.getByTestId('set-captcha-after')).toHaveValue('5');
  await expect(chief.getByTestId('policy-check')).toHaveCount(0);

  // пробная проверка: настоящее задание, успех, ошибка, телефон
  await chief.getByTestId('shield-preview-open').click();
  await expect(chief.getByTestId('login-preview')).toBeVisible();
  await expect(chief.getByTestId('preview-idle')).toBeVisible();
  await chief.getByTestId('preview-start').click();
  await expect(chief.getByTestId('preview-ok')).toBeVisible({ timeout: 60_000 });
  await chief.getByTestId('preview-wrong').click();
  await expect(chief.getByTestId('preview-error')).toBeVisible({ timeout: 30_000 });
  await chief.getByTestId('preview-phone').check();
  const width = await chief
    .getByTestId('preview-form')
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(352);
  await chief.screenshot({ path: 'docs/screenshots/shield-login-preview.png' });
  // телефонный экран: окно не шире экрана, кнопки доступны
  await chief.setViewportSize({ width: 390, height: 844 });
  const box = await chief.getByTestId('login-preview').locator('.modal').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(chief.getByTestId('preview-close')).toBeInViewport();
  await chief.setViewportSize({ width: 1366, height: 768 });
  await chief.getByTestId('preview-close').click();
  await expect(chief.getByTestId('login-preview')).toHaveCount(0);

  // применение: проверка, подтверждение паролем, действующее значение сохранено и видно после F5
  await chief.getByTestId('set-captcha-after').fill('6');
  await chief.getByTestId('shield-check-login').click();
  await expect(chief.getByTestId('policy-ok')).toBeVisible();
  // 6 мягче действующих 5: система предупреждает об ослаблении и просит подтверждение
  await expect(chief.getByTestId('policy-warnings')).toContainText(
    /слабее действующих|weaker than the current/,
  );
  await chief.getByTestId('policy-ack').check();
  await chief.getByTestId('shield-save-login').click();
  await chief.getByTestId('shield-password').fill(CHIEF.password);
  await chief.getByTestId('shield-reauth-ok').click();
  await expect(chief.getByTestId('shield-notice')).toBeVisible();
  await chief.reload();
  await chief.getByTestId('shield-tab-login').click();
  await expect(chief.getByTestId('set-captcha-after')).toHaveValue('6');
  await expect(chief.getByTestId('policy-summary')).toContainText('6');
  // возвращаем значение по умолчанию
  await chief.getByTestId('set-captcha-after').fill('5');
  await chief.getByTestId('shield-check-login').click();
  await expect(chief.getByTestId('policy-ok')).toBeVisible();
  await expect(chief.getByTestId('policy-warnings')).toHaveCount(0); // ужесточение не требует подтверждения
  await chief.getByTestId('shield-save-login').click();
  // подтверждение паролем хранится только в памяти вкладки и после F5 запрашивается снова
  await chief.getByTestId('shield-password').fill(CHIEF.password);
  await chief.getByTestId('shield-reauth-ok').click();
  await expect(chief.getByTestId('shield-notice')).toBeVisible();
  await expect(chief.getByTestId('set-captcha-after')).toHaveValue('5');
});

test('адрес без защищённого контекста: страница входа объясняет причину, предлагает безопасный адрес и SSH-туннель', async ({
  browser,
  baseURL,
}) => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ru-RU' });
  // имитация http по IP: Web Crypto недоступен
  await ctx.addInitScript(() =>
    Object.defineProperty(globalThis, 'isSecureContext', { value: false }),
  );
  const page = await ctx.newPage();
  await page.goto(`${baseURL}/login`);
  const hint = page.getByTestId('insecure-context');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('HTTPS');
  await expect(hint).toContainText('localhost');
  // без публичного HTTPS-адреса остаётся путь через SSH-туннель
  await expect(page.getByTestId('insecure-tunnel')).toContainText(/ssh -L \d+:127\.0\.0\.1:\d+/);
  await expect(page.getByTestId('insecure-public')).toHaveCount(0);
  await page.screenshot({ path: 'docs/screenshots/ui-insecure-context.png' });

  // публичный адрес задан администратором: подсказка ведёт на него
  await page.route('**/api/v1/access', (route) =>
    route.fulfill({
      json: {
        protocol: 'http',
        secure: false,
        host: 'x',
        publicUrl: 'https://arklock.example.com',
        publicMatches: false,
        forwardedProto: null,
        trustedProxyHops: 1,
        firstUser: true,
      },
    }),
  );
  await page.reload();
  await expect(page.getByTestId('insecure-open')).toHaveAttribute(
    'href',
    'https://arklock.example.com',
  );
  // телефон: подсказка не шире экрана
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'docs/screenshots/ui-insecure-context-390.png' });
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
  await ctx.close();
});

// ---- 1.85.0: форма SMTP, ровные поля, флажки, меню, адаптивность

/** Подтверждение мастер-паролем для небезопасных настроек почты (если вопрос задан). */
async function reauthIfAsked(page: Page, password: string): Promise<void> {
  const asked = await page
    .getByTestId('mail-reauth-password')
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!asked) return;
  await page.getByTestId('mail-reauth-password').fill(password);
  await page.getByTestId('mail-reauth-ok').click();
}

test('SMTP: переключение способов входа не очищает экран; NTLM сохраняется и проходит проверку на сервере с NTLM', async () => {
  const pageErrors: string[] = [];
  const onError = (e: Error) => pageErrors.push(e.message);
  chief.on('pageerror', onError);
  const pki = await makePki();
  const fake = await fakeSmtp({
    tls: { mode: 'starttls', key: pki.keyPem, cert: pki.certPem },
    authBefore: [],
    auth: ['NTLM'],
    ntlm: { user: 'svc-mail', domain: 'CORP', password: 'N7lm-Synthetic-pw', withTimestamp: true },
  });
  try {
    await chief.goto('/admin/smtp');
    await chief.getByTestId('smtp-add').click();
    // все способы входа по кругу, в том числе повторно: форма и меню остаются на месте
    for (const mode of ['password', 'ntlm', 'none', 'ntlm', 'password', 'none', 'ntlm']) {
      await chief.getByTestId('smtp-auth').selectOption(mode);
      await expect(chief.getByTestId('smtp-form')).toBeVisible();
      await expect(chief.getByTestId('admin-nav')).toBeVisible();
      await expect(chief.getByTestId('smtp-user')).toBeVisible({ visible: mode !== 'none' });
      await expect(chief.getByTestId('smtp-password')).toBeVisible({ visible: mode !== 'none' });
    }
    // подсказки NTLM (в них «логин@домен») читаются, а не ломают отрисовку
    await expect(chief.getByTestId('smtp-user')).toHaveAttribute(
      'placeholder',
      /логин@домен|login@domain/,
    );
    // NTLM без шифрования сервер не принимает: форма говорит об этом и не даёт сохранить
    await chief.getByTestId('smtp-security').selectOption('none');
    await expect(chief.getByTestId('smtp-ntlm-tls')).toBeVisible();
    await expect(chief.getByTestId('smtp-save')).toBeDisabled();
    await chief.getByTestId('smtp-security').selectOption('starttls');
    await expect(chief.getByTestId('smtp-ntlm-tls')).toBeHidden();
    await expect(chief.getByTestId('smtp-save')).toBeEnabled();

    await chief.getByTestId('smtp-name').fill('Exchange NTLM');
    await chief.getByTestId('smtp-host').fill('127.0.0.1');
    await chief.getByTestId('smtp-port').fill(String(fake.port));
    await chief.getByTestId('smtp-user').fill('CORP\\svc-mail');
    await chief.getByTestId('smtp-password').fill('N7lm-Synthetic-pw');
    await chief.getByTestId('smtp-from').fill('arklock@corp.example');
    await chief.getByTestId('smtp-verify').uncheck(); // тестовый сертификат не из доверенного центра
    await expect(chief.getByTestId('unsaved-hint')).toBeVisible();
    await chief.getByTestId('smtp-save').click();
    await reauthIfAsked(chief, CHIEF.password);
    await expect(chief.getByTestId('mail-notice')).toBeVisible();

    const card = chief.locator('[data-profile]', { hasText: 'Exchange NTLM' });
    await card.locator('[data-action="check"]').click();
    await expect(card.getByTestId('smtp-result')).toContainText(/Проверка пройдена|Check passed/);
    expect(fake.stats.ntlmV2).toBe(1);
    expect(fake.log.join('\n')).not.toContain('N7lm-Synthetic-pw');

    // повторное открытие: способ входа и учётная запись на месте, пароль в форму не возвращается
    await card.locator('[data-action="edit"]').click();
    await expect(chief.getByTestId('smtp-auth')).toHaveValue('ntlm');
    await expect(chief.getByTestId('smtp-user')).toHaveValue('CORP\\svc-mail');
    await expect(chief.getByTestId('smtp-password')).toHaveValue('');
    await expect(chief.getByTestId('unsaved-hint')).toBeHidden();
    await chief.screenshot({ path: 'docs/screenshots/ui-smtp-ntlm-form.png' });
    expect(pageErrors).toEqual([]);
  } finally {
    chief.off('pageerror', onError);
    await fake.close();
  }
});

test('сбой отрисовки или ответа API остаётся внутри раздела: меню и другие разделы работают', async () => {
  await chief.route('**/api/v1/admin/smtp/profiles', (route) =>
    route.fulfill({ json: { activeId: null, profiles: [{ id: 'x', name: 'Неполный профиль' }] } }),
  );
  await chief.goto('/admin/smtp');
  await expect(chief.getByTestId('section-error')).toBeVisible();
  await expect(chief.getByTestId('admin-nav')).toBeVisible();
  await expect(chief.getByTestId('section-error-retry')).toBeVisible();
  await chief.unroute('**/api/v1/admin/smtp/profiles');
  // «Повторить» и переход в другой раздел возвращают рабочий интерфейс
  await chief.getByTestId('section-error-retry').click();
  await expect(chief.getByTestId('section-error')).toBeHidden();
  await chief.getByTestId('admin-tab-syslog').click();
  await expect(chief.getByTestId('syslog-save')).toBeVisible();
  // недоступный сервер: сообщение в разделе, меню живо
  await chief.route('**/api/v1/admin/smtp/profiles', (route) => route.abort());
  await chief.getByTestId('admin-tab-smtp').click();
  await expect(chief.getByTestId('admin-nav')).toBeVisible();
  await expect(chief.getByTestId('smtp-add')).toBeVisible();
  await chief.unroute('**/api/v1/admin/smtp/profiles');
});

test('поля формы стоят ровно: верхние границы в ряду совпадают, подсказка «i» не меняет высоту подписи', async () => {
  for (const width of [1280, 1024, 768]) {
    await chief.setViewportSize({ width, height: 900 });
    await chief.goto('/admin/smtp');
    await chief.getByTestId('smtp-add').click();
    await chief.getByTestId('smtp-auth').selectOption('ntlm');
    const top = async (id: string) => (await chief.getByTestId(id).boundingBox())!.y;
    const h = async (id: string) => (await chief.getByTestId(id).boundingBox())!.height;
    for (const [a, b] of [
      ['smtp-host', 'smtp-security'],
      ['smtp-port', 'smtp-timeout'],
      ['smtp-user', 'smtp-password'],
      ['smtp-from', 'smtp-from-name'],
    ] as const) {
      expect(
        Math.abs((await top(a)) - (await top(b))),
        `${width}: ${a} / ${b}`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs((await h(a)) - (await h(b))),
        `${width}: высота ${a} / ${b}`,
      ).toBeLessThanOrEqual(0.5);
    }
  }
  await chief.setViewportSize({ width: 1366, height: 768 });
});

test('параметры «вкл/выкл» — флажки с галочкой слева от названия; несохранённое изменение видно', async () => {
  await chief.goto('/admin/updates');
  const box = chief.getByTestId('auto-check');
  await expect(box).toBeVisible();
  const style = await box.evaluate((el) => {
    const cs = getComputedStyle(el);
    const label = el.closest('label')!;
    return {
      appearance: cs.appearance,
      width: parseFloat(cs.width),
      border: parseFloat(cs.borderTopWidth),
      boxLeft: el.getBoundingClientRect().left,
      textLeft: label.querySelector('.check-text')!.getBoundingClientRect().left,
      labelRight: label.getBoundingClientRect().right,
      boxRight: el.getBoundingClientRect().right,
    };
  });
  expect(style.appearance).toBe('none');
  expect(style.width).toBeGreaterThanOrEqual(16);
  expect(style.border).toBeGreaterThanOrEqual(1); // граница видна (на экранах 1× рисуется 1 px)
  expect(style.boxLeft).toBeLessThan(style.textLeft); // флажок рядом с названием, а не у правого края
  expect(style.labelRight - style.boxRight).toBeGreaterThan(40);
  // включённый флажок рисует галочку
  await expect(box).toBeChecked();
  expect(await box.evaluate((el) => getComputedStyle(el, '::after').content)).not.toBe('none');
  // изменение без «Сохранить» помечено; возврат к прежнему значению снимает пометку
  await expect(chief.getByTestId('unsaved-hint')).toBeHidden();
  await box.click();
  await expect(chief.getByTestId('unsaved-hint')).toBeVisible();
  await box.click();
  await expect(chief.getByTestId('unsaved-hint')).toBeHidden();
  // переключателей прежнего вида в приложении не осталось
  for (const route of [
    '/admin/settings',
    '/admin/shield',
    '/admin/ldap',
    '/admin/saml',
    '/admin/sso',
  ]) {
    await chief.goto(route);
    await chief.waitForLoadState('networkidle');
    expect(await chief.locator('input.switch').count(), route).toBe(0);
  }
});

test('меню администрирования: по умолчанию раскрыта только текущая группа; на телефоне — один список разделов', async () => {
  await chief.evaluate(() => localStorage.removeItem('arklock.admin.nav'));
  await chief.goto('/admin/smtp');
  await expect(chief.getByTestId('admin-tab-smtp')).toBeVisible();
  await expect(chief.getByTestId('admin-tab-users')).toBeHidden();
  await expect(chief.getByTestId('admin-tab-resources')).toBeHidden();
  const menu = await chief.getByTestId('admin-nav').boundingBox();
  expect(menu!.height).toBeLessThan(520); // раньше меню не помещалось на экране и прокручивалось
  // клик по группе раскрывает её, текущая остаётся
  await chief.getByTestId('admin-group-toggle-system').click();
  await expect(chief.getByTestId('admin-tab-resources')).toBeVisible();
  await expect(chief.getByTestId('admin-tab-smtp')).toBeVisible();
  // телефон: выбор раздела из списка с группами, кнопок меню нет
  await chief.setViewportSize({ width: 390, height: 844 });
  await expect(chief.getByTestId('admin-nav-select')).toBeVisible();
  await expect(chief.getByTestId('admin-tab-smtp')).toBeHidden();
  await chief.getByTestId('admin-nav-select').selectOption('syslog');
  await expect(chief).toHaveURL(/\/admin\/syslog/);
  await expect(chief.getByTestId('syslog-save')).toBeVisible();
  await expect(chief.getByTestId('admin-nav-select')).toHaveValue('syslog');
  await chief.setViewportSize({ width: 1366, height: 768 });
  await chief.evaluate(() => {
    const all = [
      'overview',
      'people',
      'vaultsGroup',
      'security',
      'system',
      'storage',
      'integrations',
      'server',
    ];
    localStorage.setItem(
      'arklock.admin.nav',
      JSON.stringify({ open: Object.fromEntries(all.map((g) => [g, true])) }),
    );
  });
});

test('ширины 320–1920: страница не прокручивается вбок, поля на телефоне не меньше 16 px, формы одноколоночные', async () => {
  const routes = [
    '/',
    '/settings',
    '/security',
    '/notifications',
    '/admin/overview',
    '/admin/resources',
    '/admin/smtp',
    '/admin/updates',
    '/admin/users',
    '/admin/settings',
    '/admin/shield',
    '/admin/ldap',
    '/admin/backups',
    '/admin/ledger',
    '/admin/roles',
  ];
  const problems: string[] = [];
  for (const width of [320, 375, 390, 768, 1024, 1280, 1920]) {
    await chief.setViewportSize({ width, height: width < 600 ? 800 : 900 });
    for (const route of routes) {
      await chief.goto(route);
      await chief.waitForLoadState('networkidle');
      const m = await chief.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const small = [
          ...document.querySelectorAll(
            'input:not([type=checkbox]):not([type=radio]):not([type=file]),select,textarea',
          ),
        ]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).length;
        return { over: document.documentElement.scrollWidth - vw, vw, small };
      });
      if (m.over > 1) problems.push(`${width} ${route}: прокрутка вбок ${m.over}px`);
      if (width <= 560 && m.small)
        problems.push(`${width} ${route}: полей меньше 16px — ${m.small}`);
    }
  }
  // форма SMTP на телефоне — одна колонка, на планшете — две
  await chief.setViewportSize({ width: 390, height: 844 });
  await chief.goto('/admin/smtp');
  await chief.getByTestId('smtp-add').click();
  const hostX = (await chief.getByTestId('smtp-host').boundingBox())!;
  const secX = (await chief.getByTestId('smtp-security').boundingBox())!;
  if (Math.abs(hostX.x - secX.x) > 1) problems.push('телефон: форма не в одну колонку');
  await chief.setViewportSize({ width: 768, height: 900 });
  const hostT = (await chief.getByTestId('smtp-host').boundingBox())!;
  const secT = (await chief.getByTestId('smtp-security').boundingBox())!;
  if (!(secT.x > hostT.x + hostT.width - 1)) problems.push('планшет: форма не в две колонки');
  expect(problems, problems.join('\n')).toEqual([]);
  await chief.setViewportSize({ width: 1366, height: 768 });
});

test('окно выше экрана (экранная клавиатура, альбомный телефон) прокручивается: верх и низ достижимы', async () => {
  await chief.goto('/');
  await chief.getByTestId('btn-new-folder').click();
  await chief.setViewportSize({ width: 390, height: 180 });
  const modal = chief
    .getByTestId('name-input')
    .locator('xpath=ancestor::*[contains(@class,"modal")][1]');
  const scrim = chief.locator('.modal-scrim').last();
  await expect(modal).toBeVisible();
  const box = async () => (await modal.boundingBox())!;
  expect(await scrim.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  await scrim.evaluate((e) => e.scrollTo(0, 0));
  expect((await box()).y).toBeGreaterThanOrEqual(0);
  await scrim.evaluate((e) => e.scrollTo(0, e.scrollHeight));
  const b = await box();
  expect(b.y + b.height).toBeLessThanOrEqual(180 + 1);
  await chief.keyboard.press('Escape');
  await chief.setViewportSize({ width: 1366, height: 768 });
});

// ---- 1.86.0: каталог LDAPS, сертификаты, понятные ошибки, обновление без ложных ошибок

test('каталог LDAPS: адрес исправляется, ошибки под полями, сертификат .cer (DER), проверка до сохранения, сохранение без «не сохранено»', async () => {
  // тестовый каталог по LDAPS со своим центром сертификации; имена и пароли вымышленные
  const req = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ldap: any = req('ldapjs');
  const chain = await makeChain();
  const BASE = 'dc=example,dc=com';
  const SVC = 'cn=svc-ldap,ou=service,dc=example,dc=com';
  const server = ldap.createServer({ certificate: chain.leaf + chain.mid, key: chain.keyPem });
  server.bind(
    SVC,
    (r: { credentials: string }, res: { end: () => void }, next: (e?: unknown) => void) => {
      if (r.credentials !== 'Svc-ldap-Synthetic-1') return next(new ldap.InvalidCredentialsError());
      res.end();
      return next();
    },
  );
  server.search(
    BASE,
    (
      r: { scope: string },
      res: { send: (e: object) => void; end: () => void },
      next: () => void,
    ) => {
      if (r.scope === 'base') res.send({ dn: BASE, attributes: { objectClass: 'domain' } });
      else
        res.send({
          dn: `cn=Alex Doe,${BASE}`,
          attributes: { objectClass: 'person', cn: 'Alex Doe', mail: 'alex.doe@example.com' },
        });
      res.end();
      return next();
    },
  );
  const port: number = await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
  try {
    await chief.goto('/admin/ldap');
    // однозначное отклонение (завершающий «/») исправляется и называется
    await chief.getByTestId('ldap-url').fill(`ldaps://127.0.0.1:${port}/`);
    await chief.getByTestId('ldap-basedn').click();
    await expect(chief.getByTestId('ldap-url')).toHaveValue(`ldaps://127.0.0.1:${port}`);
    await expect(chief.getByTestId('ldap-url-fixed')).toBeVisible();
    // неверный адрес: причина под полем, а не общее «данные неверны»
    await chief.getByTestId('ldap-url').fill('ldaps://dc01.example.com/dc=example,dc=com');
    await chief.getByTestId('ldap-basedn').click();
    await expect(chief.getByTestId('ldap-url-error')).toContainText(/Base DN/);
    await chief.getByTestId('ldap-url').fill(`ldaps://127.0.0.1:${port}`);
    // учётная запись: короткое имя дополняется доменом из Base DN, и форма говорит, что будет использовано
    await chief.getByTestId('ldap-basedn').fill(BASE);
    await chief.getByTestId('ldap-binddn').fill('svc-ldap');
    await expect(chief.getByTestId('ldap-binddn-hint')).toContainText('svc-ldap@example.com');
    await chief.getByTestId('ldap-binddn').fill('svc ldap');
    await chief.getByTestId('ldap-bindpw').click();
    await expect(chief.getByTestId('ldap-binddn-error')).toBeVisible();
    await chief.getByTestId('ldap-binddn').fill(SVC);
    await chief.getByTestId('ldap-bindpw').fill('Svc-ldap-Synthetic-1');
    // закрытый ключ вместо сертификата — конкретная причина
    await chief.getByTestId('ldap-ca-file').setInputFiles({
      name: 'server.pem',
      mimeType: 'application/x-pem-file',
      buffer: Buffer.from(chain.keyPem),
    });
    await expect(chief.getByTestId('ldap-ca-problem')).toContainText(/закрытый ключ|private key/);
    // корпоративный .cer в DER: без ручной конвертации
    const der = Buffer.from(new X509Certificate(chain.root).raw);
    await chief
      .getByTestId('ldap-ca-file')
      .setInputFiles({ name: 'root-ca.cer', mimeType: 'application/pkix-cert', buffer: der });
    await expect(chief.getByTestId('ldap-ca-info')).toContainText(/Корневой центр|Root authority/);
    await expect(chief.getByTestId('ldap-ca-chain-ok')).toBeVisible();
    await chief.getByTestId('ldap-enabled').check();
    // проверка того, что в форме, до сохранения: все этапы пройдены
    await chief.getByTestId('ldap-test').click();
    await expect(chief.getByTestId('ldap-result')).toContainText(/работает|works/);
    for (const stage of ['config', 'dns', 'tcp', 'tls', 'bind', 'base', 'filter', 'users'])
      await expect(chief.locator(`[data-stage="${stage}"]`)).toHaveAttribute('data-ok', 'true');
    // сохранение: подтверждение не нужно (LDAPS с проверкой), пометка «не сохранено» исчезает
    await expect(chief.getByTestId('unsaved-hint')).toBeVisible();
    await chief.getByTestId('ldap-save').click();
    await expect(chief.getByTestId('ldap-notice')).toBeVisible();
    await expect(chief.getByTestId('unsaved-hint')).toBeHidden();
    await expect(chief.getByTestId('ldap-reauth')).toHaveCount(0);
    await chief.screenshot({ path: 'docs/screenshots/ui-ldap-check.png', fullPage: true });
    // повторное открытие: значения на месте, пароль не возвращается, сертификат описан
    await chief.reload();
    await expect(chief.getByTestId('ldap-url')).toHaveValue(`ldaps://127.0.0.1:${port}`);
    await expect(chief.getByTestId('ldap-binddn')).toHaveValue(SVC);
    await expect(chief.getByTestId('ldap-bindpw')).toHaveValue('');
    await expect(chief.getByTestId('ldap-ca-info')).toBeVisible();
    await expect(chief.getByTestId('unsaved-hint')).toBeHidden();
    // правка другого поля сохраняет прежний пароль служебной записи
    await chief.getByTestId('ldap-profile-name').fill('Каталог организации');
    await expect(chief.getByTestId('unsaved-hint')).toBeVisible();
    await chief.getByTestId('ldap-save').click();
    await expect(chief.getByTestId('unsaved-hint')).toBeHidden();
    await chief.getByTestId('ldap-test').click();
    await expect(chief.getByTestId('ldap-result')).toContainText(/работает|works/);
    // неверный пароль: этап входа и понятная причина
    await chief.getByTestId('ldap-bindpw').fill('Wrong-Synthetic-1');
    await chief.getByTestId('ldap-test').click();
    await expect(chief.locator('[data-stage="bind"]')).toHaveAttribute('data-ok', 'false');
    await expect(chief.locator('[data-stage="bind"]')).toContainText(/52e/);
  } finally {
    server.close();
  }
});

test('«Обновления»: перезапуск приложения (502 от прокси, нет связи) не даёт ложной красной ошибки; страница сама восстанавливается', async () => {
  let fail = 3;
  await chief.route('**/api/v1/admin/updates', async (route) => {
    if (route.request().method() === 'GET' && fail > 0) {
      fail--;
      // как прокси во время перезапуска: HTML вместо ответа приложения
      return route.fulfill({
        status: 502,
        contentType: 'text/html',
        body: '<html><body>502 Bad Gateway</body></html>',
      });
    }
    return route.continue();
  });
  await chief.goto('/admin/updates');
  await expect(chief.getByTestId('updates-restarting')).toBeVisible();
  await expect(chief.getByTestId('updates-error')).toHaveCount(0);
  await expect(chief.getByText('http_error')).toHaveCount(0);
  // сервер вернулся: сообщение о перезапуске исчезает, версия видна, красной ошибки нет
  await expect(chief.getByTestId('updates-restarting')).toBeHidden({ timeout: 15_000 });
  await expect(chief.getByTestId('installed-version')).toBeVisible();
  await expect(chief.getByTestId('updates-error')).toHaveCount(0);
  await chief.unroute('**/api/v1/admin/updates');
});

test('почта: сертификат, который предъявил сервер, принимается как доверенный одной кнопкой, и проверка проходит', async () => {
  const { webcrypto } = await import('node:crypto');
  const x509 = await import('@peculiar/x509');
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
  const keys = (await webcrypto.subtle.generateKey(alg, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  // самоподписанный сертификат на внутреннее имя, подключение идёт по адресу 127.0.0.1 — имя не совпадает
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '3b',
    name: 'CN=mail01',
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
    signingAlgorithm: alg,
    keys,
    extensions: [new x509.BasicConstraintsExtension(false)],
  });
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const label = ['PRIVATE', 'KEY'].join(' ');
  const key = `-----BEGIN ${label}-----\n${der.toString('base64')}\n-----END ${label}-----\n`;
  const fake = await fakeSmtp({ tls: { mode: 'starttls', key, cert: cert.toString('pem') } });
  try {
    await chief.goto('/admin/smtp');
    await chief.getByTestId('smtp-add').click();
    await chief.getByTestId('smtp-name').fill('Самоподписанный');
    await chief.getByTestId('smtp-host').fill('127.0.0.1');
    await chief.getByTestId('smtp-port').fill(String(fake.port));
    await chief.getByTestId('smtp-from').fill('arklock@example.com');
    await chief.getByTestId('smtp-save').click();
    await expect(chief.getByTestId('mail-notice')).toBeVisible();
    const card = chief.locator('[data-profile]', { hasText: 'Самоподписанный' });
    await card.locator('[data-action="check"]').click();
    await expect(card.getByTestId('smtp-trust')).toBeVisible();
    chief.once('dialog', (d) => void d.accept());
    await card.getByTestId('smtp-trust').getByRole('button').click();
    await expect(card.getByTestId('smtp-result')).toContainText(/Проверка пройдена|Check passed/);
    await expect(card.locator('[data-testid^="smtp-pinned-"]')).toContainText('mail01');
    chief.once('dialog', (d) => void d.accept());
    await card.locator('[data-testid^="smtp-untrust-"]').click();
    await expect(card.locator('[data-testid^="smtp-pinned-"]')).toHaveCount(0);
  } finally {
    await fake.close();
  }
});
