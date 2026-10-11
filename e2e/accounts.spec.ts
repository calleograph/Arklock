import { expect, test } from '@playwright/test';

const EMAIL = 'e2e.user@example.com';
const MASTER = 'e2e-master-password-UNIQUE-4711';
const ENTRY_PASSWORD = 'entry-secret-UNIQUE-9182';

test.describe.configure({ mode: 'serial' });
let recoveryCode = '';

test('register, store a secret, lock, unlock and sign in again — secrets never reach the server in clear', async ({
  page,
}) => {
  const requestBodies: string[] = [];
  const problems: string[] = [];
  page.on('request', (r) => {
    const body = r.postData();
    if (body) requestBodies.push(body);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));

  // Первая учётная запись: открывается форма регистрации.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('name')).toBeVisible();

  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('name').fill('E2E User');
  await page.getByTestId('password').fill(MASTER);
  await page.getByTestId('repeat').fill(MASTER);
  await page.getByTestId('submit').click();

  // Ключ восстановления показывается один раз и требует подтверждения.
  const code = page.getByTestId('recovery-code');
  await expect(code).toBeVisible({ timeout: 60_000 });
  await expect(code).toHaveText(/^([0-9A-Z]{5}-){10}[0-9A-Z]{1,5}$/);
  recoveryCode = (await code.textContent()) ?? '';
  await expect(page.getByTestId('recovery-continue')).toBeDisabled();
  await page.getByTestId('recovery-saved').check();
  await page.getByTestId('recovery-continue').click();

  // Автоматический вход после регистрации.
  await expect(page.getByRole('heading', { name: /Личный сейф|Personal locker/ })).toBeVisible({
    timeout: 60_000,
  });

  await page.getByTestId('add-entry').click();
  await page.getByTestId('f-title').fill('Почта');
  await page.getByTestId('f-username').fill('me@example.com');
  await page.getByTestId('f-password').fill(ENTRY_PASSWORD);
  await page.getByTestId('f-url').fill('https://mail.example.com');
  await page.getByTestId('f-save').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1);
  await expect(page.getByTestId('entry-row')).toContainText('Почта');

  // Перезагрузка стирает ключи из памяти: сессия есть, но нужна разблокировка.
  await page.reload();
  await expect(page).toHaveURL(/\/unlock$/);
  await page.getByTestId('password').fill('wrong-master-password-1234');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('error')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('password').fill(MASTER);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1, { timeout: 60_000 });

  // Пароль записи раскрывается только по действию пользователя.
  await expect(page.getByTestId('revealed-password')).toHaveCount(0);
  await page.getByTestId('entry-row').getByRole('button').first().click();
  await expect(page.getByTestId('revealed-password')).toHaveText(ENTRY_PASSWORD);

  // Ручная блокировка.
  await page.getByTestId('lock').click();
  await expect(page).toHaveURL(/\/unlock$/);

  // Выход и повторный вход.
  await page.getByRole('button', { name: /Выйти|Sign out/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('password').fill(MASTER);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1, { timeout: 60_000 });

  // Регистрация после первой учётной записи закрыта.
  await page.getByTestId('signout').click();
  await expect(page.getByTestId('to-register')).toHaveCount(0);

  // Серверу не уходили ни мастер-пароль, ни пароль записи, ни её название.
  const joined = requestBodies.join('\n');
  expect(joined).not.toContain(MASTER);
  expect(joined).not.toContain(ENTRY_PASSWORD);
  expect(joined).not.toContain('me@example.com');
  expect(joined).not.toContain('Почта');
  expect(joined).not.toContain('mail.example.com');

  // Политика содержимого не блокирует приложение (в т.ч. WebAssembly для Argon2id).
  expect(problems.filter((p) => /Content Security Policy|CSP|WebAssembly/i.test(p))).toEqual([]);
});

test('recover access with the recovery key: same data, old password stops working', async ({
  page,
}) => {
  const NEW_MASTER = 'e2e-brand-new-master-5521';
  await page.goto('/login');
  await page.getByRole('button', { name: /Забыли пароль|Forgot your password/ }).click();
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('recovery-input').fill(recoveryCode.toLowerCase());
  await page.getByTestId('password').fill(NEW_MASTER);
  await page.getByTestId('repeat').fill(NEW_MASTER);
  await page.getByTestId('submit').click();

  const fresh = page.getByTestId('recovery-code');
  await expect(fresh).toBeVisible({ timeout: 60_000 });
  const freshCode = (await fresh.textContent()) ?? '';
  expect(freshCode).not.toBe(recoveryCode);
  await page.getByTestId('recovery-saved').check();
  await page.getByTestId('recovery-continue').click();

  // Старый мастер-пароль больше не подходит.
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('password').fill(MASTER);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('error')).toBeVisible({ timeout: 60_000 });

  // Новый — подходит, данные на месте (закрытый ключ не менялся).
  await page.getByTestId('password').fill(NEW_MASTER);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('entry-row')).toContainText('Почта');

  // Использованный ключ восстановления уже недействителен.
  await page.getByTestId('signout').click();
  await page.getByRole('button', { name: /Забыли пароль|Forgot your password/ }).click();
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('recovery-input').fill(recoveryCode);
  await page.getByTestId('password').fill('another-long-password-77');
  await page.getByTestId('repeat').fill('another-long-password-77');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('error')).toBeVisible({ timeout: 60_000 });
});
