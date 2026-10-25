import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_KDF } from '@arklock/crypto';
import { TestClient } from '../apps/api/test/helpers.js';
import { Counter, httpApp } from './support/org.js';

/**
 * Повседневная работа сотрудника: замеры числа действий в обычных сценариях (копирование пароля, правка, поиск, создание,
 * перенос, удаление и возврат, подпапка), ошибки консоли и сети, работа с клавиатуры. Цифры идут в test-results/ux-measure.jsonl.
 */
const BASE = 'http://127.0.0.1:18191';
const SETUP = 'e2e-setup-code-e2e-setup-code-9';
const ME = {
  email: 'daily@corp.example',
  name: 'Ежедневный Пользователь',
  password: 'daily-master-password-1',
};
const OUT = 'test-results/ux-measure.jsonl';
let page: Page;
const consoleErrors: string[] = [];
const failedRequests: string[] = [];

const record = (c: Counter) => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync(
    OUT,
    JSON.stringify({
      label: c.label,
      actions: c.actions,
      clicks: c.clicks,
      inputs: c.inputs,
      screens: c.screens,
      seconds: c.seconds,
    }) + '\n',
  );
  console.log(c.report());
};

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ locale: 'ru-RU', baseURL: BASE });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('/auth/'))
      failedRequests.push(`${r.status()} ${r.url()}`);
  });
});

test('подготовка: регистрация, папки и 300 записей', async () => {
  test.setTimeout(300_000);
  await page.goto('/');
  await page.getByTestId('email').fill(ME.email);
  await page.getByTestId('name').fill(ME.name);
  await page.getByTestId('setup-token').fill(SETUP);
  await page.getByTestId('password').fill(ME.password);
  await page.getByTestId('repeat').fill(ME.password);
  await page.getByTestId('submit').click();
  await page.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await page.getByTestId('recovery-continue').click();
  await expect(page.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  const c = new TestClient(httpApp(BASE), ME.email, ME.password);
  await c.login();
  const vault = (await c.vaults()).find((v) => v.kind === 'shared')!;
  const key = await c.openVault(vault);
  const a = await c.createBranch(vault.id, key, 'Бухгалтерия');
  const b = await c.createBranch(vault.id, key, 'Серверы');
  await c.createBranch(vault.id, key, 'Сеть', b.id);
  for (let i = 0; i < 300; i++)
    await c.createEntry(
      {
        kind: 'login',
        title: `Сервис ${String(i).padStart(3, '0')}`,
        username: `user${i}`,
        password: `Pw-${i}-Correct-Horse-9!`,
        url: `https://svc${i}.corp.example`,
        notes: '',
        totp: '',
        fields: [],
        tags: [],
        links: [],
      },
      { vaultId: vault.id, vaultKey: key, branchId: i % 2 ? a.id : b.id },
    );
  await page.reload();
  await expect(page.getByTestId('entry-row').first()).toBeVisible({ timeout: 90_000 });
  void DEFAULT_KDF;
});

test('копирование пароля известной записи', async () => {
  const c = new Counter(page, 'Ежедневно: скопировать пароль');
  await c.click('search'); // фокус в поиск не считается: он нужен только для ввода
  c.clicks--;
  await c.fill('search', 'Сервис 042');
  await c.click('entry-row');
  await c.click('btn-copy-password');
  record(c);
  await page.getByTestId('search').fill('');
});

test('правка названия записи', async () => {
  const c = new Counter(page, 'Ежедневно: изменить запись');
  await c.fill('search', 'Сервис 043');
  await c.click('entry-row');
  await c.click('btn-edit');
  await c.fill('f-title', 'Сервис 043 (новое)');
  await c.click('f-save');
  await expect(page.getByTestId('view-title')).toContainText('новое');
  record(c);
  await page.getByTestId('search').fill('');
});

test('поиск и открытие записи', async () => {
  const c = new Counter(page, 'Ежедневно: найти и открыть запись');
  await c.fill('search', 'svc150');
  await c.click('entry-row');
  await expect(page.getByTestId('view-title')).toContainText('150');
  record(c);
  await page.getByTestId('search').fill('');
});

test('создание записи в открытой папке', async () => {
  const c = new Counter(page, 'Ежедневно: создать запись в открытой папке');
  await page.getByTestId('branch-row').filter({ hasText: 'Серверы' }).first().click();
  await c.click('add-entry');
  await c.fill('f-title', 'Новая запись');
  await c.fill('f-username', 'ivan');
  await c.fill('f-password', 'Brand-New-Pass-77!x');
  await c.click('f-save');
  await expect(page.getByTestId('view-title')).toContainText('Новая запись');
  record(c);
});

test('перенос записи в другую папку: отметка и «Переместить», перетаскивание', async () => {
  test.setTimeout(90_000);
  await page.getByTestId('search').fill('Новая запись');
  const c = new Counter(page, 'Ежедневно: перенести запись в другую папку (отметка и кнопка)');
  await page.getByTestId('entry-row').first().hover();
  await page.getByTestId('row-check').first().check({ force: true });
  c.clicks++;
  await c.pick('bulk-target', { label: 'Бухгалтерия' });
  await c.click('bulk-move');
  record(c);
  // перетаскивание: одно действие (запись теперь в «Бухгалтерии»; поиск идёт по всему сейфу)
  await page.getByTestId('scope-all').click();
  await page.getByTestId('search').fill('Новая запись');
  const drag = new Counter(page, 'Ежедневно: перенести запись в другую папку (перетаскивание)');
  await page
    .getByTestId('entry-row')
    .first()
    .dragTo(page.getByTestId('branch-row').filter({ hasText: 'Серверы' }).first());
  drag.clicks++;
  record(drag);
  await page.getByTestId('search').fill('');
});

test('удаление и возврат из корзины', async () => {
  const c = new Counter(page, 'Ежедневно: удалить запись и вернуть из корзины');
  await page.getByTestId('search').fill('Новая запись');
  await c.click('entry-row');
  await c.click('entry-actions');
  await c.click('btn-trash');
  await c.click('scope-trash');
  await c.click('entry-row');
  await c.click('restore-entry');
  record(c);
});

test('быстрое копирование: кнопка в строке и клавиши', async () => {
  await page.getByTestId('scope-all').click();
  const c = new Counter(page, 'Ежедневно: скопировать пароль кнопкой в строке (с поиском)');
  await c.fill('search', 'Сервис 044');
  await page.getByTestId('entry-row').first().hover();
  await c.click('row-copy-password');
  await expect(page.getByTestId('flash')).toBeVisible();
  record(c);
  const k = new Counter(page, 'Ежедневно: скопировать пароль клавишей «c» (запись открыта)');
  await page.getByTestId('entry-row').first().click();
  k.clicks++;
  await page.keyboard.press('c');
  k.inputs++;
  await expect(page.getByTestId('flash')).toBeVisible();
  record(k);
  // «/» ведёт в поиск, «n» открывает форму новой записи, «e» — изменение, «Esc» не теряет данные
  await page.getByTestId('search').fill('');
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('/');
  await expect(page.getByTestId('search')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('n');
  await expect(page.getByTestId('entry-form')).toBeVisible();
});

test('панель «Корпоративные пространства» закрывается крестиком', async () => {
  await page.goto('/');
  await expect(page.getByTestId('entry-row').first()).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('vault-actions').click();
  await page.getByTestId('spaces-open').click();
  await expect(page.getByTestId('spaces-panel')).toBeVisible();
  await page.getByTestId('spaces-close').click();
  await expect(page.getByTestId('spaces-panel')).toHaveCount(0);
});

test('удаление отменяется одним нажатием', async () => {
  const c = new Counter(page, 'Ежедневно: удалить запись и сразу отменить');
  await page.getByTestId('scope-all').click();
  await page.getByTestId('search').fill('Сервис 045');
  await c.click('entry-row');
  await c.click('entry-actions');
  await c.click('btn-trash');
  await c.click('undo-trash');
  record(c);
  await expect(page.getByTestId('entry-row').filter({ hasText: 'Сервис 045' })).toHaveCount(1);
  await page.getByTestId('search').fill('');
});

test('подпапка в открытой папке', async () => {
  const c = new Counter(page, 'Ежедневно: создать подпапку');
  await page.getByTestId('scope-all').click();
  await page.getByTestId('branch-row').filter({ hasText: 'Серверы' }).first().click();
  await c.click('btn-new-folder');
  await c.fill('name-input', 'Прод');
  await c.click('name-ok');
  record(c);
});

test('работа с клавиатуры: Tab доходит до «Добавить запись», Esc закрывает меню, фокус виден', async () => {
  await page.goto('/');
  await page.getByTestId('search').focus();
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') === 'add-entry',
    );
  }
  expect(reached).toBe(true);
  // у сфокусированного элемента виден контур или тень
  const outlined = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement!);
    return cs.outlineStyle !== 'none' || cs.boxShadow !== 'none';
  });
  expect(outlined).toBe(true);
  await page.getByTestId('vault-actions').click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('доступность: у кнопок, ссылок и полей есть названия, заголовки идут по порядку', async () => {
  test.setTimeout(240_000);
  const offenders: string[] = [];
  for (const url of [
    '/',
    '/admin/overview',
    '/admin/users',
    '/admin/settings?section=security',
    '/transfer',
    '/help',
    '/security',
  ]) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    const bad = await page.evaluate(() => {
      const name = (el: Element): string => {
        const h = el as HTMLElement;
        const aria = h.getAttribute('aria-label') || h.getAttribute('title');
        if (aria?.trim()) return aria.trim();
        const by = h.getAttribute('aria-labelledby');
        if (by)
          return by
            .split(' ')
            .map((i) => document.getElementById(i)?.textContent ?? '')
            .join(' ')
            .trim();
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement
        ) {
          if (el.type === 'hidden') return 'x';
          if (el.labels?.length)
            return Array.from(el.labels)
              .map((l) => l.textContent)
              .join(' ')
              .trim();
          return el.getAttribute('placeholder')?.trim() ?? '';
        }
        return (
          (h.textContent ?? '').trim() || h.querySelector('img[alt]')?.getAttribute('alt') || ''
        );
      };
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const out: string[] = [];
      for (const el of Array.from(
        document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]'),
      ))
        if (visible(el) && !name(el)) out.push(el.outerHTML.slice(0, 110));
      const levels = Array.from(document.querySelectorAll('h1, h2, h3')).map((h) =>
        Number(h.tagName[1]),
      );
      for (let i = 1; i < levels.length; i++)
        if (levels[i]! - levels[i - 1]! > 1)
          out.push(`заголовки: h${levels[i - 1]} → h${levels[i]}`);
      if (document.querySelectorAll('h1').length > 1) out.push('несколько h1');
      return out;
    });
    for (const b of bad) offenders.push(`${url}: ${b}`);
  }
  expect(offenders, offenders.join('\n')).toEqual([]);
});

test('снимки основных экранов на ноутбуке и телефоне', async () => {
  for (const [w, h, tag] of [
    [1366, 768, 'laptop'],
    [390, 844, 'phone'],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    await expect(page.getByTestId('entry-row').first()).toBeVisible({ timeout: 60_000 });
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
    if (tag === 'laptop') await page.getByTestId('entry-row').nth(2).hover();
    await page.screenshot({ path: `docs/screenshots/daily-${tag}-list.png` });
    await page.getByTestId('entry-row').nth(2).click();
    await page.screenshot({ path: `docs/screenshots/daily-${tag}-entry.png` });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('в консоли и сети нет ошибок', async () => {
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  expect(failedRequests, failedRequests.join('\n')).toEqual([]);
});
