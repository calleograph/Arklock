import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

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
  await expect(page.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  if (setup) {
    const token = await page.evaluate(() => sessionStorage.getItem('arklock.token'));
    const policy = await page.request.put('/api/v1/admin/settings', {
      headers: { authorization: `Bearer ${token}` },
      data: { 'vaults.personalLockers': true },
    });
    expect(policy.status()).toBe(200);
    await page.getByTestId('menu-toggle').click();
    await page.getByTestId('menu-settings').click();
    await page.getByTestId('menu-toggle').click();
    await page.getByTestId('menu-vault').click();
    await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
  }
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

/** Крупный файл: загрузка и скачивание порциями, содержимое совпадает побайтно (проверка SHA-256). */
async function bigFileRoundTrip(page: Page): Promise<void> {
  const size = 40 * 1024 * 1024 + 320;
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4) buf.writeUInt32LE((i * 2654435761) >>> 0, i);
  const want = createHash('sha256').update(buf).digest('hex');
  await page.getByTestId('tab-files').click();
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: buf });
  await expect(page.getByTestId('file-row').filter({ hasText: 'big.bin' })).toBeVisible({
    timeout: 180_000,
  });
  const row = page.getByTestId('file-row').filter({ hasText: 'big.bin' });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    row.getByTestId('file-download').click(),
  ]);
  expect(download.suggestedFilename()).toBe('big.bin');
  const got = readFileSync((await download.path())!);
  expect(got.length).toBe(size);
  expect(createHash('sha256').update(got).digest('hex')).toBe(want);
  // удалить, чтобы не мешать дальнейшим шагам (ротация перешифровывает все файлы)
  await row.getByTestId('file-remove').click();
  await row.getByTestId('file-remove').click();
  await expect(page.getByTestId('file-row').filter({ hasText: 'big.bin' })).toHaveCount(0);
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
    .getByRole('button', { name: 'Финансы', exact: true })
    .click();
  await newFolder(page, 'Банки');
  await page.getByTestId('branch-row').getByRole('button', { name: 'Банки', exact: true }).click();

  // запись типа «сервер» с TOTP, генератором, дополнительным полем и метками
  await page.getByTestId('add-entry').click();
  await page.getByTestId('f-kind-server').click();
  await page.getByTestId('f-title').fill('Сервер банка');
  await page.getByTestId('f-username').fill('root');
  await page.getByTestId('btn-generate').click();
  await expect(page.getByTestId('strength')).toBeVisible();
  const generated = await page.getByTestId('f-password').inputValue();
  expect(generated).toHaveLength(20);
  await page.getByTestId('f-more').evaluate((d) => ((d as HTMLDetailsElement).open = true));
  await page.getByTestId('f-totp').fill('JBSWY3DPEHPK3PXP');
  await page.getByTestId('btn-add-field').click();
  await page.getByTestId('field-name-0').fill('IP');
  await page.getByTestId('field-value-0').fill('203.0.113.7');
  await page.getByTestId('btn-add-field').click();
  await page.getByTestId('field-name-1').fill('PIN');
  await page.getByTestId('field-type-password-1').click();
  await expect(page.getByTestId('field-value-1')).toHaveAttribute('type', 'password');
  await page.getByTestId('field-value-1').fill('4242');
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
  await page.getByTestId('tab-journal').click();
  // открытие карточки — отдельное событие журнала, отмеченное как сообщённое клиентом
  await expect(
    page.getByTestId('entry-journal-row').filter({ hasText: 'Card opened' }).first(),
  ).toBeVisible();
  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('history-row')).toHaveCount(1);
  await page.getByTestId('btn-revert').click();
  await expect(page.getByTestId('btn-revert')).toHaveCount(0);
  await page.getByTestId('tab-details').click();
  await page.getByTestId('btn-reveal').click();
  await expect(page.getByTestId('view-password')).toHaveText('Tr0ub4dor&3-qq');

  // корзина и восстановление
  await page.getByTestId('entry-actions').click();
  await page.getByTestId('btn-trash').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await page.getByTestId('scope-trash').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await page.getByTestId('entry-row').click();
  await page.getByTestId('restore-entry').click();
  await page.getByTestId('scope-all').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(2);

  // связь записей: в карточке появляется переход к другой записи, он открывает её
  await page.getByTestId('entry-row').first().click();
  const firstTitle = await page.getByTestId('view-title').innerText();
  await page.getByTestId('btn-edit').click();
  await page.getByTestId('f-more').evaluate((d) => ((d as HTMLDetailsElement).open = true));
  await page.getByTestId('f-link-select').selectOption({ index: 1 });
  await page.getByTestId('btn-add-link').click();
  await page.getByTestId('f-save').click();
  await expect(page.getByTestId('link-open')).toHaveCount(1);
  await page.getByTestId('link-open').click();
  await expect(page.getByTestId('view-title')).not.toHaveText(firstTitle);

  // архив: запись уходит из обычного списка и возвращается
  await page.getByTestId('btn-archive').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await page.getByTestId('scope-archive').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await page.getByTestId('entry-row').click();
  await page.getByTestId('btn-archive').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(0);
  await page.getByTestId('scope-all').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(2);

  // массовое перемещение
  await page.getByTestId('select-all').check();
  await page.getByTestId('bulk-target').selectOption({ label: 'Финансы' });
  await page.getByTestId('bulk-move').click();
  await page
    .getByTestId('branch-row')
    .getByRole('button', { name: 'Финансы', exact: true })
    .click();
  await expect(page.getByTestId('entry-row')).toHaveCount(2);

  // архив папки: все её записи уходят в архив одним действием и возвращаются так же
  await page.getByTestId('folder-menu-Финансы').click();
  await page.getByTestId('folder-archive').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(0);
  await page.getByTestId('scope-archive').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(2);
  await page.getByTestId('folder-menu-Финансы').click();
  await page.getByTestId('folder-unarchive').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(0);
  await page.getByTestId('scope-all').click();

  // подпапка из меню папки создаётся внутри неё (вложенность без искусственного предела)
  await page.getByTestId('folder-menu-Банки').click();
  await page.getByTestId('folder-subfolder').click();
  await page.getByTestId('name-input').fill('Production');
  await page.getByTestId('name-ok').click();
  const prod = page.getByTestId('branch-row').filter({ hasText: 'Production' });
  await expect(prod).toBeVisible();
  // отступ больше, чем у родителя: папка вложена, а не создана в корне
  const pad = (l: typeof prod) => l.evaluate((el) => parseInt(getComputedStyle(el).paddingLeft));
  expect(await pad(prod)).toBeGreaterThan(
    await pad(page.getByTestId('branch-row').filter({ hasText: 'Банки' }).first()),
  );

  // значок папки: выбор из каталога с цветом, хранится зашифрованным и виден после F5
  await page.getByTestId('folder-menu-Банки').click();
  await page.getByTestId('folder-icon').click();
  await page.getByTestId('icon-search').fill('банк');
  await page.getByTestId('icon-bank').click();
  await page.getByTestId('icon-color-green').click();
  await page.getByTestId('folder-icon-save').click();
  const bankIcon = page
    .getByTestId('branch-row')
    .filter({ hasText: 'Банки' })
    .first()
    .getByTestId('object-icon')
    .locator('svg');
  await expect(bankIcon).toHaveClass(/text-emerald/);
  await page.reload();
  await expect(bankIcon).toHaveClass(/text-emerald/, { timeout: 30_000 });

  // значок записи — в её зашифрованных данных; виден в списке
  await page.getByTestId('entry-row').filter({ hasText: 'Почта' }).click();
  await page.getByTestId('btn-edit').click();
  await page.getByTestId('f-icon').click();
  await page.getByTestId('icon-mail').click();
  await page.getByTestId('f-save').click();
  await expect(
    page
      .getByTestId('entry-row')
      .filter({ hasText: 'Почта' })
      .getByTestId('object-icon')
      .locator('svg'),
  ).toBeVisible();

  // меню записи по правой кнопке: избранное без открытия карточки. «Почта» уже в избранном
  // (отмечена выше), поэтому пункт сначала убирает её оттуда, а повторный — возвращает
  const mailRow = page.getByTestId('entry-row').filter({ hasText: 'Почта' });
  await mailRow.click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await expect(page.getByTestId('ctx-pin')).toHaveText(/Убрать|Remove/);
  await page.getByTestId('ctx-pin').click();
  await expect(page.getByTestId('context-menu')).toHaveCount(0);
  await page.getByTestId('scope-favorites').click();
  await expect(mailRow).toHaveCount(0);
  await page.getByTestId('scope-all').click();
  await mailRow.click({ button: 'right' });
  await expect(page.getByTestId('ctx-pin')).toHaveText(/В избранное|Add to/);
  await page.getByTestId('ctx-pin').click();
  await page.getByTestId('scope-favorites').click();
  await expect(mailRow).toHaveCount(1);
  await page.getByTestId('scope-all').click();
  // «Изменить» из меню открывает форму записи сразу
  await mailRow.click({ button: 'right' });
  await page.getByTestId('ctx-edit').click();
  await expect(page.getByTestId('f-title')).toHaveValue('Почта');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('entry-form')).toHaveCount(0);

  // сводка сейфа: показатель ведёт к отфильтрованному списку, фильтр в адресе и сбрасывается
  await addEntry(page, { title: 'Слабый доступ', username: 'w', password: '123456' });
  await page.goto('/');
  await page.getByTestId('overview-weak').click();
  await expect(page.getByTestId('issue-filter')).toBeVisible();
  await expect(page).toHaveURL(/issue=weak/);
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await expect(page.getByTestId('entry-row')).toContainText('Слабый доступ');
  await page.getByTestId('issue-filter-clear').click();
  await expect(page.getByTestId('issue-filter')).toHaveCount(0);
  expect(await page.getByTestId('entry-row').count()).toBeGreaterThan(1);

  // метка проблемы в строке; копия записи из меню, затем корзина и удаление навсегда из меню
  const weakRow = page.getByTestId('entry-row').filter({ hasText: 'Слабый доступ' });
  await expect(weakRow.getByTestId('row-issue')).toBeVisible();
  await weakRow.click({ button: 'right' });
  await page.getByTestId('ctx-clone').click();
  await expect(page.getByTestId('f-title')).toHaveValue(/^Слабый доступ \(/);
  await page.getByTestId('f-save').click();
  const copyRow = page.getByTestId('entry-row').filter({ hasText: /Слабый доступ \(/ });
  await expect(copyRow).toHaveCount(1);
  await expect(copyRow.getByTestId('row-issue')).toBeVisible();
  await copyRow.click({ button: 'right' });
  await page.getByTestId('ctx-trash').click();
  await expect(copyRow).toHaveCount(0);
  await page.getByTestId('scope-trash').click();
  await copyRow.click({ button: 'right' });
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('ctx-purge').click();
  await expect(copyRow).toHaveCount(0);
  await page.getByTestId('scope-all').click();

  // «Новая запись в этой папке» из меню другой папки: форма открывается и остаётся открытой
  await page.getByTestId('folder-menu-Банки').click();
  await page.getByTestId('folder-add-entry').click();
  await page.getByTestId('f-title').fill('Запись в папке');
  await page.getByTestId('f-save').click();
  await expect(page.getByTestId('view-title')).toHaveText('Запись в папке');
  await expect(page.getByTestId('entry-row').filter({ hasText: 'Запись в папке' })).toContainText(
    'Банки',
  );
  // щелчок по уже выбранной папке закрывает запись и показывает панель папки
  await page.getByTestId('branch-row').filter({ hasText: 'Банки' }).first().click();
  await expect(page.getByTestId('folder-panel')).toBeVisible();
  await page.getByTestId('scope-all').click();
});

test('a one-time link opens once, anonymously', async ({ browser }) => {
  const page = adminPage;
  await page.getByTestId('entry-row').filter({ hasText: 'Почта' }).click();
  await page.getByTestId('tab-access').click();
  await page.getByTestId('tab-share').click();
  await page.getByTestId('share-views').selectOption('1');
  // кнопка включается, когда форма готова; без ожидания клик мог попасть в отрисовку вкладки
  await expect(page.getByTestId('btn-create-link')).toBeEnabled();
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
  await page.getByTestId('vault-actions').click();
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
  await page.getByTestId('vault-actions').click();
  await page.getByTestId('btn-inspector').click();
  await expect(page.getByTestId('count-weak')).not.toHaveText('0');
  await expect(page.getByTestId('count-reused')).toHaveText('2');
  expect(bodies.join('')).not.toContain('Zq8!vN3');
});

test('a second user joins a shared vault; revoking access and rotating the key', async ({
  browser,
}: {
  browser: Browser;
}) => {
  // шифрование и расшифровка файла в 40 МиБ на медленном исполнителе CI занимают минуты
  test.setTimeout(420_000);
  const page = adminPage;
  // администратор открывает регистрацию в настройках
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();
  await page.getByTestId('admin-tab-settings').click();
  await page.getByTestId('set-registration').selectOption('open');

  memberPage = await (await browser.newContext()).newPage();
  await register(memberPage, MEMBER);

  // администратор создаёт общее хранилище
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-vault').click();
  await expect(page.getByTestId('vault-select')).toBeVisible();
  await page.getByTestId('vault-actions').click();
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
  await bigFileRoundTrip(page);

  // добавление участника
  await page.getByTestId('vault-actions').click();
  await page.getByTestId('btn-vault-settings').click();
  // единое окно «Предоставить доступ»: поиск сотрудника, уровень, одно действие
  await page.getByTestId('grant-open').click();
  await page.getByTestId('grant-search').fill('member');
  await page.getByTestId(`grant-option-${MEMBER.email}`).click();
  await expect(page.getByTestId('grant-chip')).toHaveCount(1);
  await page.getByTestId('grant-level').selectOption('builtin:editor');
  await page.getByTestId('grant-submit').click();
  await expect(page.getByTestId('grant-dialog')).not.toBeVisible();
  await expect(page.getByTestId('member-row').filter({ hasText: MEMBER.email })).toContainText(
    /выдан|issued/,
  );

  // то же окно на уровне записи: участник помечен «уже есть доступ», правило назначается одним действием
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-vault').click();
  await page.getByTestId('entry-row').filter({ hasText: 'Общий сервер' }).click();
  await page.getByTestId('tab-access').click();
  await page.getByTestId('grant-open').click();
  await page.getByTestId('grant-search').fill('member');
  await expect(page.getByTestId(`grant-option-${MEMBER.email}`)).toContainText(
    /уже есть доступ|already has access/,
  );
  await page.getByTestId(`grant-option-${MEMBER.email}`).click();
  await page.getByTestId('grant-submit').click();
  await expect(page.getByTestId('grant-notice')).toBeVisible();
  await expect(page.getByTestId('entry-access-grant').filter({ hasText: MEMBER.name })).toHaveCount(
    1,
  );
  // срок правила меняется на месте и снимается очисткой даты
  const memberRule = page.getByTestId('entry-access-grant').filter({ hasText: MEMBER.name });
  const day = new Date(Date.now() + 5 * 86_400_000);
  const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  await memberRule.getByTestId('grant-expiry').fill(ymd);
  await expect(memberRule.getByTestId('grant-expiry')).toHaveValue(ymd);
  await memberRule.getByTestId('grant-expiry').fill('');
  await expect(memberRule.getByTestId('grant-expiry')).toHaveValue('');

  // участник видит хранилище и запись, читает её
  await memberPage.reload();
  await expect(memberPage.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  await memberPage.getByTestId('vault-select').selectOption({ label: 'Команда' });
  await expect(memberPage.getByTestId('entry-row')).toHaveCount(1, { timeout: 30_000 });
  await memberPage.getByTestId('entry-row').click();
  await memberPage.getByTestId('btn-reveal').click();
  await expect(memberPage.getByTestId('view-password')).toHaveText('Shared-Secret-77!aa');
  expect(await downloadText(memberPage)).toBe(FILE_TEXT);

  // отзыв доступа и ротация ключа
  await page.getByTestId('vault-actions').click();
  await page.getByTestId('btn-vault-settings').click();
  await page.getByTestId(`remove-${MEMBER.email}`).click();
  await expect(page.getByTestId('rotation-hint')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('btn-rotate-hint').click();
  await expect(page.getByTestId('settings-notice')).toBeVisible({ timeout: 90_000 });
  await memberPage.reload();
  await expect(memberPage.getByTestId('vault-select')).toBeVisible({ timeout: 90_000 });
  await expect(
    memberPage.getByTestId('vault-select').locator('option', { hasText: 'Команда' }),
  ).toHaveCount(0);

  // данные после ротации открываются администратором
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-vault').click();
  await expect(page.getByTestId('entry-row').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('entry-row').first().click();
  // после ротации ключа файл открывается новым ключом и содержимое прежнее
  expect(await downloadText(page)).toBe(FILE_TEXT);
  for (const f of storedFiles())
    expect(readFileSync(f).includes(Buffer.from(FILE_TEXT))).toBe(false);
  void login;
});

/** Второй корпоративный сейф «Цель» (создаётся в сценарии переноса): личные сейфы по умолчанию выключены. */
const targetVault = (sel: Locator, name = 'Цель') =>
  sel
    .locator('option', { hasText: name })
    .getAttribute('value')
    .then((v) => v!);

test('an entry moves to another vault: re-encrypted for the target, the source copy goes to the trash', async ({
  browser,
}) => {
  // самостоятельный сценарий: первая запись создаёт администратора, иначе выполняется вход
  const page = await (await browser.newContext({ locale: 'ru-RU' })).newPage();
  await page.goto('/');
  if (
    await page
      .getByTestId('name')
      .waitFor({ timeout: 4000 })
      .then(
        () => true,
        () => false,
      )
  ) {
    await register(page, ADMIN, SETUP);
  } else {
    await login(page, ADMIN);
  }
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-vault').click();
  await expect(page.getByTestId('vault-select')).toBeVisible();
  await page.getByTestId('vault-actions').click();
  await page.getByTestId('btn-new-vault').click();
  await page.getByTestId('name-input').fill('Цель');
  await page.getByTestId('name-ok').click();
  await expect(page.getByTestId('vault-select').locator('option:checked')).toHaveText('Цель');
  await page.getByTestId('vault-actions').click();
  await page.getByTestId('btn-new-vault').click();
  await page.getByTestId('name-input').fill('Перенос');
  await page.getByTestId('name-ok').click();
  await expect(page.getByTestId('vault-select').locator('option:checked')).toHaveText('Перенос');
  await addEntry(page, {
    title: 'Переносимая запись',
    username: 'mover',
    password: 'Move-Secret-42!bb',
  });

  await page.getByTestId('entry-row').filter({ hasText: 'Переносимая запись' }).click();
  await page.getByTestId('entry-actions').click();
  await page.getByTestId('entry-move').click();
  await page.getByTestId('move-target').selectOption({ label: 'Цель' });
  await page.getByTestId('btn-move').click();
  await expect(page.getByTestId('entry-row').filter({ hasText: 'Переносимая запись' })).toHaveCount(
    0,
  );

  // исходная копия в корзине сейфа «Перенос»
  await page.getByTestId('scope-trash').click();
  await expect(page.getByTestId('entry-row').filter({ hasText: 'Переносимая запись' })).toHaveCount(
    1,
  );
  await page.getByTestId('scope-all').click();

  // в личном сейфе запись открывается тем же паролем: её перешифровали ключом целевого сейфа
  await page.getByTestId('vault-select').selectOption({ label: 'Цель' });
  await page.getByTestId('entry-row').filter({ hasText: 'Переносимая запись' }).click();
  await page.getByTestId('btn-reveal').click();
  await expect(page.getByTestId('view-password')).toHaveText('Move-Secret-42!bb');
});

test('the generator follows the chosen options; the generated password is saved and opens', async () => {
  const page = adminPage;
  await page.getByTestId('add-entry').click();
  await page.getByTestId('f-title').fill('Генератор-проверка');
  await page.getByTestId('btn-generator').click();
  await page.getByTestId('gen-mode-password').click();
  // без символов и без похожих знаков
  await page.getByLabel(/символы|symbols/).uncheck();
  await page.getByTestId('gen-avoid').check();
  await page.getByTestId('gen-new').click();
  const generated = (await page.getByTestId('generator-preview').textContent())!.trim();
  expect(generated).toMatch(/^[A-Za-z0-9]{20,}$/);
  expect(generated).not.toMatch(/[0O1lI]/);
  await page.getByTestId('gen-use').click();
  await expect(page.getByTestId('generator')).toHaveCount(0);
  await page.getByTestId('f-save').click();
  await expect(page.getByTestId('view-title')).toHaveText('Генератор-проверка');
  await page.getByTestId('btn-reveal').click();
  await expect(page.getByTestId('view-password')).toHaveText(generated);
});

test('an entry with an attachment moves to another vault; the file keeps its content', async () => {
  const page = adminPage;
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-vault').click();
  await expect(page.getByTestId('vault-select')).toBeVisible();
  await page.getByTestId('vault-actions').click();
  await page.getByTestId('btn-new-vault').click();
  await page.getByTestId('name-input').fill('Приёмник файлов');
  await page.getByTestId('name-ok').click();
  await expect(page.getByTestId('vault-select').locator('option:checked')).toHaveText(
    'Приёмник файлов',
  );
  await page.getByTestId('vault-actions').click();
  await page.getByTestId('btn-new-vault').click();
  await page.getByTestId('name-input').fill('Файлы перенос');
  await page.getByTestId('name-ok').click();
  await expect(page.getByTestId('vault-select').locator('option:checked')).toHaveText(
    'Файлы перенос',
  );
  await addEntry(page, {
    title: 'Запись с файлом',
    username: 'files',
    password: 'Files-Move-7!zz',
  });
  await page.getByTestId('tab-files').click();
  await page.getByTestId('file-input').setInputFiles({
    name: 'перенос.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('СОДЕРЖИМОЕ ФАЙЛА ПРИ ПЕРЕНОСЕ 5521'),
  });
  await expect(page.getByTestId('file-row')).toContainText('перенос.txt');

  await page.getByTestId('entry-row').filter({ hasText: 'Запись с файлом' }).click();
  await page.getByTestId('entry-actions').click();
  await page.getByTestId('entry-move').click();
  const targetVaultId = await targetVault(page.getByTestId('move-target'), 'Приёмник файлов');
  await page.getByTestId('move-target').selectOption(targetVaultId);
  // A corrupted target must leave the source intact and remove the incomplete copy.
  const targetContent = `**/vaults/${targetVaultId}/attachments/*/content`;
  await page.route(targetContent, async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    body[0] = body[0]! ^ 1;
    await route.fulfill({ response, body });
  });
  await page.getByTestId('btn-move').click();
  await expect(page.getByTestId('ws-error')).toBeVisible();
  await expect(page.getByTestId('entry-row').filter({ hasText: 'Запись с файлом' })).toHaveCount(1);
  await page.unroute(targetContent);
  await page.getByTestId('btn-move').click();
  await expect(page.getByTestId('entry-row').filter({ hasText: 'Запись с файлом' })).toHaveCount(0);

  // в личном сейфе файл открывается и совпадает побайтно
  await page
    .getByTestId('vault-select')
    .selectOption(await targetVault(page.getByTestId('vault-select'), 'Приёмник файлов'));
  await expect(page.getByTestId('entry-row').filter({ hasText: 'Запись с файлом' })).toHaveCount(1);
  await page.getByTestId('entry-row').filter({ hasText: 'Запись с файлом' }).click();
  await page.getByTestId('tab-files').click();
  await expect(page.getByTestId('file-row')).toContainText('перенос.txt');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('file-download').click(),
  ]);
  expect(download.suggestedFilename()).toBe('перенос.txt');
  expect(readFileSync((await download.path())!, 'utf8')).toBe('СОДЕРЖИМОЕ ФАЙЛА ПРИ ПЕРЕНОСЕ 5521');
});

test('two-factor sign-in: enrol, sign out, password alone is not enough, code completes', async ({
  browser,
}) => {
  const { totp, parseTotpInput } = await import('../packages/crypto/dist/index.js');
  const page = adminPage;
  await await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-security').click();
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

  await page.getByTestId('menu-toggle').click();

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
  await fresh.getByTestId('menu-toggle').click();
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
  await fresh.getByTestId('menu-toggle').click();
  await fresh.getByTestId('signout').click();
  await login2(backup);
  await expect(fresh.getByTestId('error')).toBeVisible({ timeout: 90_000 });
});
