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
