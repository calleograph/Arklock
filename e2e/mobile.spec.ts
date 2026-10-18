import { expect, test, type Page } from '@playwright/test';

const SETUP = 'e2e-setup-code-e2e-setup-code-6';
const USER = {
  email: 'mobile.user@example.com',
  name: 'Мобильный',
  password: 'mobile-master-password-1',
};

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.describe.configure({ mode: 'serial' });

/** Страница не должна прокручиваться вбок: широкие таблицы живут в собственных контейнерах. */
async function noHorizontalScroll(page: Page, where: string): Promise<void> {
  const over = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    // в мобильной эмуляции innerWidth растягивается под содержимое, поэтому сравниваем с заданной шириной экрана
    view: 390,
  }));
  if (over.doc > over.view + 1) {
    const offenders = await page.evaluate(() =>
      Array.from(document.querySelectorAll('body *'))
        .filter((e) => e.getBoundingClientRect().right > 391)
        .slice(0, 6)
        .map(
          (e) =>
            `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 60)} ${Math.round(e.getBoundingClientRect().right)}`,
        ),
    );
    console.log('OFFENDERS', where, JSON.stringify(offenders));
  }
  expect(
    over.doc,
    `${where}: страница шире экрана (${over.doc} > ${over.view})`,
  ).toBeLessThanOrEqual(over.view + 1);
}

test('the installable app: manifest, icons, service worker that never stores API responses', async ({
  page,
}) => {
  await page.goto('/login');
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/' });
  for (const icon of manifest.icons as { src: string; sizes: string }[]) {
    const r = await page.request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()['content-type']).toContain('image/png');
  }
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);

  // service worker регистрируется и принимает управление
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  // вызов API идёт мимо кэша
  await page.evaluate(() => fetch('/api/v1/auth/registration').then((r) => r.json()));
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys())
      for (const req of await (await caches.open(name)).keys())
        urls.push(new URL(req.url).pathname);
    return urls;
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.some((p) => p.startsWith('/api/'))).toBe(false);
});

test('every main screen fits a phone without sideways scrolling', async ({ page }) => {
  await page.goto('/');
  try {
    await page.getByTestId('name').waitFor({ timeout: 4000 });
  } catch {
    await page.getByTestId('to-register').click();
  }
  await noHorizontalScroll(page, 'регистрация');
  await page.getByTestId('email').fill(USER.email);
  await page.getByTestId('name').fill(USER.name);
  await page.getByTestId('setup-token').fill(SETUP);
  await page.getByTestId('password').fill(USER.password);
  await page.getByTestId('repeat').fill(USER.password);
  await page.getByTestId('submit').click();
  await noHorizontalScroll(page, 'ключ восстановления');
  await page.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await page.getByTestId('recovery-continue').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
  await noHorizontalScroll(page, 'сейф');

  await page.getByTestId('add-entry').click();
  await page
    .getByTestId('f-title')
    .fill('Очень длинное название записи для проверки переноса строк на узком экране');
  await page.getByTestId('f-username').fill('very.long.username.for.testing@example.com');
  await page.getByTestId('f-password').fill('Mobile-Secret-1234!');
  await page
    .getByTestId('f-url')
    .fill('https://example.com/a/very/long/path/that/should/not/break/the/layout?x=1');
  await noHorizontalScroll(page, 'форма записи');
  await page.getByTestId('f-save').click();
  await expect(page.getByTestId('view-title')).toBeVisible();
  await noHorizontalScroll(page, 'просмотр записи');

  for (const [path, name] of [
    ['/settings', 'настройки'],
    ['/security', 'безопасность'],
    ['/admin/users', 'администрирование: пользователи'],
    ['/admin/settings', 'администрирование: настройки'],
    ['/admin/backups', 'администрирование: копии'],
    ['/admin/ldap', 'администрирование: каталог'],
    ['/admin/sso', 'администрирование: SSO'],
    ['/admin/smtp', 'администрирование: почта'],
    ['/admin/updates', 'обновления'],
    ['/status', 'состояние'],
    ['/help', 'помощь'],
  ] as const) {
    // переход внутри приложения: полная перезагрузка стёрла бы ключи
    await page.evaluate((p) => {
      history.pushState({}, '', p);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
    await page.waitForTimeout(600);
    await noHorizontalScroll(page, name);
  }

  // подсказка «i»: нажатие раскрывает текст, Escape и нажатие вне подсказки закрывают
  await page.evaluate(() => {
    history.pushState({}, '', '/admin/settings');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  const hint = page.getByTestId('info-hint').first();
  await hint.click();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await noHorizontalScroll(page, 'подсказка');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await hint.click();
  await page.getByRole('heading').first().click();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});
