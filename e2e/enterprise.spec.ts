import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { TestClient } from '../apps/api/test/helpers.js';
import {
  Counter,
  DEPARTMENTS,
  headEmail,
  httpApp,
  PASSWORD,
  seedUsers,
  staffEmail,
} from './support/org.js';

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

test('«Начало работы»: администратор видит, что настроено и что нет', async () => {
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();
  const list = page.getByTestId('setup-checklist');
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('setup-url')).toHaveAttribute('data-done', '0');
  await expect(page.getByTestId('setup-dept')).toHaveAttribute('data-done', '0');
  await expect(page.getByTestId('setup-people')).toHaveAttribute('data-done', '1');
  await page.getByTestId('setup-dept').getByRole('link').click();
  await expect(page).toHaveURL(/\/admin\/departments$/);
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
  await c.fill('circle-add-user-input', headEmail(0));
  await c.click(`circle-add-user-result-${headEmail(0)}`);
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
  // руководитель находится поиском на сервере, а не выбирается из списка в тысячи человек
  await c.fill('dept-head-input', headEmail(4));
  await c.click(`dept-head-result-${headEmail(4)}`);
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

test('мастер: участники и начальные папки в сейфе отдела', async () => {
  test.setTimeout(300_000);
  await page.getByTestId('dept-mode-one').click();
  await page.getByTestId('dept-name').fill('Отдел с папками');
  // руководитель прошлого прохода остаётся в форме: снимаем его
  while (
    await page
      .getByTestId('dept-head')
      .getByRole('button', { name: /Убрать/ })
      .count()
  )
    await page
      .getByTestId('dept-head')
      .getByRole('button', { name: /Убрать/ })
      .first()
      .click();
  await page.getByTestId('dept-member-input').fill(staffEmail(2));
  await page.getByTestId(`dept-member-result-${staffEmail(2)}`).click();
  await page.getByTestId('dept-folders').fill('Серверы, Сеть');
  await page.getByTestId('dept-create').click();
  await expect(page.getByTestId('dept-state')).toHaveText('Готово', { timeout: 120_000 });
  const circles = (await api('GET', '/admin/circles')).json as { id: string; name: string }[];
  const c = circles.find((x) => x.name === 'Отдел с папками')!;
  const members = (await api('GET', `/admin/circles/${c.id}/members`)).json as { email: string }[];
  expect(members.map((m) => m.email)).toEqual([staffEmail(2)]);
  // папки созданы в сейфе отдела (названия зашифрованы — проверяется через интерфейс)
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-vault').click();
  await page.getByTestId('space-select').selectOption({ label: 'Отдел с папками' });
  await expect(page.getByTestId('branch-row').filter({ hasText: 'Серверы' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('branch-row').filter({ hasText: 'Сеть' })).toBeVisible();
  // вернуться в мастер для следующих сценариев
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();
  await page.getByTestId('admin-tab-departments').click();
  await page.getByTestId('dept-mode-many').click();
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
  await expect(p.getByTestId('space-select')).toBeVisible({ timeout: 90_000 });
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

test('новый сотрудник отдела: приглашение, активация, первый вход, ожидание ключа — замер', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const email = 'new.accountant@corp.example';
  const a = new Counter(page, 'Добавить сотрудника в отдел (приглашение)');
  await a.click('menu-toggle');
  await a.click('menu-full');
  await a.click('admin-tab-invitations');
  a.screen();
  await a.fill('invite-name', 'Новый Бухгалтер');
  await a.fill('invite-email', email);
  await a.fill('invite-circle-filter', 'Бухг');
  await a.click('invite-circle-Бухгалтерия');
  await a.click('invite-create');
  const code = (await page.getByTestId('invite-code').textContent())!.trim();
  record(a);

  const guest = await (await browser.newContext({ locale: 'ru-RU', baseURL: BASE })).newPage();
  const n = new Counter(guest, 'Первый вход нового сотрудника (активация)');
  await guest.goto('/login');
  await n.click('to-activate');
  n.screen();
  await n.fill('email', email);
  await n.fill('activation-code', code);
  await n.click('submit');
  await expect(guest.getByTestId('name')).toHaveValue('Новый Бухгалтер', { timeout: 30_000 });
  await n.fill('password', PASSWORD);
  await n.fill('repeat', PASSWORD);
  await n.click('submit');
  await guest.getByTestId('recovery-saved').check({ timeout: 90_000 });
  n.clicks++;
  await n.click('recovery-continue');
  record(n);
  await expect(guest.getByTestId('space-select')).toBeVisible({ timeout: 90_000 });
  await guest.screenshot({ path: 'test-results/new-employee-first-screen.png' });
  // сразу открыт отдел
  await expect(guest.getByTestId('space-select').locator('option:checked')).toHaveText(
    'Бухгалтерия',
  );
  await guest.context().close();
});

test('сотрудник видит только свой отдел; сейф руководства закрыт', async ({ browser }) => {
  test.setTimeout(300_000);
  // руководитель открыл Arklock — клиент выдал ключи сейфа участникам группы; ждём, пока они появятся
  const staff = await login(browser, staffEmail(0));
  await expect(staff.getByTestId('space-select').locator('option:checked')).toHaveText(
    'Бухгалтерия',
  );
  const spaces = await staff.getByTestId('space-select').locator('option').allTextContents();
  expect(spaces).not.toContain('Продажи');
  const vaultsShown = await staff.getByTestId('vault-select').locator('option').allTextContents();
  expect(vaultsShown.map((v) => v.replace(/[^\p{L}\p{N}· ]/gu, '').trim())).toEqual([
    'Бухгалтерия',
  ]);
  // глобальный поиск без выбора отдела находит запись, созданную руководителем
  await expect(async () => {
    await staff.reload();
    await expect(staff.getByTestId('entry-row').first()).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 90_000 });
  await staff.getByTestId('search').fill('Банк');
  await expect(staff.getByTestId('entry-row')).toHaveCount(1);
  // прямой запрос к сейфу руководства: сервер отказывает
  const token = await staff.evaluate(() => sessionStorage.getItem('arklock.token'));
  const lead = ((await api('GET', '/vaults')).json as { id: string; name: string }[]).find(
    (v) => v.name === 'Бухгалтерия · Руководство',
  )!;
  const r = await staff.request.fetch(`/api/v1/vaults/${lead.id}/tree`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect([403, 404]).toContain(r.status());
  await staff.context().close();
});

test('перевод сотрудника из бухгалтерии в закупки — замер и последствия', async ({ browser }) => {
  test.setTimeout(300_000);
  const t = new Counter(page, 'Перевести сотрудника в другое подразделение');
  await t.click('menu-toggle');
  await t.click('menu-full');
  await t.click('admin-tab-users');
  t.screen();
  await t.click(`profile-open-${staffEmail(1)}`);
  await t.click('transfer-open');
  const to = await page
    .getByTestId('transfer-to')
    .locator('option', { hasText: /^Закупки$/ })
    .getAttribute('value');
  await t.pick('transfer-to', to!);
  await expect(page.getByTestId('transfer-preview')).toContainText('Бухгалтерия');
  await t.click('transfer-go');
  await expect(page.getByTestId('transfer-done')).toBeVisible();
  record(t);

  const users = (await api('GET', '/admin/users')).json as { id: string; email: string }[];
  const id = users.find((u) => u.email === staffEmail(1))!.id;
  const groups = (
    (await api('GET', `/admin/users/${id}/profile`)).json as { groups: { name: string }[] }
  ).groups;
  expect(groups.map((g) => g.name)).toEqual(['Закупки']);
  const card = (await api('GET', `/admin/users/${id}/profile`)).json as {
    access: { name: string }[];
  };
  expect(card.access.map((a) => a.name)).toEqual(['Закупки']);
  // старый доступ закрыт на сервере, по потерянным записям — «смените пароль»
  const s2 = await login(browser, staffEmail(1));
  await expect(s2.getByTestId('space-select').locator('option:checked')).toHaveText('Закупки');
  await s2.context().close();
  const old = ((await api('GET', '/vaults')).json as { id: string; name: string }[]).find(
    (v) => v.name === 'Бухгалтерия',
  )!;
  const sig = (await api('GET', `/vaults/${old.id}/signals`)).json as {
    type: string;
    cause: { id: string } | null;
  }[];
  expect(sig.filter((x) => x.type === 'rotate' && x.cause?.id === id).length).toBeGreaterThan(0);
});

test('нагрузка: 1500 записей в сейфе отдела — замеры интерфейса (3 повтора)', async ({
  browser,
}) => {
  test.setTimeout(590_000);
  const hc = new TestClient(httpApp(BASE), headEmail(4), PASSWORD);
  await hc.login();
  const vault = (await hc.vaults()).find((v) => v.name === 'Бухгалтерия')!;
  const key = await hc.openVault(vault);
  const folders: string[] = [];
  for (let i = 0; i < 12; i++)
    folders.push((await hc.createBranch(vault.id, key, `Раздел ${i + 1}`, null)).id);
  const N = 1500;
  for (let i = 0; i < N; i += 25)
    await Promise.all(
      Array.from({ length: 25 }, (_, j) =>
        hc.createEntry(
          {
            kind: 'login',
            title: `Запись ${String(i + j).padStart(4, '0')}`,
            username: `user${i + j}`,
            password: `Pw-${i + j}-Correct-Horse-9!`,
            url: `https://svc${(i + j) % 50}.corp.example`,
            notes: '',
            totp: '',
            tags: [],
            fields: [],
            links: [],
          },
          { vaultId: vault.id, vaultKey: key, branchId: folders[(i + j) % 12] },
        ),
      ),
    );

  let t0 = 0;
  const times = {
    open: [] as number[],
    search: [] as number[],
    folder: [] as number[],
    users: [] as number[],
    groups: [] as number[],
  };
  for (let rep = 0; rep < 3; rep++) {
    const p = await (await browser.newContext({ locale: 'ru-RU', baseURL: BASE })).newPage();
    await p.goto('/login');
    await p.getByTestId('email').fill(headEmail(4));
    await p.getByTestId('password').fill(PASSWORD);
    t0 = Date.now();
    await p.getByTestId('submit').click();
    await expect(p.getByTestId('entry-row').first()).toBeVisible({ timeout: 90_000 });
    times.open.push(Date.now() - t0);
    t0 = Date.now();
    await p.getByTestId('search').fill('Запись 0777');
    await expect(p.getByTestId('entry-row')).toHaveCount(1);
    times.search.push(Date.now() - t0);
    await p.getByTestId('search').fill('');
    // E2E_PROFILE=1: профиль процессора на переходе в папку (где тратится время)
    const cdp =
      process.env.E2E_PROFILE === '1' && rep === 0 ? await p.context().newCDPSession(p) : null;
    if (cdp) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
    }
    t0 = Date.now();
    await p
      .getByTestId('branch-row')
      .getByRole('button', { name: 'Раздел 7', exact: true })
      .click();
    await expect(p.getByTestId('entry-row')).toHaveCount(125);
    times.folder.push(Date.now() - t0);
    if (cdp) {
      const { profile } = (await cdp.send('Profiler.stop')) as {
        profile: {
          nodes: {
            id: number;
            callFrame: { functionName: string; url: string; lineNumber: number };
          }[];
          samples: number[];
          timeDeltas: number[];
        };
      };
      const self = new Map<number, number>();
      profile.samples.forEach((id, i) =>
        self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)),
      );
      const top = [...self.entries()]
        .map(([id, us]) => ({ us, n: profile.nodes.find((x) => x.id === id)!.callFrame }))
        .sort((a, b) => b.us - a.us)
        .slice(0, 8)
        .map(
          (x) =>
            `${Math.round(x.us / 1000)} мс ${x.n.functionName || '(anon)'} ${x.n.url.split('/').pop()}:${x.n.lineNumber}`,
        );
      console.log('ПРОФИЛЬ\n' + top.join('\n'));
    }
    await p.context().close();
  }
  for (let rep = 0; rep < 3; rep++) {
    t0 = Date.now();
    await page.goto('/admin/users');
    await expect(page.getByTestId('user-row').first()).toBeVisible();
    // список страницами по 50: остальные подгружаются по «Дальше», а не одним ответом
    await expect(page.getByTestId('user-row')).toHaveCount(50, { timeout: 30_000 });
    await expect(page.getByTestId('users-range')).toContainText('1–50');
    await expect(page.getByTestId('users-range')).toContainText('62');
    times.users.push(Date.now() - t0);
    t0 = Date.now();
    await page.goto('/admin/circles');
    await expect(page.getByTestId('circle-Склад')).toBeVisible({ timeout: 30_000 });
    times.groups.push(Date.now() - t0);
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[1]!;
  appendFileSync(
    OUT,
    JSON.stringify({
      label: 'performance',
      entries: N,
      ...Object.fromEntries(
        Object.entries(times).map(([k, v]) => [k, { runs: v, median: med(v) }]),
      ),
    }) + '\n',
  );
  console.log(
    'нагрузка',
    JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) => [k, v]))),
  );
});

test('ноутбук 1366×768 при масштабе 100, 125 и 150 %: всё главное на экране без прокрутки вбок', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const sizes = [
    { zoom: 100, width: 1366, height: 768 },
    { zoom: 125, width: 1093, height: 614 },
    { zoom: 150, width: 911, height: 512 },
  ];
  const head = await login(browser, headEmail(4));
  await head.getByTestId('vault-select').selectOption({ label: 'Бухгалтерия' });
  await expect(head.getByTestId('entry-row').first()).toBeVisible({ timeout: 60_000 });
  await head.getByTestId('entry-row').first().click();
  // папки идут в естественном порядке: «Раздел 2» раньше «Раздел 10»
  const names = (await head.getByTestId('branch-row').allInnerTexts())
    .map((x) => /Раздел (\d+)/.exec(x)?.[1])
    .filter(Boolean)
    .map(Number);
  expect(names).toEqual([...names].sort((a, b) => a - b));
  expect(names.length).toBe(12);
  for (const z of sizes) {
    await head.setViewportSize({ width: z.width, height: z.height });
    await head.waitForTimeout(400);
    const m = await head.evaluate(() => {
      const box = (id: string) =>
        document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      const add = box('add-entry');
      const list = box('entry-row');
      const view = box('view-title');
      return {
        overflowX: document.documentElement.scrollWidth - innerWidth,
        addVisible: !!add && add.top >= 0 && add.bottom <= innerHeight && add.right <= innerWidth,
        listVisible: !!list && list.top >= 0 && list.bottom <= innerHeight,
        cardVisible:
          !!view && view.top >= 0 && view.bottom <= innerHeight && view.right <= innerWidth,
      };
    });
    console.log(`масштаб ${z.zoom}%`, JSON.stringify(m));
    await head.screenshot({ path: `docs/screenshots/ux-workspace-${z.zoom}.png` });
    expect(m.overflowX, `${z.zoom}%`).toBeLessThanOrEqual(0);
    expect(m.addVisible, `кнопка «Добавить запись» при ${z.zoom}%`).toBe(true);
    expect(m.listVisible, `список при ${z.zoom}%`).toBe(true);
  }
  await head.context().close();
});

test('увольнение руководителя с 1500 записями: последствия, блокировка, «смените пароль» — замер', async () => {
  test.setTimeout(300_000);
  const c = new Counter(page, 'Уволить руководителя отдела');
  await page.goto('/admin/users');
  // сотрудника находят поиском: на странице только первые 50
  await page.getByTestId('admin-user-search').fill(headEmail(4));
  await expect(page.getByTestId('user-row')).toHaveCount(1, { timeout: 30_000 });
  await c.click(`profile-open-${headEmail(4)}`);
  c.screen();
  await c.click('profile-offboard');
  await expect(page.getByTestId('offboarding')).toBeVisible();
  await c.click('offboarding-confirm');
  await expect(page.getByTestId('offboarding').getByRole('status')).toBeVisible({
    timeout: 120_000,
  });
  record(c);
  const users = (await api('GET', '/admin/users')).json as {
    id: string;
    email: string;
    disabled: boolean;
  }[];
  const head = users.find((u) => u.email === headEmail(4))!;
  expect(head.disabled).toBe(true);
  const card = (await api('GET', `/admin/users/${head.id}/profile`)).json as {
    rotation: { total: number; open: number; available: number } | null;
  };
  expect(card.rotation?.total).toBeGreaterThan(1500);
  expect(card.rotation?.available).toBe(card.rotation?.total);
  // уведомления — по сейфу, а не по каждой из полутора тысяч записей
  const inbox = (await api('GET', '/notifications?view=inbox')).json as {
    items: { event: string }[];
  };
  expect(inbox.items.filter((n) => n.event === 'signals.opened').length).toBeGreaterThan(0);
  expect(inbox.items.filter((n) => n.event === 'signal.create').length).toBe(0);
  // вход уволенного невозможен
  const r = await page.request.post('/api/v1/auth/login', {
    data: { email: headEmail(4), authKey: 'x'.repeat(43) },
  });
  expect([400, 401, 403]).toContain(r.status());
});

test('без защищённого контекста (http по адресу локальной сети) причина видна до ввода пароля', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ locale: 'ru-RU', baseURL: BASE });
  // имитация небезопасного адреса: Web Crypto недоступен
  await ctx.addInitScript(() =>
    Object.defineProperty(globalThis, 'isSecureContext', { value: false }),
  );
  const p = await ctx.newPage();
  await p.goto('/login');
  await expect(p.getByTestId('insecure-context')).toContainText('HTTPS');
  await expect(p.getByTestId('insecure-context')).toContainText('localhost');
  await ctx.close();
});

test('безопасность: слабые пароли отдела видны руководителю, переход к списку, сводка у главного администратора', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const hc = new TestClient(httpApp(BASE), headEmail(5), PASSWORD);
  await hc.login();
  const vault = (await hc.vaults()).find((v) => v.name === 'Финансы')!;
  const key = await hc.openVault(vault);
  const mk = (title: string, password: string) =>
    hc.createEntry(
      {
        kind: 'login',
        title,
        username: 'u',
        password,
        url: '',
        notes: '',
        totp: '',
        tags: [],
        fields: [],
        links: [],
      },
      { vaultId: vault.id, vaultKey: key },
    );
  for (const [t, p] of [
    ['Касса', '123456'],
    ['Банк', 'password'],
    ['Платёжный шлюз', 'qwerty'],
  ] as const)
    await mk(t, p);
  await mk('Отчётность', 'Correct-Horse-Battery-9!x');

  const head = await login(browser, headEmail(5));
  await head.getByTestId('vault-select').selectOption({ label: 'Финансы' });
  await expect(head.getByTestId('overview-weak')).toContainText('3');
  await expect(head.getByTestId('overview-health')).toContainText('25%');
  await head.getByTestId('overview-weak').click();
  await expect(head.getByTestId('entry-row')).toHaveCount(3);
  // отправка в события сейфа и сводка главного администратора
  await head.goto('/inspector');
  await head.getByTestId('btn-report').click();
  await expect(head.getByTestId('inspector-reported')).toBeVisible();
  await head.context().close();

  await page.goto('/admin/organization');
  // рейтинг: подразделение с событиями выше остальных; нажатие на название открывает подробности
  const rank = page.getByTestId('structure-rank-row');
  await expect(rank.first()).toBeVisible({ timeout: 30_000 });
  await expect(rank.first()).toContainText('Бухгалтерия'); // 1501 событие высокого риска после увольнения
  await rank.filter({ hasText: 'Финансы' }).getByRole('button', { name: 'Финансы' }).click();
  const row = page.getByTestId('structure-vault').filter({ hasText: 'Финансы' }).first();
  await expect(row.getByTestId('structure-security')).toContainText('3', { timeout: 30_000 });
  await page.screenshot({ path: 'docs/screenshots/ux-organization-security.png' });
});

test('доступ между отделами: временный доступ руководителю закупок на 7 дней и отзыв — замер', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const hc = new TestClient(httpApp(BASE), headEmail(10), PASSWORD); // Логистика
  await hc.login();
  const vault = (await hc.vaults()).find((v) => v.name === 'Логистика')!;
  const key = await hc.openVault(vault);
  await hc.createEntry(
    {
      kind: 'login',
      title: 'Склад-портал',
      username: 'log',
      password: 'Correct-Horse-Battery-9!x',
      url: '',
      notes: '',
      totp: '',
      tags: [],
      fields: [],
      links: [],
    },
    { vaultId: vault.id, vaultKey: key },
  );
  const head = await login(browser, headEmail(10));
  await head.getByTestId('vault-select').selectOption({ label: 'Логистика' });
  await head.getByTestId('entry-row').first().click();

  const g = new Counter(head, 'Временный доступ другому отделу на 7 дней');
  await g.click('tab-access');
  g.screen();
  await g.click('grant-open');
  await g.fill('grant-search', headEmail(11));
  await g.click(`grant-option-${headEmail(11)}`);
  await g.pick('grant-term', '7');
  await g.click('grant-submit');
  const row = head.getByTestId('entry-access-grant').filter({ hasText: headEmail(11) });
  await expect(row).toHaveCount(1);
  // срок виден прямо в строке назначения
  await expect(row.getByTestId('grant-expiry')).not.toHaveValue('');
  record(g);

  const r = new Counter(head, 'Отозвать выданный доступ');
  head.once('dialog', (d) => void d.accept());
  r.clicks++;
  await row.getByRole('button', { name: /Отозвать|Revoke/ }).click();
  await expect(
    head.getByTestId('entry-access-grant').filter({ hasText: headEmail(11) }),
  ).toHaveCount(0);
  record(r);
  await head.context().close();
});

test('формы записей разных типов помещаются на экране ноутбука', async ({ browser }) => {
  test.setTimeout(300_000);
  const head = await login(browser, headEmail(5));
  await head.setViewportSize({ width: 1366, height: 768 });
  await head.getByTestId('vault-select').selectOption({ label: 'Финансы' });
  const rows: string[] = [];
  head.on('dialog', (d) => void d.accept().catch(() => undefined));
  for (const kind of ['login', 'server', 'apikey', 'note', 'custom']) {
    await head.getByTestId('add-entry').click();
    const k = head.getByTestId(`f-kind-${kind}`);
    await k.click();
    await expect(k).toHaveAttribute('aria-checked', 'true');
    const m = await head.evaluate(() => {
      const form = document.querySelector('[data-testid="entry-form"]') as HTMLElement | null;
      const save = document.querySelector('[data-testid="f-save"]')?.getBoundingClientRect();
      const visible = [
        ...(form?.querySelectorAll(
          'input:not([type=checkbox]):not([type=radio]), textarea, select',
        ) ?? []),
      ].filter((e) => (e as HTMLElement).offsetParent !== null).length;
      return {
        saveVisible: !!save && save.bottom <= innerHeight && save.top >= 0,
        fields: visible,
        scroll: (form?.scrollHeight ?? 0) - (form?.clientHeight ?? 0),
      };
    });
    rows.push(
      `${kind}: полей на экране ${m.fields}, «Сохранить» ${m.saveVisible ? 'виден' : 'ниже экрана'}, прокрутка формы ${Math.max(0, m.scroll)} px`,
    );
    await head.screenshot({ path: `docs/screenshots/ux-form-${kind}.png` });
    expect(m.saveVisible, kind).toBe(true);
    await head.keyboard.press('Escape');
    await expect(head.getByTestId('f-title')).toHaveCount(0);
  }
  console.log(rows.join('\n'));
  await head.context().close();
});

test('приглашение списком: 12 сотрудников в разные отделы за одно действие — замер', async () => {
  test.setTimeout(300_000);
  const c = new Counter(page, 'Пригласить 12 сотрудников списком');
  await c.click('menu-toggle');
  await c.click('menu-full');
  await c.click('admin-tab-invitations');
  c.screen();
  await c.click('bulk-invite');
  const lines = Array.from({ length: 12 }, (_, i) => {
    const dept = DEPARTMENTS[i + 1]!;
    return `Сотрудник ${String(i + 1).padStart(2, '0')}; bulk${String(i + 1).padStart(2, '0')}@corp.example; ${dept}`;
  });
  await c.fill('bulk-invite-text', lines.join('\n'));
  await expect(page.getByTestId('bulk-invite-row')).toHaveCount(12);
  await c.click('bulk-invite-go');
  await expect(page.getByTestId('bulk-invite-state').filter({ hasText: 'создано' })).toHaveCount(
    12,
    {
      timeout: 60_000,
    },
  );
  record(c);
  const csv = page.waitForEvent('download');
  await page.getByTestId('bulk-invite-csv').click();
  const text = readFileSync(await (await csv).path(), 'utf8');
  expect(text.split('\n')).toHaveLength(13);
  expect(text).toMatch(/bulk01@corp.example/);

  // ошибки до отправки: неверная почта, неизвестная группа, повтор
  await page
    .getByTestId('bulk-invite-text')
    .fill(
      'Иван; not-an-email; ИТ\nПётр; bulk99@corp.example; Нет такой\nПётр; bulk99@corp.example',
    );
  await expect(page.getByTestId('bulk-invite-go')).toBeDisabled();
  await expect(page.getByTestId('bulk-invite-state').nth(0)).toContainText('неверная почта');
  await expect(page.getByTestId('bulk-invite-state').nth(1)).toContainText('группа не найдена');
  await expect(page.getByTestId('bulk-invite-state').nth(2)).toContainText('повтор');

  // CSV: пример скачивается, файл с заголовками разбирается по столбцам, группы берутся из department и groups
  const sample = page.waitForEvent('download');
  await page.getByTestId('bulk-invite-sample').click();
  const sampleText = readFileSync(await (await sample).path(), 'utf8');
  expect(sampleText).toContain('username,first_name,last_name,email,department,groups');
  await page.getByTestId('bulk-invite-file').setInputFiles({
    name: 'users.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `username,first_name,last_name,email,department,groups\nivanov,Иван,Иванов,csv01@corp.example,${DEPARTMENTS[0]},${DEPARTMENTS[1]}\npetrova,Анна,Петрова,csv02@corp.example,${DEPARTMENTS[2]},\n`,
    ),
  });
  await expect(page.getByTestId('bulk-invite-row')).toHaveCount(2);
  await expect(page.getByTestId('bulk-invite-row').nth(0)).toContainText('Иван Иванов');
  await expect(page.getByTestId('bulk-invite-row').nth(0)).toContainText(
    `${DEPARTMENTS[0]} | ${DEPARTMENTS[1]}`,
  );
  await expect(page.getByTestId('bulk-invite-go')).toBeEnabled();
  // файл без столбца почты отклоняется
  await page.getByTestId('bulk-invite-file').setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,phone\nИван,123\n'),
  });
  await expect(page.getByTestId('bulk-invite-error')).toContainText('email');

  // приглашения созданы, группа привязана к приглашению
  const inv = (await api('GET', '/admin/invitations')).json as { email: string; status: string }[];
  expect(inv.filter((x) => x.email.startsWith('bulk') && x.status === 'pending')).toHaveLength(12);
});

test('поиск находит запись в другом сейфе без переключения отдела', async ({ browser }) => {
  test.setTimeout(300_000);
  const hc = new TestClient(httpApp(BASE), headEmail(5), PASSWORD);
  await hc.login();
  const lead = (await hc.vaults()).find((v) => v.name === 'Финансы · Руководство')!;
  const key = await hc.openVault(lead);
  await hc.createEntry(
    {
      kind: 'login',
      title: 'Совет директоров',
      username: 'board',
      password: 'Correct-Horse-Battery-9!x',
      url: '',
      notes: '',
      totp: '',
      tags: [],
      fields: [],
      links: [],
    },
    { vaultId: lead.id, vaultKey: key },
  );
  const head = await login(browser, headEmail(5));
  await head.getByTestId('vault-select').selectOption({ label: 'Финансы' });
  const t0 = Date.now();
  await head.getByTestId('search').fill('Совет директоров');
  await expect(head.getByTestId('global-search-result')).toHaveCount(1, { timeout: 30_000 });
  console.log(`Поиск по всем сейфам: ${Date.now() - t0} мс`);
  await expect(head.getByTestId('global-search-result')).toContainText('Руководство');
  await head.getByTestId('global-search-result').click();
  await expect(head.getByTestId('view-title')).toHaveText('Совет директоров');
  await expect(head.getByTestId('vault-select').locator('option:checked')).toContainText(
    'Руководство',
  );
  await head.context().close();
});

test('несколько главных администраторов: приглашение, подтверждение мастер-паролем, отзыв роли', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  await page.goto('/admin/organization');
  await expect(page.getByTestId('chief-row')).toHaveCount(1);
  await page.getByTestId('chief-add').click();
  await page.getByTestId('chief-add-person-input').fill(headEmail(1));
  await page.getByTestId(`chief-add-person-result-${headEmail(1)}`).click();
  await page.getByTestId('chief-add-password').fill(ADMIN.password);
  await page.getByTestId('chief-add-send').click();
  await expect(page.getByTestId('chief-offers')).toBeVisible();
  // роль не появляется без подтверждения самим сотрудником
  await expect(page.getByTestId('chief-row')).toHaveCount(1);

  const guest = await login(browser, headEmail(1));
  await guest.goto('/security');
  await expect(guest.getByTestId('chief-offer-card')).toBeVisible({ timeout: 30_000 });
  await guest.getByTestId('chief-accept-password').fill(PASSWORD);
  await guest.getByTestId('chief-accept').click();
  await expect(guest.getByTestId('chief-accepted')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('chief-row')).toHaveCount(2, { timeout: 30_000 });
  // отзыв роли у второго: он остаётся полным администратором, главный остаётся один
  await page.getByTestId(`chief-remove-${headEmail(1)}`).click();
  await page.getByTestId('chief-remove-password').fill(ADMIN.password);
  await page.getByTestId('chief-remove-password').press('Enter');
  await expect(page.getByTestId('chief-row')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId(`chief-remove-${ADMIN.email}`)).toBeDisabled();
  await guest.context().close();
});

test('два режима персональных сейфов: сотрудник видит условия, хранители получают доступ, администратор видит тип в инвентаризации', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  // администратор включает режим и выбирает группу-хранителя
  await page.goto('/admin/settings?section=storage');
  await expect(page.getByTestId('managed-settings')).toBeVisible();
  await page.getByTestId('managed-enabled').check();
  await page.getByTestId('managed-guardians-pick-input').fill('Информационная');
  await page.getByTestId('managed-guardians-pick-result-Информационная безопасность').click();
  await page.getByTestId('managed-save').click();
  await expect(page.getByTestId('managed-settings').getByRole('status')).toBeVisible();

  // сотрудник: условия показаны до создания, без подтверждения создать нельзя
  const emp = await login(browser, staffEmail(9));
  await emp.getByTestId('vault-actions').click();
  await emp.getByTestId('btn-new-managed').click();
  await expect(emp.getByTestId('managed-guardians')).toContainText('Информационная безопасность');
  await expect(emp.getByTestId('managed-create')).toBeDisabled();
  await emp.getByTestId('managed-understood').check();
  await emp.getByTestId('managed-create').click();
  await expect(emp.getByTestId('managed-dialog')).toHaveCount(0, { timeout: 90_000 });
  await expect(emp.getByTestId('vault-select')).toContainText('Персональный');
  // повторно пункт не предлагается; в настройках сейфа условие названо и не снимается владельцем
  await emp.getByTestId('vault-actions').click();
  await expect(emp.getByTestId('btn-new-managed')).toHaveCount(0);
  await emp.keyboard.press('Escape');
  await emp.getByTestId('vault-actions').click();
  await emp.getByTestId('btn-vault-settings').click();
  await expect(emp.getByTestId('managed-banner')).toContainText('Информационная безопасность');
  await expect(emp.getByTestId('circle-row').getByRole('button')).toHaveCount(0);
  await emp.context().close();

  // инвентаризация главного администратора: тип и хранители, без содержимого
  await page.goto('/admin/vaults');
  await page.getByTestId('vaults-kind-managed').click();
  await expect(page.getByTestId('vault-row')).toHaveCount(1);
  await expect(page.getByTestId('vault-row')).toContainText('Информационная безопасность');
  await page.getByTestId('vaults-kind-private').click();
  await expect(page.getByTestId('vaults-range')).toBeVisible();
});

test('ссылка на запись: кнопка копирует адрес, у коллеги с доступом запись открывается, у остальных — нет, и это неотличимо от несуществующей', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const hc = new TestClient(httpApp(BASE), headEmail(5), PASSWORD);
  await hc.login();
  const lead = (await hc.vaults()).find((v) => v.name === 'Финансы · Руководство')!;
  const key = await hc.openVault(lead);
  const made = await hc.createEntry(
    {
      kind: 'login',
      title: 'Ссылочная запись',
      username: 'link',
      password: 'Correct-Horse-Battery-9!y',
      url: '',
      notes: '',
      totp: '',
      tags: [],
      fields: [],
      links: [],
    },
    { vaultId: lead.id, vaultKey: key },
  );
  const code = made.entryId.replace(/-/g, '').slice(0, 12);

  const head = await login(browser, headEmail(5));
  // ссылка открывает запись сразу, в том числе из другого пространства
  await head.goto(`/e/${code}`);
  await expect(head.getByText('Ссылочная запись').first()).toBeVisible({ timeout: 60_000 });
  await head.evaluate(() => {
    (window as unknown as { copied: string }).copied = '';
    navigator.clipboard.writeText = (v: string) => {
      (window as unknown as { copied: string }).copied = v;
      return Promise.resolve();
    };
  });
  await head.getByTestId('btn-copy-link').click();
  const copied = await head.evaluate(() => (window as unknown as { copied: string }).copied);
  expect(copied).toBe(`${BASE}/e/${code}`);
  await head.context().close();

  // сотрудник другого отдела: то же сообщение, что и для несуществующего кода
  const other = await login(browser, staffEmail(0));
  await other.goto(`/e/${code}`);
  await expect(other.getByTestId('entry-link-missing')).toBeVisible({ timeout: 30_000 });
  await other.goto('/e/000000000000');
  await expect(other.getByTestId('entry-link-missing')).toBeVisible();
  await other.context().close();

  // до входа: после входа человек попадает на запись, а не на общий список
  const guest = await (await browser.newContext({ locale: 'ru-RU', baseURL: BASE })).newPage();
  await guest.goto(`/e/${code}`);
  await guest.getByTestId('email').fill(headEmail(5));
  await guest.getByTestId('password').fill(PASSWORD);
  await guest.getByTestId('submit').click();
  await expect(guest.getByText('Ссылочная запись').first()).toBeVisible({ timeout: 90_000 });
  await guest.context().close();
});

test('справка: темы по задачам, поиск, административные темы видны только администратору', async ({
  browser,
}) => {
  await page.goto('/help');
  await expect(page.getByTestId('help-topic-user-twoFactor')).toContainText('Яндекс Ключ');
  await expect(page.getByTestId('help-topic-admin-firstSetup')).toBeVisible();
  // поиск оставляет только подходящие темы
  await page.getByTestId('help-search').fill('LDAPS');
  await expect(page.getByTestId('help-topic-admin-directory')).toBeVisible();
  await expect(page.getByTestId('help-topic-user-twoFactor')).toHaveCount(0);
  await page.getByTestId('help-search').fill('такого-слова-нет-нигде');
  await expect(page.getByRole('status')).toBeVisible();

  const staff = await login(browser, staffEmail(3));
  await staff.goto('/help');
  await expect(staff.getByTestId('help-topic-user-firstLogin')).toBeVisible();
  await expect(staff.getByTestId('help-topic-admin-firstSetup')).toHaveCount(0);
  await staff.context().close();
});

test('«Мастера настройки»: точка входа к сложным операциям и переход к нужному разделу', async () => {
  await page.goto('/admin/wizards');
  await expect(page.getByTestId('wizards')).toBeVisible();
  for (const id of ['setup', 'dept', 'people', 'ldap', 'backup', 'recovery'])
    await expect(page.getByTestId(`wizard-${id}`)).toBeVisible();
  // три сценария показывают фактическое состояние шагов, а не только ссылку на раздел
  await expect(page.getByTestId('wizard-progress')).toHaveCount(3);
  await expect(page.getByTestId('wizards')).toContainText(/Готово \d+ из 4/);
  await page.getByTestId('wizard-dept').click();
  await expect(page).toHaveURL(/\/admin\/departments$/);
  await expect(page.getByTestId('departments')).toBeVisible();
});

test('визуальный аудит: экраны администрирования, переноса и справки на шести размерах без прокрутки вбок', async () => {
  test.setTimeout(600_000);
  const pages = [
    '/admin/overview',
    '/admin/users',
    '/admin/departments',
    '/admin/wizards',
    '/admin/vaults',
    '/admin/organization',
    '/admin/settings?section=security',
    '/admin/resources',
    '/admin/containers',
    '/admin/certificates',
    '/admin/updates',
    '/admin/logs',
    '/admin/transfer?tab=export',
    '/admin/transfer?tab=import',
    '/help',
    '/',
  ];
  const sizes: [number, number][] = [
    [1280, 800],
    [1366, 768],
    [1440, 900],
    [1512, 982],
    [1920, 1080],
    [390, 844],
  ];
  const wide: string[] = [];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    for (const url of pages) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (over > 0) wide.push(`${w}×${h} ${url}: +${over}px`);
      if (
        w === 1366 &&
        [
          '/admin/overview',
          '/admin/wizards',
          '/admin/resources',
          '/admin/transfer?tab=export',
          '/help',
          '/admin/vaults',
        ].includes(url)
      )
        await page.screenshot({
          path: `docs/screenshots/ux-${url.replace(/[/?=]+/g, '-').replace(/^-|-$/g, '')}.png`,
        });
    }
  }
  expect(wide, wide.join('\n')).toEqual([]);

  // четыре темы: страницы остаются читаемыми и не ломают раскладку
  await page.setViewportSize({ width: 1366, height: 768 });
  const broken: string[] = [];
  for (const theme of ['glass', 'night', 'grove', 'aurora']) {
    for (const url of ['/admin/overview', '/admin/transfer?tab=export', '/help']) {
      await page.goto(url);
      await page.evaluate((id) => {
        document.documentElement.dataset.theme = id;
        document.documentElement.classList.toggle('dark', ['night', 'aurora'].includes(id));
      }, theme);
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      const color = await page.evaluate(() => {
        const cs = getComputedStyle(document.body);
        return [cs.color, cs.backgroundColor];
      });
      // текст и фон не совпадают (иначе страница пустая на вид)
      if (over > 0 || color[0] === color[1]) broken.push(`${theme} ${url}`);
    }
  }
  expect(broken, broken.join('\n')).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('мой аккаунт: профиль только для чтения, вход и безопасность, дополнительные возможности отдельно', async ({
  browser,
}) => {
  const staff = await login(browser, staffEmail(4));
  await staff.getByTestId('menu-toggle').click();
  await staff.getByTestId('menu-profile').click();
  await expect(staff.getByTestId('profile-card')).toBeVisible();
  await expect(staff.getByTestId('profile-email')).toHaveText(staffEmail(4));
  await expect(staff.getByTestId('profile-source')).toHaveText('Локальная');
  // вход и безопасность — прежняя страница: сеансы, второй фактор, смена пароля
  await staff.getByTestId('account-tab-security').click();
  await expect(staff.getByTestId('sessions')).toBeVisible();
  await expect(staff.getByTestId('tokens-section')).toHaveCount(0);
  // токены API и командная строка — отдельно, с объяснением
  await staff.getByTestId('account-tab-advanced').click();
  await expect(staff.getByTestId('account-advanced')).toContainText('Токены API');
  await expect(staff.getByTestId('tokens-section')).toBeVisible();
  await staff.context().close();
});
