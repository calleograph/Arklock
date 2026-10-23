import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Обновление через браузер на РЕАЛЬНОМ стенде (установщик + помощник обновлений + контейнеры).
 * Запускается только в CI-задаче update-from-web; без LIVE_BASE_URL тесты пропускаются.
 */
const BASE = process.env.LIVE_BASE_URL ?? '';
const SETUP = process.env.LIVE_SETUP_TOKEN ?? '';
const ORIGIN = process.env.LIVE_ORIGIN ?? '';
const EMAIL = 'live.admin@example.com';
const MASTER = 'live-admin-master-password-77';

test.skip(!BASE, 'LIVE_BASE_URL не задан');
test.describe.configure({ mode: 'serial' });

async function openUpdates(page: Page) {
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();
  await page.getByTestId('nav-updates').click();
  await expect(page.getByTestId('helper-state')).toHaveText(/работает|running/, {
    timeout: 30_000,
  });
}

async function runUpdate(page: Page) {
  await page.getByTestId('btn-update').click();
  await expect(page.getByTestId('updates-progress')).toBeVisible({ timeout: 30_000 });
}

test('register, store an entry, update to the new release from the browser', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('name').fill('Live Admin');
  await page.getByTestId('setup-token').fill(SETUP);
  await page.getByTestId('password').fill(MASTER);
  await page.getByTestId('repeat').fill(MASTER);
  await page.getByTestId('submit').click();
  await page.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await page.getByTestId('recovery-continue').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });

  await page.getByTestId('add-entry').click();
  await page.getByTestId('f-title').fill('Live entry');
  await page.getByTestId('f-password').fill('live-entry-secret-123');
  await page.getByTestId('f-save').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1);

  await openUpdates(page);
  await expect(page.getByTestId('installed-version')).toHaveText('0.0.1');
  await page.getByTestId('btn-check').click();
  await expect(page.getByTestId('remote-status')).toHaveText('v0.0.2', { timeout: 120_000 });
  await expect(page.getByTestId('changelog')).not.toBeEmpty();

  await runUpdate(page);
  await expect(page.getByTestId('progress-state')).toHaveText('success', { timeout: 420_000 });
  await expect(page.getByTestId('history')).toContainText('update');

  // После обновления приложение перезапущено: перезагружаем страницу — сеанс и ключи сохраняются, данные на месте.
  await page.reload();
  // после обновления сеанс и разблокировка сохраняются: не экран входа и не запрос мастер-пароля
  await expect(page).not.toHaveURL(/\/(login|unlock)$/, { timeout: 90_000 });
  // F5 оставляет на той же странице («Обновления»); записи проверяем в сейфе
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-vault').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1, { timeout: 90_000 });
  await openUpdates(page);
  await expect(page.getByTestId('installed-version')).toHaveText('0.0.2');
});

test('a release with a failing migration is recovered and the interface explains it', async ({
  page,
}) => {
  execFileSync('tests/update/publish-release.sh', [ORIGIN, '0.0.3', 'broken-migration'], {
    stdio: 'inherit',
  });
  await page.goto(`${BASE}/`);
  await page.getByTestId('password').fill(MASTER);
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('submit').click();
  await openUpdates(page);
  await page.getByTestId('btn-check').click();
  await expect(page.getByTestId('remote-status')).toHaveText('v0.0.3', { timeout: 120_000 });

  await runUpdate(page);
  await expect(page.getByTestId('progress-state')).toHaveText('failed', { timeout: 420_000 });
  await expect(page.getByTestId('progress-message')).not.toBeEmpty();

  await page.reload();
  // после обновления сеанс и разблокировка сохраняются: не экран входа и не запрос мастер-пароля
  await expect(page).not.toHaveURL(/\/(login|unlock)$/, { timeout: 90_000 });
  // F5 оставляет на той же странице («Обновления»); записи проверяем в сейфе
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-vault').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1, { timeout: 90_000 });
  await openUpdates(page);
  await expect(page.getByTestId('installed-version')).toHaveText('0.0.2');
});

test('a copy is uploaded back: the helper checks it with this server key; a foreign file is refused', async ({
  page,
}) => {
  test.skip(!process.env.LIVE_DATA, 'LIVE_DATA не задан');
  const backupDir = path.join(process.env.LIVE_DATA!, 'backups');
  const work = path.resolve('test-results', 'live-backup');
  mkdirSync(work, { recursive: true });

  await page.goto('/login');
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('password').fill(MASTER);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('menu-toggle')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();
  await page.getByTestId('admin-tab-backups').click();

  // копия этого сервера; каталог копий принадлежит пользователю помощника, читаем через sudo
  await page.getByTestId('backup-create').click();
  // список обновляется раньше, чем операция завершится: ждём сообщение помощника, иначе загрузка получит 409
  await expect(page.getByText(/создана и проверена/)).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId('backup-row').first()).toBeVisible({ timeout: 300_000 });
  const before = await page.getByTestId('backup-row').count();
  const newest = execFileSync('sudo', ['sh', '-c', `ls -1t ${backupDir}/*.bak.gpg | head -n 1`])
    .toString()
    .trim();
  const copy = path.join(work, 'copy.bak.gpg');
  writeFileSync(copy, execFileSync('sudo', ['cat', newest]));

  // копия с этого же сервера проходит проверку и попадает в список
  await page.getByTestId('backup-upload').setInputFiles(copy);
  await expect(page.getByText(/загружена и проверена/)).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId('backup-row')).toHaveCount(before + 1, { timeout: 300_000 });
  await expect(page.getByTestId('backup-row').filter({ hasText: 'uploaded' })).toHaveCount(1);

  // чужой файл (не зашифрован ключом сервера) отклоняется, в список не попадает
  const foreign = path.join(work, 'foreign.bak.gpg');
  writeFileSync(foreign, 'это не резервная копия Arklock');
  await expect(page.getByTestId('backup-upload')).toBeEnabled({ timeout: 300_000 });
  await page.getByTestId('backup-upload').setInputFiles(foreign);
  await expect(page.getByRole('alert').filter({ hasText: 'не прошёл проверку' })).toBeVisible({
    timeout: 300_000,
  });
  await expect(page.getByTestId('backup-row')).toHaveCount(before + 1);
});
