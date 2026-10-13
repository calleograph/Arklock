import { expect, test, type Page } from '@playwright/test';

// Длительная работа: время в браузере управляется часами Playwright, поэтому часы проходят за секунды,
// а поведение приложения проверяется по тому же коду, что и у пользователя.
const SETUP_CODE = 'e2e-setup-code-e2e-setup-code-9';
const EMAIL = 'session.user@example.com';
const MASTER = 'e2e-session-master-2291';
const MIN = 60_000;

test.describe.configure({ mode: 'serial' });
// регистрация с Argon2id и часы чтения занимают несколько минут на медленных машинах
test.setTimeout(480_000);

async function register(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('name').fill('Session User');
  await page.getByTestId('setup-token').fill(SETUP_CODE);
  await page.getByTestId('password').fill(MASTER);
  await page.getByTestId('repeat').fill(MASTER);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('recovery-code')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('recovery-saved').check();
  await page.getByTestId('recovery-continue').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 60_000 });
}

/** Настоящее чтение: прокрутка колёсиком и движение мыши (без кликов и клавиш). */
async function read(page: Page): Promise<void> {
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, 240);
}

/** Прошло `ms` без единого действия пользователя. */
async function idle(page: Page, ms: number): Promise<void> {
  // fastForward: как закрытая крышка ноутбука — проверка срока выполняется по времени, без тысяч тиков таймеров
  await page.clock.fastForward(ms);
}

test('long reading keeps the keys; the default is eight hours of inactivity', async ({ page }) => {
  // часы включаются до загрузки приложения: все таймеры страницы идут по ним
  await page.clock.install({ time: new Date('2026-10-13T08:00:00Z') });
  await register(page);

  await page.getByTestId('add-entry').click();
  await page.getByTestId('f-title').fill('Журнал работы');
  await page.getByTestId('f-username').fill('reader');
  await page.getByTestId('f-password').fill('reading-secret-7714');
  await page.getByTestId('f-save').click();
  await expect(page.getByTestId('view-title')).toHaveText('Журнал работы');

  // шесть часов чтения: каждые 20 минут пользователь прокручивает запись — ключи остаются
  for (let i = 0; i < 18; i++) {
    await idle(page, 20 * MIN);
    await read(page);
  }
  await expect(page).not.toHaveURL(/\/unlock$/);
  await expect(page.getByTestId('view-title')).toHaveText('Журнал работы');

  // дальше — полтора часа без единого действия: по умолчанию (8 часов) блокировки ещё нет
  await idle(page, 90 * MIN);
  await expect(page).not.toHaveURL(/\/unlock$/);
  await expect(page.getByTestId('view-title')).toHaveText('Журнал работы');

  // ещё семь часов полного бездействия (всего больше восьми часов) — блокировка с запросом мастер-пароля
  // шагами по 10 минут, как при реальном бездействии: одна длинная перемотка зависит от поведения часов браузера
  for (let i = 0; i < 42; i++) await idle(page, 10 * MIN);
  await expect(page).toHaveURL(/\/unlock$/);
  await page.getByTestId('password').fill(MASTER);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1, { timeout: 60_000 });
});

test('a chosen 30-minute setting: reading keeps the vault open; 31 idle minutes lock it', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-13T09:00:00Z') });
  await page.goto('/');
  await page.getByTestId('email').fill(EMAIL);
  await page.getByTestId('password').fill(MASTER);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('entry-row')).toHaveCount(1, { timeout: 60_000 });

  // выбор срока в настройках (переход внутри приложения, без перезагрузки — ключи сохраняются)
  await page.getByTestId('menu-toggle').click();
  await page
    .getByRole('link', { name: /^(Настройки|Settings)$/ })
    .first()
    .click();
  await page.getByTestId('autolock-30').click();
  await expect(page.getByTestId('autolock-30')).toHaveAttribute('aria-checked', 'true');
  await page.goBack();
  await expect(page.getByTestId('entry-row')).toHaveCount(1);

  // полтора часа активного чтения с паузами по 10 минут — не блокирует
  for (let i = 0; i < 9; i++) {
    await idle(page, 10 * MIN);
    await read(page);
  }
  await expect(page).not.toHaveURL(/\/unlock$/);

  // 31 минута без действий — блокирует
  await idle(page, 31 * MIN);
  await expect(page).toHaveURL(/\/unlock$/);
});
