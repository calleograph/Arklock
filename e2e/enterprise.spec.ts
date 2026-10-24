import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { Counter, DEPARTMENTS, headEmail, PASSWORD, seedUsers, staffEmail } from './support/org.js';

/**
 * Сквозной сценарий внедрения в компании на 20 подразделений: администратор и 60 синтетических сотрудников,
 * подразделения создаются через интерфейс; число действий фиксируется для отчёта docs/UX_ENTERPRISE_JOURNEY_AUDIT.md.
 */
test.describe.configure({ mode: 'serial' });
test.use({ locale: 'ru-RU' });

const BASE = 'http://127.0.0.1:18190';
const SETUP = 'e2e-setup-code-e2e-setup-code-8';
const ADMIN = {
  email: 'chief@corp.example',
  name: 'Главный Администратор',
  password: 'chief-master-password-1',
};
const OUT = 'test-results/ux-measure.jsonl';
let page: Page;
let token = '';

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
const api = async (method: string, url: string, data?: unknown) => {
  const r = await page.request.fetch(`/api/v1${url}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    data,
  });
  return { status: r.status(), json: await r.json().catch(() => null) };
};

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ locale: 'ru-RU', baseURL: BASE })).newPage();
});

test('администратор регистрируется, открывается регистрация, заводятся 60 сотрудников', async () => {
  await page.goto('/');
  await page.getByTestId('email').fill(ADMIN.email);
  await page.getByTestId('name').fill(ADMIN.name);
  await page.getByTestId('setup-token').fill(SETUP);
  await page.getByTestId('password').fill(ADMIN.password);
  await page.getByTestId('repeat').fill(ADMIN.password);
  await page.getByTestId('submit').click();
  await page.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await page.getByTestId('recovery-continue').click();
  await expect(page.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  token = (await page.evaluate(() => sessionStorage.getItem('arklock.token')))!;
  expect((await api('PUT', '/admin/settings', { 'registration.mode': 'open' })).status).toBe(200);
  test.setTimeout(600_000);
  await seedUsers(BASE, 20, headEmail);
  await seedUsers(BASE, 40, staffEmail);
  const users = (await api('GET', '/admin/users')).json as unknown[];
  expect(users).toHaveLength(61);
});

test('было: подразделение прежним путём — группа, пространство, сейф, права по отдельности', async () => {
  const c = new Counter(page, 'Создать подразделение (прежний путь)');
  const name = 'Старый отдел';
  // 1. группа и руководитель
  await c.click('menu-toggle');
  await c.click('menu-full');
  await c.click('admin-tab-circles');
  c.screen();
  await c.fill('circle-name', name);
  await c.click('circle-create');
  await c.click(`circle-${name}`);
  const v = await page
    .getByTestId('circle-add-user')
    .locator('option', { hasText: headEmail(0) })
    .getAttribute('value');
  await c.pick('circle-add-user', v!);
  await c.click('circle-add');
  // 2. пространство и группа в нём
  await c.click('menu-toggle');
  await c.click('menu-vault');
  c.screen();
  await c.click('vault-actions');
  await c.click('spaces-open');
  c.screen();
  await c.click('space-new');
  await c.fill('space-name', name);
  await c.click('space-save');
  c.inputs++;
  await page.getByLabel(/Группы|Groups/).selectOption({ label: name });
  c.clicks++;
  await page
    .getByRole('button', { name: /^(Добавить|Add)$/ })
    .first()
    .click();
  // 3. сейф в пространстве
  c.screen();
  await c.pick('space-select', { label: name });
  await c.click('vault-actions');
  await c.click('btn-new-vault');
  await c.fill('name-input', name);
  await c.click('name-ok');
  // 4. права на сейф: группа и руководитель
  await c.click('vault-actions');
  await c.click('btn-vault-settings');
  c.screen();
  for (const [q, level] of [
    [name, 'builtin:editor'],
    [headEmail(0), 'builtin:admin'],
  ] as const) {
    await c.click('grant-open');
    await c.fill('grant-search', q);
    await c.click(`grant-option-${q}`);
    await c.pick('grant-level', level);
    await c.click('grant-submit');
    await expect(page.getByTestId('grant-dialog')).not.toBeVisible();
  }
  record(c);
  expect(c.actions).toBeGreaterThan(20);
});

test('стало: подразделение мастером — одно окно', async () => {
  const c = new Counter(page, 'Создать подразделение (мастер)');
  await c.click('menu-toggle');
  await c.click('menu-full');
  await c.click('admin-tab-departments');
  c.screen();
  await c.fill('dept-name', 'Бухгалтерия');
  const v = await page
    .getByTestId('dept-head')
    .locator('option', { hasText: headEmail(4) })
    .getAttribute('value');
  await c.pick('dept-head', v!);
  await c.click('dept-create');
  await expect(page.getByTestId('dept-state')).toHaveText('Готово', { timeout: 120_000 });
  record(c);

  // независимая проверка структуры по API
  const circles = (await api('GET', '/admin/circles')).json as { id: string; name: string }[];
  const circle = circles.find((x) => x.name === 'Бухгалтерия')!;
  // руководитель — администратор сейфа напрямую, а не только участник группы
  const vs = (await api('GET', '/vaults')).json as { id: string; name: string }[];
  const dv = vs.find((x) => x.name === 'Бухгалтерия')!;
  const mem = (await api('GET', `/vaults/${dv.id}/members`)).json as {
    members: { email: string; directRole: string | null }[];
  };
  expect(mem.members.find((m) => m.email === headEmail(4))?.directRole).toBe('admin');
  expect(circle).toBeTruthy();
  const members = (await api('GET', `/admin/circles/${circle.id}/members`)).json as {
    email: string;
  }[];
  expect(members.map((m) => m.email)).toEqual([headEmail(4)]);
  const spaces = (await api('GET', '/spaces')).json as { id: string; name: string }[];
  const space = spaces.find((s) => s.name === 'Бухгалтерия')!;
  expect(space).toBeTruthy();
  const vaults = (await api('GET', '/vaults')).json as {
    id: string;
    name: string;
    spaceId: string;
  }[];
  expect(
    vaults
      .filter((x) => x.spaceId === space.id)
      .map((x) => x.name)
      .sort(),
  ).toEqual(['Бухгалтерия', 'Бухгалтерия · Руководство']);
  expect(c.actions).toBeLessThanOrEqual(8);
});

test('стало: остальные 19 подразделений списком, повтор не создаёт дублей', async () => {
  test.setTimeout(600_000);
  const c = new Counter(page, 'Создать 19 подразделений (список)');
  const rest = DEPARTMENTS.filter((d) => d !== 'Бухгалтерия');
  const lines = rest.map((d) => `${d}; ${headEmail(DEPARTMENTS.indexOf(d))}`);
  c.screen();
  await c.click('dept-mode-many');
  await c.fill('dept-list', lines.join('\n'));
  await expect(page.getByTestId('dept-row')).toHaveCount(19);
  // предпросмотр до создания: никаких конфликтов
  await expect(
    page.getByTestId('dept-state').filter({ hasText: /не найден|нет названия|повтор/ }),
  ).toHaveCount(0);
  await c.click('dept-create');
  await expect(page.getByTestId('dept-state').filter({ hasText: 'Готово' })).toHaveCount(19, {
    timeout: 540_000,
  });
  record(c);

  const circles = (await api('GET', '/admin/circles')).json as { name: string }[];
  const spaces = (await api('GET', '/spaces')).json as { id: string; name: string }[];
  const vaults = (await api('GET', '/vaults')).json as { name: string; spaceId: string }[];
  for (const d of DEPARTMENTS) {
    expect(
      circles.filter((x) => x.name === d),
      d,
    ).toHaveLength(1);
    expect(
      spaces.filter((x) => x.name === d),
      d,
    ).toHaveLength(1);
    expect(
      vaults.filter((x) => x.name === d),
      d,
    ).toHaveLength(1);
  }

  // повтор того же списка: всё «есть», дублей не появляется
  await expect(page.getByTestId('dept-row').first()).toContainText('есть');
  await page.getByTestId('dept-create').click();
  await expect(page.getByTestId('dept-state').filter({ hasText: 'Готово' })).toHaveCount(19, {
    timeout: 540_000,
  });
  const again = (await api('GET', '/vaults')).json as { name: string }[];
  expect(again.length).toBe(vaults.length);
});

test('неверная строка блокирует создание и объясняет причину', async () => {
  await page.getByTestId('dept-list').fill('Новый отдел; nobody@corp.example\nНовый отдел');
  await expect(page.getByTestId('dept-create')).toBeDisabled();
  await expect(page.getByTestId('dept-state').first()).toContainText('руководитель не найден');
  await expect(page.getByTestId('dept-state').nth(1)).toContainText('повтор');
});

async function login(browser: Browser, email: string, password = PASSWORD): Promise<Page> {
  const p = await (await browser.newContext({ locale: 'ru-RU', baseURL: BASE })).newPage();
  await p.goto('/login');
  await p.getByTestId('email').fill(email);
  await p.getByTestId('password').fill(password);
  await p.getByTestId('submit').click();
  await expect(p.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
  return p;
}

test('руководитель отдела: структура папок, запись, копирование, выдача доступа — замер действий', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  // сотрудники бухгалтерии: администратор добавляет их в группу, ключи сейфа выдаёт клиент администратора
  const circles = (await api('GET', '/admin/circles')).json as { id: string; name: string }[];
  const acc = circles.find((x) => x.name === 'Бухгалтерия')!;
  const users = (await api('GET', '/admin/users')).json as { id: string; email: string }[];
  const idOf = (e: string) => users.find((u) => u.email === e)!.id;
  await api('PATCH', `/admin/circles/${acc.id}/members`, {
    add: [idOf(staffEmail(0)), idOf(staffEmail(1))],
  });
  // клиент администратора загружает сейфы и выдаёт ключи ожидающим участникам группы
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-vault').click();
  await expect(page.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  await page.reload();
  await expect(page.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });

  // первый вход руководителя: сразу открыт его отдел, а не пустая «Организация»
  const head = await login(browser, headEmail(4));
  await expect(head.getByTestId('space-select').locator('option:checked')).toHaveText(
    'Бухгалтерия',
  );
  await head.getByTestId('vault-select').selectOption({ label: 'Бухгалтерия' });

  // подпапки до пяти уровней
  const f = new Counter(head, 'Создать подпапку внутри выбранной папки');
  const mk = async (name: string, c: Counter) => {
    await c.click('btn-new-folder');
    await c.fill('name-input', name);
    await c.click('name-ok');
    await expect(head.getByTestId('branch-row').filter({ hasText: name })).toBeVisible();
  };
  await mk('Налоги', new Counter(head, 'корневая папка'));
  let parent = 'Налоги';
  for (const lvl of ['НДС', 'Декларации', '2026', 'Квартал 1']) {
    f.clicks++;
    await head
      .getByTestId('branch-row')
      .getByRole('button', { name: lvl === 'НДС' ? 'Налоги' : parent, exact: true })
      .click();
    await mk(lvl, f);
    parent = lvl;
  }
  record(f);

  // запись в открытой папке
  const e = new Counter(head, 'Создать запись в открытой папке');
  e.clicks++;
  await head
    .getByTestId('branch-row')
    .getByRole('button', { name: 'Квартал 1', exact: true })
    .click();
  await e.click('add-entry');
  e.screen();
  await e.fill('f-title', 'Банк-клиент');
  await e.fill('f-username', 'buh');
  await e.fill('f-password', 'Correct-Horse-Battery-77!x');
  await e.click('f-save');
  await expect(head.getByTestId('view-title')).toHaveText('Банк-клиент');
  await expect(head.getByTestId('entry-row').first()).toContainText('Квартал 1');
  record(e);

  const cp = new Counter(head, 'Скопировать пароль из открытой карточки');
  await cp.click('btn-copy-password');
  record(cp);

  const g = new Counter(head, 'Предоставить доступ к записи отделу «Продажи»');
  await g.click('tab-access');
  g.screen();
  await g.click('grant-open');
  await g.fill('grant-search', 'Продажи');
  await g.click('grant-option-Продажи');
  await g.click('grant-submit');
  await expect(head.getByTestId('entry-access-grant').filter({ hasText: 'Продажи' })).toHaveCount(
    1,
  );
  record(g);
  await head.context().close();
});
