import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';

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

test('laptop sizes and all ten themes keep the admin layout usable', async () => {
  const themes = [
    'glass',
    'night',
    'grove',
    'aurora',
    'corporate',
    'light',
    'dark',
    'forest',
    'emerald',
    'sunset',
  ];
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
      document.documentElement.classList.toggle(
        'dark',
        ['dark', 'forest', 'night', 'aurora'].includes(id),
      );
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
