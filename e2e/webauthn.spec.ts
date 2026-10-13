import { expect, test, type Page } from '@playwright/test';

/** Ключи доступа в настоящем браузере: виртуальный аутентификатор Chromium (CDP) подписывает запросы настоящей криптографией. */
const SETUP = 'e2e-setup-code-e2e-setup-code-7';
const USER = {
  email: 'key.user@example.com',
  name: 'Ключ',
  password: 'webauthn-master-password-1',
};

test.describe.configure({ mode: 'serial' });

async function addVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'usb',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

test('register a security key, sign in with it, remove it', async ({ page }) => {
  await addVirtualAuthenticator(page);
  await page.goto('/');
  try {
    await page.getByTestId('name').waitFor({ timeout: 4000 });
  } catch {
    await page.getByTestId('to-register').click();
  }
  await page.getByTestId('email').fill(USER.email);
  await page.getByTestId('name').fill(USER.name);
  await page.getByTestId('setup-token').fill(SETUP);
  await page.getByTestId('password').fill(USER.password);
  await page.getByTestId('repeat').fill(USER.password);
  await page.getByTestId('submit').click();
  await page.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await page.getByTestId('recovery-continue').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });

  // добавление ключа на странице «Безопасность»
  await await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-security').click();
  await expect(page.getByTestId('keys-section')).toBeVisible();
  await page.getByTestId('key-name').fill('Виртуальный ключ');
  await page.getByTestId('key-password').fill(USER.password);
  await page.getByTestId('key-add').click();
  await expect(page.getByTestId('key-row')).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId('key-row')).toContainText('Виртуальный ключ');

  // новый вход: пароль, затем ключ
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('signout').click();
  await page.goto('/login');
  await page.getByTestId('email').fill(USER.email);
  await page.getByTestId('password').fill(USER.password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('mfa-webauthn')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('vault-select')).toHaveCount(0);
  await page.getByTestId('mfa-webauthn').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });

  // удаление ключа: нужен мастер-пароль
  await await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-security').click();
  page.once('dialog', (d) => void d.accept(USER.password));
  await page.getByTestId('key-remove').click();
  await expect(page.getByTestId('key-row')).toHaveCount(0, { timeout: 90_000 });

  // без ключей вход снова обычный
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('signout').click();
  await page.goto('/login');
  await page.getByTestId('email').fill(USER.email);
  await page.getByTestId('password').fill(USER.password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
});
