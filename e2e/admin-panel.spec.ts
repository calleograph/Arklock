import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const DIR = path.resolve('test-results', 'admin-updater');
const SETUP = 'e2e-setup-code-e2e-setup-code-4';
const ADMIN = {
  email: 'panel.admin@example.com',
  name: 'Админ',
  password: 'panel-admin-master-password-1',
};

test.describe.configure({ mode: 'serial' });

let helper: ChildProcess;
let smtp: net.Server;
const mails: string[] = [];
let smtpPort = 0;

/** Простой SMTP-приёмник: принимает AUTH PLAIN и одно письмо. */
function startSmtp(): Promise<void> {
  smtp = net.createServer((sock) => {
    let data = false;
    let buf = '';
    sock.on('error', () => undefined);
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        if (data) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mails.push(buf.slice(0, end));
          buf = buf.slice(end + 5);
          data = false;
          sock.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/i.test(line)) sock.write('235 ok\r\n');
        else if (/^(MAIL|RCPT)/i.test(line)) sock.write('250 ok\r\n');
        else if (/^DATA/i.test(line)) {
          data = true;
          sock.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('500 ?\r\n');
      }
    });
  });
  return new Promise((resolve) =>
    smtp.listen(0, '127.0.0.1', () => {
      smtpPort = (smtp.address() as net.AddressInfo).port;
      resolve();
    }),
  );
}

test.beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  helper = spawn(process.execPath, ['e2e/fake-helper.mjs', DIR], { stdio: 'ignore' });
  await startSmtp();
});
test.afterAll(() => {
  helper?.kill();
  smtp?.close();
});

async function register(page: Page): Promise<void> {
  await page.goto('/');
  try {
    await page.getByTestId('name').waitFor({ timeout: 4000 });
  } catch {
    await page.getByTestId('to-register').click();
  }
  await page.getByTestId('email').fill(ADMIN.email);
  await page.getByTestId('name').fill(ADMIN.name);
  await page.getByTestId('setup-token').fill(SETUP);
  await page.getByTestId('password').fill(ADMIN.password);
  await page.getByTestId('repeat').fill(ADMIN.password);
  await page.getByTestId('submit').click();
  await page.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await page.getByTestId('recovery-continue').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
}

const tab = (page: Page, name: string) => page.getByTestId(`admin-tab-${name}`).click();

test('administration sections show real data and perform real operations', async ({ page }) => {
  await register(page);
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();

  // обзор
  await tab(page, 'overview');
  await expect(page.getByTestId('ov-users')).toHaveText('1');
  await expect(page.getByTestId('ov-lockers')).toHaveText('0');
  await expect(page.getByTestId('ov-version')).not.toHaveText('');

  // ресурсы
  await tab(page, 'resources');
  await expect(page.getByTestId('res-cpu')).toContainText('%');
  await expect(page.getByTestId('res-disk').first()).toBeVisible();

  // контейнеры (из снимка помощника)
  await tab(page, 'containers');
  await expect(page.getByTestId('container-row')).toHaveCount(2);
  await expect(page.getByTestId('containers-table')).toContainText('postgres:16-alpine');

  // резервные копии
  await tab(page, 'backups');
  await expect(page.getByTestId('backup-row')).toHaveCount(0);
  await page.getByTestId('backup-label').fill('manual');
  await page.getByTestId('backup-create').click();
  await expect(page.getByTestId('backup-row')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('backups-table')).toContainText('manual');
  await page.getByTestId('backup-verify').click();
  await expect(page.getByTestId('sys-notice')).toContainText(/корректна|correct/i, {
    timeout: 30_000,
  });

  // скачивание требует пароль и отдаёт то, что подготовил помощник
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /Скачать|Download/ }).click();
  await page.getByTestId('sys-password').fill(ADMIN.password);
  await page.getByTestId('sys-confirm').click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.bak\.gpg$/);
  expect(readFileSync((await download.path())!, 'utf8')).toBe('ENCRYPTED-FAKE-BACKUP');

  // расписание
  await page.getByTestId('sched-enabled').check();
  await page.getByTestId('sched-save').click();
  await expect(page.getByTestId('sys-notice')).toContainText(/Расписание|schedule/i, {
    timeout: 30_000,
  });

  // удалённое хранилище (S3): настройка с секретом, проверка, отправка, список, проверка целостности, удаление
  await page.getByTestId('offsite-endpoint').fill('https://s3.example.com');
  await page.getByTestId('offsite-bucket').fill('arklock-backups');
  await page.getByTestId('offsite-access').fill('AKIATESTACCESSKEY1');
  await page.getByTestId('offsite-secret').fill('e2e-secret-key-value');
  await page.getByTestId('offsite-save').click(); // без пароля настройка не принимается
  await expect(page.getByTestId('offsite-error')).toBeVisible();
  await page.getByTestId('offsite-password').fill(ADMIN.password);
  await page.getByTestId('offsite-save').click();
  await expect(page.getByTestId('offsite-status')).toContainText('arklock-backups', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('offsite')).not.toContainText('e2e-secret-key-value');
  await expect(page.getByTestId('offsite-secret')).toHaveValue('');
  await page.getByTestId('offsite-test').click();
  await expect(page.getByTestId('offsite-notice')).toContainText(/проверено|verified/i, {
    timeout: 30_000,
  });
  const localName = (
    await page.getByTestId('offsite-local-row').first().locator('td').first().innerText()
  ).trim();
  await page.getByTestId(`offsite-push-${localName}`).click();
  await expect(page.getByTestId('offsite-remote-row')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('offsite-status')).toContainText(/успешно|succeeded/);
  await page.getByTestId(`offsite-verify-${localName}`).click();
  await expect(page.getByTestId('offsite-notice')).toContainText(/цела|intact/i, {
    timeout: 30_000,
  });
  await page.getByTestId(`offsite-delete-${localName}`).click();
  await expect(page.getByTestId('offsite-remote-row')).toHaveCount(0, { timeout: 30_000 });
  await page.getByTestId('offsite-clear').click();
  await expect(page.getByTestId('offsite-status')).toHaveCount(0, { timeout: 30_000 });

  // удаление
  await page.getByTestId('backup-delete').click();
  await expect(page.getByTestId('backup-row')).toHaveCount(0, { timeout: 30_000 });

  // журналы системы
  await tab(page, 'logs');
  await page.getByTestId('log-fetch').click();
  await expect(page.getByTestId('log-text')).toContainText('app: started', { timeout: 30_000 });

  // хранилища и диагностика
  await tab(page, 'storage');
  await expect(page.getByTestId('storage-attachments')).toBeVisible();
  await page.getByTestId('storage-report').click();
  await expect(page.getByTestId('sys-notice')).toBeVisible();
  await tab(page, 'diagnostics');
  await expect(page.getByTestId('diag-row').first()).toBeVisible();
  await expect(page.getByTestId('diag-level')).toBeVisible();
  expect(await page.getByTestId('diag-row').count()).toBeGreaterThanOrEqual(6);

  // сертификаты: без публичного HTTPS-адреса проверять нечего, и интерфейс говорит об этом
  await tab(page, 'certificates');
  await expect(page.getByTestId('certs-empty')).toBeVisible();

  // почта: настройка, проверка соединения, тестовое письмо
  await tab(page, 'smtp');
  await page.getByTestId('smtp-host').fill('127.0.0.1');
  await page.getByTestId('smtp-port').fill(String(smtpPort));
  await page.getByTestId('smtp-security').selectOption('none');
  await page.getByTestId('smtp-user').fill('mailer');
  await page.getByTestId('smtp-password').fill('smtp-secret-for-e2e');
  await page.getByTestId('smtp-from').fill('arklock@example.com');
  await page.getByTestId('smtp-save').click();
  await expect(page.getByTestId('smtp-test')).toBeVisible();
  await page.getByTestId('smtp-test').click();
  await expect(page.getByTestId('smtp-result')).toContainText(/Успешно|Success/);
  await page.getByTestId('smtp-to').fill('boss@example.com');
  await page.getByTestId('smtp-send').click();
  await expect.poll(() => mails.length, { timeout: 15_000 }).toBe(1);
  expect(mails[0]).toContain('To: boss@example.com');
  // пароль после сохранения в форму не возвращается
  await page.reload();
  await page.getByTestId('password').fill(ADMIN.password);
  await page.getByTestId('submit').click();
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();
  await tab(page, 'smtp');
  await expect(page.getByTestId('smtp-host')).toHaveValue('127.0.0.1', { timeout: 60_000 });
  await expect(page.getByTestId('smtp-password')).toHaveValue('');
});

// ---------------------------------------------------------------- вход через каталог
const BASE_DN = 'dc=example,dc=com';
const ALICE = {
  dn: `uid=alice,ou=people,${BASE_DN}`,
  password: 'alice-ldap-e2e-pass',
  master: 'alice-master-password-e2e-1',
};
let directory: {
  close: () => void;
  listen: (...a: unknown[]) => void;
  address: () => { port: number };
} | null = null;
let ldapPort = 0;

async function startDirectory(): Promise<void> {
  const { createRequire } = await import('node:module');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ldap: any = createRequire(import.meta.url)('ldapjs');
  const s = ldap.createServer();
  s.bind(
    'cn=svc,dc=example,dc=com',
    (req: { credentials: string }, res: { end: () => void }, next: (e?: unknown) => void) => {
      if (req.credentials !== 'svc-e2e') return next(new ldap.InvalidCredentialsError());
      res.end();
      return next();
    },
  );
  s.bind(
    `ou=people,${BASE_DN}`,
    (
      req: { dn: { toString: () => string }; credentials: string },
      res: { end: () => void },
      next: (e?: unknown) => void,
    ) => {
      if (req.dn.toString().toLowerCase() !== ALICE.dn || req.credentials !== ALICE.password)
        return next(new ldap.InvalidCredentialsError());
      res.end();
      return next();
    },
  );
  s.search(
    BASE_DN,
    (
      req: { filter: { matches: (o: object) => boolean } },
      res: { send: (e: object) => void; end: () => void },
      next: () => void,
    ) => {
      const attrs = {
        objectClass: 'person',
        uid: 'alice',
        mail: 'alice@example.com',
        cn: 'Alice Directory',
      };
      if (req.filter.matches(attrs)) res.send({ dn: ALICE.dn, attributes: attrs });
      res.end();
      return next();
    },
  );
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  directory = s;
  ldapPort = s.address().port;
}

test('directory sign-in: configure LDAP, first sign-in creates the account, later sign-ins unlock it', async ({
  page,
  browser,
}) => {
  await startDirectory();
  // администратор входит и настраивает каталог
  await page.goto('/login');
  await page.getByTestId('email').fill(ADMIN.email);
  await page.getByTestId('password').fill(ADMIN.password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
  const token = await page.evaluate(() => sessionStorage.getItem('arklock.token'));
  const personalPolicy = await page.request.put('/api/v1/admin/settings', {
    headers: { authorization: `Bearer ${token}` },
    data: { 'vaults.personalLockers': true },
  });
  expect(personalPolicy.status()).toBe(200);
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();
  await tab(page, 'ldap');
  await page.getByTestId('ldap-enabled').check();
  await page.getByTestId('ldap-url').fill(`ldap://127.0.0.1:${ldapPort}`);
  await page.getByTestId('ldap-plaintext').check();
  await page.getByTestId('ldap-binddn').fill('cn=svc,dc=example,dc=com');
  await page.getByTestId('ldap-bindpw').fill('svc-e2e');
  await page.getByTestId('ldap-basedn').fill(BASE_DN);
  await page.getByTestId('ldap-save').click();
  await page.getByTestId('ldap-test').click();
  await expect(page.getByTestId('ldap-result')).toContainText(/работает|works/i);
  await page.getByTestId('ldap-lookup-name').fill('alice');
  await page.getByTestId('ldap-lookup').click();
  await expect(page.getByTestId('ldap-lookup-result')).toContainText('alice@example.com');

  // пользователь каталога: вход, создание мастер-пароля
  const user = await (await browser.newContext()).newPage();
  await user.goto('/login');
  await user.getByTestId('to-ldap').click();
  await user.getByTestId('ldap-user').fill('alice');
  await user.getByTestId('password').fill('wrong-ldap-password');
  await user.getByTestId('submit').click();
  await expect(user.getByTestId('error')).toBeVisible();
  await user.getByTestId('password').fill(ALICE.password);
  await user.getByTestId('submit').click();
  await expect(user.getByTestId('ldap-enroll-hint')).toBeVisible({ timeout: 30_000 });
  await user.getByTestId('password').fill(ALICE.master);
  await user.getByTestId('repeat').fill(ALICE.master);
  await user.getByTestId('submit').click();
  await user.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await user.getByTestId('recovery-continue').click();
  await expect(user.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
  await user.getByTestId('add-entry').click();
  await user.getByTestId('f-title').fill('Каталог: запись');
  await user.getByTestId('f-password').fill('Dir-Secret-9!x');
  await user.getByTestId('f-save').click();
  await expect(user.getByTestId('view-title')).toHaveText('Каталог: запись');

  // новый вход: пароль каталога, затем мастер-пароль
  const again = await (await browser.newContext()).newPage();
  await again.goto('/login');
  await again.getByTestId('to-ldap').click();
  await again.getByTestId('ldap-user').fill('alice@example.com');
  await again.getByTestId('password').fill(ALICE.password);
  await again.getByTestId('submit').click();
  await again.waitForURL('**/unlock');
  await again.getByTestId('password').fill(ALICE.master);
  await again.getByTestId('submit').click();
  await expect(again.getByTestId('entry-row').first()).toContainText('Каталог: запись', {
    timeout: 90_000,
  });

  // вход по одному лишь мастер-паролю для учётной записи каталога закрыт
  const local = await (await browser.newContext()).newPage();
  await local.goto('/login');
  await local.getByTestId('email').fill('alice@example.com');
  await local.getByTestId('password').fill(ALICE.master);
  await local.getByTestId('submit').click();
  await expect(local.getByTestId('error')).toBeVisible({ timeout: 90_000 });
  await expect(local.getByTestId('add-entry')).toHaveCount(0);
  directory?.close();
});

// ---------------------------------------------------------------- единый вход (OpenID Connect)
test('SSO: configure the provider, first sign-in creates the account, later sign-ins unlock it', async ({
  page,
  browser,
}) => {
  const { startIdp } = (await import('./mock-idp.mjs')) as {
    startIdp: (o: {
      clientId: string;
      clientSecret: string;
      user: { sub: string; email: string; name: string };
    }) => Promise<{ issuer: string; close: () => void }>;
  };
  const idp = await startIdp({
    clientId: 'arklock-e2e',
    clientSecret: 'idp-secret-e2e',
    user: { sub: 'bob-1', email: 'bob@example.com', name: 'Bob Sso' },
  });
  try {
    await page.goto('/login');
    await page.getByTestId('email').fill(ADMIN.email);
    await page.getByTestId('password').fill(ADMIN.password);
    await page.getByTestId('submit').click();
    await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
    await page.getByTestId('menu-toggle').click();
    await page.getByTestId('menu-full').click();
    await tab(page, 'sso');
    await expect(page.getByTestId('sso-redirect')).toContainText('/api/v1/auth/sso/callback');
    await page.getByTestId('sso-enabled').check();
    await page.getByTestId('sso-issuer').fill(idp.issuer);
    await page.getByTestId('sso-client').fill('arklock-e2e');
    await page.getByTestId('sso-secret').fill('idp-secret-e2e');
    await page.getByTestId('sso-button-text').fill('Войти через Тест-IdP');
    await page.getByTestId('sso-insecure').check();
    await page.getByTestId('sso-save').click();
    await page.getByTestId('sso-test').click();
    await expect(page.getByTestId('sso-result')).toContainText(/отвечает|responds/i);

    const bob = await (await browser.newContext()).newPage();
    await bob.goto('/login');
    await bob.getByTestId('to-sso').click();
    await expect(bob.getByTestId('ldap-enroll-hint')).toBeVisible({ timeout: 30_000 });
    await bob.getByTestId('password').fill('bob-master-password-e2e-1');
    await bob.getByTestId('repeat').fill('bob-master-password-e2e-1');
    await bob.getByTestId('submit').click();
    await bob.getByTestId('recovery-saved').check({ timeout: 90_000 });
    await bob.getByTestId('recovery-continue').click();
    await expect(bob.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
    await bob.getByTestId('add-entry').click();
    await bob.getByTestId('f-title').fill('SSO: запись');
    await bob.getByTestId('f-save').click();
    await expect(bob.getByTestId('view-title')).toHaveText('SSO: запись');

    const again = await (await browser.newContext()).newPage();
    await again.goto('/login');
    await again.getByTestId('to-sso').click();
    await again.waitForURL('**/unlock');
    await again.getByTestId('password').fill('bob-master-password-e2e-1');
    await again.getByTestId('submit').click();
    await expect(again.getByTestId('entry-row').first()).toContainText('SSO: запись', {
      timeout: 90_000,
    });
  } finally {
    idp.close();
  }
});

// ---------------------------------------------------------------- приглашения
test('an administrator creates a local user; the person activates with a one-time code and sets their own master password', async ({
  page,
  browser,
}) => {
  await page.goto('/login');
  await page.getByTestId('email').fill(ADMIN.email);
  await page.getByTestId('password').fill(ADMIN.password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();
  await tab(page, 'invitations');
  await page.getByTestId('invite-name').fill('Новый Сотрудник');
  await page.getByTestId('invite-email').fill('invited.person@example.com');
  await page.getByTestId('invite-create').click();
  // администратор видит код активации один раз и не получает мастер-пароль
  const code = (await page.getByTestId('invite-code').innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{6}(-[A-Z2-9]{6}){3}$/);
  await expect(page.getByTestId('invite-row')).toContainText('invited.person@example.com');
  await expect(page.getByTestId('invite-row')).toContainText('Новый Сотрудник');

  // пользователь вводит адрес и код на экране входа и задаёт свой мастер-пароль
  const guest = await (await browser.newContext()).newPage();
  await guest.goto('/login');
  await guest.getByTestId('to-activate').click();
  // чужой адрес с тем же кодом не подходит
  await guest.getByTestId('email').fill('someone.else@example.com');
  await guest.getByTestId('activation-code').fill(code);
  await guest.getByTestId('submit').click();
  await expect(guest.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  await guest.getByTestId('email').fill('invited.person@example.com');
  await guest.getByTestId('submit').click();
  await expect(guest.getByTestId('email')).toHaveValue('invited.person@example.com', {
    timeout: 30_000,
  });
  await expect(guest.getByTestId('email')).toHaveAttribute('readonly', '');
  await expect(guest.getByTestId('name')).toHaveValue('Новый Сотрудник');
  await guest.getByTestId('password').fill('invited-master-password-e2e-1');
  await guest.getByTestId('repeat').fill('invited-master-password-e2e-1');
  await guest.getByTestId('submit').click();
  await guest.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await guest.getByTestId('recovery-continue').click();
  await expect(guest.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });

  // код одноразовый: повторная активация с ним невозможна
  const again = await (await browser.newContext()).newPage();
  await again.goto('/login');
  await again.getByTestId('to-activate').click();
  await again.getByTestId('email').fill('invited.person@example.com');
  await again.getByTestId('activation-code').fill(code);
  await again.getByTestId('submit').click();
  await expect(again.getByRole('alert')).toBeVisible({ timeout: 30_000 });
});

test('custom roles: an administrative role opens only its own sections for a delegated administrator', async ({
  page,
  browser,
}) => {
  await page.goto('/login');
  await page.getByTestId('email').fill(ADMIN.email);
  await page.getByTestId('password').fill(ADMIN.password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();
  await tab(page, 'roles');

  // создание роли: разрешение журнала, явный запрет в той же области без разрешений недопустим для UI-формы (взаимоисключение)
  await page.getByTestId('role-new').click();
  await page.getByTestId('role-name').fill('Аудитор журнала');
  await page.getByTestId('role-scope').selectOption('admin');
  await page.getByTestId('allow-admin.ledger').check();
  await page.getByTestId('allow-admin.users').check();
  await page.getByTestId('deny-admin.users').check(); // запрет снимает разрешение
  await expect(page.getByTestId('allow-admin.users')).not.toBeChecked();
  await page.getByTestId('role-save').click();
  const row = page.getByTestId('role-row').filter({ hasText: 'Аудитор журнала' });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/Журнал|Activity log/);

  // назначение приглашённому пользователю
  await tab(page, 'users');
  const select = page.getByTestId('admin-role-invited.person@example.com');
  await select.selectOption({ label: 'Аудитор журнала' });
  await expect(select).toHaveValue(/.+/);

  // делегированный администратор видит только разрешённый раздел
  const guest = await (await browser.newContext()).newPage();
  await guest.goto('/login');
  await guest.getByTestId('email').fill('invited.person@example.com');
  await guest.getByTestId('password').fill('invited-master-password-e2e-1');
  await guest.getByTestId('submit').click();
  await expect(guest.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
  await guest.getByTestId('menu-toggle').click();
  await guest.getByTestId('menu-full').click();
  await expect(guest.getByTestId('admin-tab-ledger')).toBeVisible();
  await expect(guest.getByTestId('admin-tab-users')).toHaveCount(0);
  await expect(guest.getByTestId('admin-tab-roles')).toHaveCount(0);
  // роль, назначенную пользователю, удалить нельзя
  await page.reload();
  await page.getByTestId('password').fill(ADMIN.password);
  await page.getByTestId('submit').click();
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();
  await tab(page, 'roles');
  await page.getByTestId('role-delete-Аудитор журнала').click(); // первое нажатие — подтверждение
  await page.getByTestId('role-delete-Аудитор журнала').click();
  await expect(page.getByTestId('roles-error')).toBeVisible();
});

// ---------------------------------------------------------------- SAML
test('SAML: provider metadata, first sign-in creates the account, later ones unlock it, forged responses are refused', async ({
  page,
  browser,
}) => {
  const { createIdp, buildResponse, autoPost, parseAuthnRequest, idpMetadata } =
    await import('./saml-idp.mjs');
  const http = await import('node:http');
  const idp = await createIdp('https://idp.e2e.example/entity');
  const rogue = await createIdp('https://idp.e2e.example/entity');
  let mode: 'ok' | 'forged' = 'ok';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/metadata') {
      res.setHeader('content-type', 'application/xml');
      res.end(idpMetadata(idp, { sso: `http://127.0.0.1:${port()}/sso` }));
      return;
    }
    if (url.pathname === '/sso' && !url.searchParams.has('SAMLRequest')) {
      res.end('IdP'); // проверка доступности из панели
      return;
    }
    if (url.pathname === '/sso') {
      const ar = parseAuthnRequest(url.searchParams.get('SAMLRequest') ?? '');
      const xml = buildResponse({
        idp,
        signingIdp: mode === 'forged' ? rogue : undefined,
        acs: ar.acs,
        audience: ar.issuer,
        inResponseTo: ar.id,
        nameId: 'carol-1',
        attributes: { email: 'carol@example.com', displayName: 'Carol Saml' },
      });
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(autoPost(ar.acs, xml, url.searchParams.get('RelayState') ?? ''));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = () => (server.address() as { port: number }).port;
  try {
    await page.goto('/login');
    await page.getByTestId('email').fill(ADMIN.email);
    await page.getByTestId('password').fill(ADMIN.password);
    await page.getByTestId('submit').click();
    await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
    await page.getByTestId('menu-toggle').click();
    await page.getByTestId('menu-full').click();
    await tab(page, 'saml');
    await expect(page.getByTestId('saml-acs')).toContainText('/api/v1/auth/saml/acs');

    // настройки из метаданных провайдера
    await page.getByTestId('saml-insecure').check();
    await page.getByTestId('saml-meta-url').fill(`http://127.0.0.1:${port()}/metadata`);
    await page.getByTestId('saml-import').click();
    await expect(page.getByTestId('saml-idp-entity')).toHaveValue(idp.entityId);
    await expect(page.getByTestId('saml-entry-point')).toHaveValue(
      `http://127.0.0.1:${port()}/sso`,
    );
    await page.getByTestId('saml-enabled').check();
    await page.getByTestId('saml-save').click();
    await expect(page.getByTestId('saml-notice')).toBeVisible();
    await expect(page.getByTestId('saml-cert-info')).toContainText(/Действует|Valid/);
    await page.getByTestId('saml-test').click();
    await expect(page.getByTestId('saml-checks').locator('[data-level="error"]')).toHaveCount(0);
    await expect(page.getByTestId('saml-checks').locator('[data-level="ok"]')).not.toHaveCount(0);

    // первый вход: учётная запись создаётся, мастер-пароль задаёт сам пользователь
    const carol = await (await browser.newContext()).newPage();
    await carol.goto('/login');
    await carol.getByTestId('to-saml').click();
    await expect(carol.getByTestId('ldap-enroll-hint')).toBeVisible({ timeout: 30_000 });
    await carol.getByTestId('password').fill('carol-master-password-e2e-1');
    await carol.getByTestId('repeat').fill('carol-master-password-e2e-1');
    await carol.getByTestId('submit').click();
    await carol.getByTestId('recovery-saved').check({ timeout: 90_000 });
    await carol.getByTestId('recovery-continue').click();
    await expect(carol.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
    await carol.getByTestId('add-entry').click();
    await carol.getByTestId('f-title').fill('SAML: запись');
    await carol.getByTestId('f-save').click();
    await expect(carol.getByTestId('view-title')).toHaveText('SAML: запись');

    // повторный вход открывает существующую учётную запись
    const again = await (await browser.newContext()).newPage();
    await again.goto('/login');
    await again.getByTestId('to-saml').click();
    await again.waitForURL('**/unlock');
    await again.getByTestId('password').fill('carol-master-password-e2e-1');
    await again.getByTestId('submit').click();
    await expect(again.getByTestId('entry-row').first()).toContainText('SAML: запись', {
      timeout: 90_000,
    });

    // ответ, подписанный чужим ключом, не открывает ничего
    mode = 'forged';
    const evil = await (await browser.newContext()).newPage();
    await evil.goto('/login');
    await evil.getByTestId('to-saml').click();
    await expect(evil.getByTestId('sso-error')).toBeVisible({ timeout: 30_000 });
    await expect(evil.getByTestId('sso-error')).toContainText(/подпис|signature/i);
  } finally {
    server.close();
  }
});

test('themes: all six apply to the whole interface, are saved in the profile and follow the user to another browser', async ({
  page,
  browser,
}) => {
  await page.goto('/login');
  // до входа действует тема по умолчанию — корпоративная голубая
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'corporate');
  await page.getByTestId('email').fill(ADMIN.email);
  await page.getByTestId('password').fill(ADMIN.password);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-settings').click();

  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const seen = new Set<string>();
  for (const id of ['corporate', 'light', 'dark', 'forest', 'emerald', 'sunset']) {
    await page.getByTestId(`theme-${id}`).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
    const dark = id === 'dark' || id === 'forest';
    await expect(page.locator('html')).toHaveClass(dark ? /dark/ : /^(?!.*\bdark\b)/);
    await expect(page.getByTestId('theme-notice')).toBeVisible();
    await page.waitForTimeout(350); // завершение плавной смены цвета
    seen.add(await bodyBg());
  }
  expect(seen.size).toBe(6); // у каждой темы свой фон страницы

  // выбор сохранён в профиле: другой браузер без локальных настроек получает его после входа
  await page.getByTestId('theme-forest').click();
  await expect(page.getByTestId('theme-notice')).toBeVisible();
  const other = await (await browser.newContext()).newPage();
  await other.goto('/login');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'corporate');
  await other.getByTestId('email').fill(ADMIN.email);
  await other.getByTestId('password').fill(ADMIN.password);
  await other.getByTestId('submit').click();
  await expect(other.getByTestId('add-entry')).toBeVisible({ timeout: 90_000 });
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'forest');
  // перезагрузка не даёт вспышки: тема читается до отрисовки
  await other.reload();
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'forest');
});
