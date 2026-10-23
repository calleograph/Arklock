import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const DIR = path.resolve('test-results', 'updater-dir');
const SETUP_CODE = 'e2e-setup-code-e2e-setup-code-2';
const EMAIL = 'admin.updates@example.com';
const MASTER = 'e2e-updates-master-password-31';

let helper: ChildProcess;

test.beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  helper = spawn(process.execPath, ['e2e/fake-helper.mjs', DIR], { stdio: 'ignore' });
});
test.afterAll(() => {
  helper?.kill();
});

function readOrEmpty(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

test('administrator checks for updates and applies one from the browser', async ({ page }) => {
  const bodies: string[] = [];
  page.on('request', (r) => {
    const body = r.postData();
    if (body) bodies.push(body);
  });

  await page.goto('/');
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('name').fill('Admin');
  await page.getByTestId('setup-token').fill(SETUP_CODE);
  await page.getByTestId('password').fill(MASTER);
  await page.getByTestId('repeat').fill(MASTER);
  await page.getByTestId('submit').click();
  await page.getByTestId('recovery-saved').check({ timeout: 60_000 });
  await page.getByTestId('recovery-continue').click();
  await expect(page.getByTestId('menu-toggle')).toBeVisible({ timeout: 60_000 });

  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();
  await page.getByTestId('admin-tab-updates').click();
  await expect(page.getByTestId('helper-state')).toHaveText(/работает|running/, {
    timeout: 15_000,
  });
  // «Обновления» — раздел администрирования: левое меню на месте, F5 и «Назад» работают
  await expect(page.getByTestId('admin-tab-users')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/updates$/);
  await page.getByTestId('admin-tab-overview').click();
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/updates$/);
  await expect(page.getByTestId('helper-state')).toBeVisible();
  await expect(page.getByTestId('remote-status')).toHaveText(/не проверялась|not checked/);
  await expect(page.getByTestId('update-state')).toContainText(
    /ещё не проверялось|not been checked/,
  );
  await expect(page.getByTestId('btn-update')).toHaveCount(0);

  // Проверка наличия обновления не требует подтверждения пароля.
  await page.getByTestId('btn-check').click();
  await expect(page.getByTestId('remote-status')).toHaveText('v9.9.9', { timeout: 15_000 });
  await expect(page.getByTestId('changelog')).toContainText('Тестовое изменение');
  await expect(page.getByTestId('update-state')).toContainText(/9\.9\.9/);
  await expect(page.getByTestId('btn-update')).toHaveText(/9\.9\.9/);
  await expect(page.getByTestId('btn-update')).toBeEnabled();

  // Штатное обновление выполняется по действующему сеансу администратора: окна мастер-пароля нет.
  await page.getByTestId('btn-update').click();
  await expect(page.getByTestId('reauth-password')).toHaveCount(0);

  // Ход выполнения виден по этапам, затем успех и запись в истории.
  await expect(page.getByTestId('updates-progress')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('progress-state')).toHaveText('running');
  await expect(page.getByTestId('progress-state')).toHaveText('success', { timeout: 30_000 });
  await expect(page.getByTestId('history')).toContainText('update');

  // Откат может вернуть старую версию и данные — он требует повышенного подтверждения; неверный пароль отклоняется.
  await page.getByTestId('btn-rollback').click();
  await page.getByTestId('reauth-password').fill('wrong-master-password-000');
  await page.getByTestId('reauth-confirm').click();
  await expect(
    page.getByRole('alert').filter({ hasText: /Неверный мастер-пароль|Wrong master password/ }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('reauth-password').fill(MASTER);
  await page.getByTestId('reauth-confirm').click();
  await expect(page.getByTestId('reauth-password')).toHaveCount(0, { timeout: 30_000 });

  // Пароль не уходит на сервер и не попадает в запросы к помощнику.
  expect(bodies.join('\n')).not.toContain(MASTER);
  expect(readOrEmpty(path.join(DIR, 'request.txt'))).not.toContain(MASTER);
});
