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
  await page.getByTestId('nav-admin').click();

  // обзор
  await tab(page, 'overview');
  await expect(page.getByTestId('ov-users')).toHaveText('1');
  await expect(page.getByTestId('ov-lockers')).toHaveText('1');
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
  await page.getByTestId('nav-admin').click();
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
  await page.getByTestId('nav-admin').click();
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
