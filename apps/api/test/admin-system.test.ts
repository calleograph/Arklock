import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DIAGNOSTIC_STATES } from '@arklock/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { settings, attachments } from '../src/db/schema.js';
import { diskLevel, GIB } from '../src/resources.js';
import { probeCertificate } from '../src/routes/admin-system.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let blobDir: string;
let admin: TestClient;
let bob: TestClient;

/** Минимальный SMTP-сервер для проверки клиента: AUTH PLAIN, одно письмо, запись всего полученного. */
function mockSmtp(expectPassword: string) {
  const received: { from?: string; to?: string; data: string; auth?: string }[] = [];
  const server = net.createServer((sock) => {
    let mode: 'cmd' | 'data' = 'cmd';
    const cur: (typeof received)[number] = { data: '' };
    let buf = '';
    sock.on('error', () => undefined); // клиент вправе оборвать соединение
    sock.write('220 mock ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        if (mode === 'data') {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          cur.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          received.push(cur);
          mode = 'cmd';
          sock.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) sock.write('250-mock\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (/^AUTH PLAIN/i.test(line)) {
          const [, user, pass] = Buffer.from(line.split(' ')[2]!, 'base64').toString().split('\0');
          cur.auth = `${user}:${pass}`;
          sock.write(pass === expectPassword ? '235 ok\r\n' : '535 bad credentials\r\n');
        } else if (/^MAIL FROM/i.test(line)) {
          cur.from = line;
          sock.write('250 ok\r\n');
        } else if (/^RCPT TO/i.test(line)) {
          cur.to = line;
          sock.write('250 ok\r\n');
        } else if (/^DATA/i.test(line)) {
          mode = 'data';
          sock.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('500 what\r\n');
      }
    });
  });
  return new Promise<{ port: number; received: typeof received; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        received,
        close: () => server.close(),
      }),
    ),
  );
}

beforeAll(async () => {
  blobDir = mkdtempSync(path.join(tmpdir(), 'arklock-sys-'));
  ({ app, database } = await createTestApp({ BLOB_DIR: blobDir }));
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(app, 'bob@example.com', 'bob-password-12345');
  expect((await bob.register()).statusCode).toBe(201);
  await admin.login();
  await bob.login();
});

afterAll(async () => {
  await app.close();
  rmSync(blobDir, { recursive: true, force: true });
});

describe('access to every administration route', () => {
  it('no administrative route is reachable without the administrator role', async () => {
    const routes = app.routeTable.filter((r) => r.url.startsWith('/api/v1/admin'));
    expect(routes.length).toBeGreaterThan(20);
    const uuid = crypto.randomUUID();
    let checked = 0;
    for (const r of routes) {
      if (r.method === 'HEAD' || r.method === 'OPTIONS') continue;
      // сотрудник, получающий сотни отказов по объектам за минуты, ограничивается защитой от перебора: каждые 100 запросов — новый сеанс
      if (++checked % 100 === 0) await bob.login();
      const url = r.url.replace(/:[A-Za-z]+/g, uuid);
      const anon = await app.inject({ method: r.method as 'GET', url });
      expect(anon.statusCode, `${r.method} ${url} anonymous`).toBe(401);
      const member = await bob.req(
        r.method as 'GET',
        url.replace('/api/v1', ''),
        r.method === 'GET' ? undefined : {},
      );
      expect(member.statusCode, `${r.method} ${url} member`).toBe(403);
    }
  });
});

describe('overview, resources, storage, diagnostics', () => {
  it('overview reports counts without secrets', async () => {
    const r = await admin.req('GET', '/admin/overview');
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.counts.users).toBe(2);
    expect(j.counts.lockers).toBe(2);
    expect(j.database.ok).toBe(true);
    expect(j.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(j)).not.toContain('password');
  });

  it('disk thresholds: warning below 10 % or 2 GiB, failure below 5 % or 500 MiB', () => {
    expect(diskLevel(50 * GIB, 100 * GIB)).toBe('ok');
    expect(diskLevel(9 * GIB, 100 * GIB)).toBe('warn');
    expect(diskLevel(1.5 * GIB, 20 * GIB)).toBe('warn');
    expect(diskLevel(4 * GIB, 100 * GIB)).toBe('fail');
    expect(diskLevel(400 * 1024 * 1024, 1000 * GIB)).toBe('fail');
    expect(diskLevel(0, 0)).toBe('ok');
  });

  it('resources lists CPU, memory and disks', async () => {
    const j = (await admin.req('GET', '/admin/resources')).json();
    expect(j.cpu.cores).toBeGreaterThan(0);
    expect(j.memory.totalBytes).toBeGreaterThan(0);
    expect(j.disks.some((d: { id: string }) => d.id === 'attachments')).toBe(true);
    expect(['ok', 'warn', 'fail']).toContain(j.disks[0].level);
  });

  it('storage reconciliation reports orphans and removes them only on request', async () => {
    const id = crypto.randomUUID();
    const dir = path.join(blobDir, id.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.k1`);
    writeFileSync(file, 'junk');
    const before = (await admin.req('GET', '/admin/storage')).json();
    const att = before.categories.find((c: { id: string }) => c.id === 'attachments');
    expect(att.orphans).toBe(1);
    expect(att.status).toBe('warn');
    const report = (await admin.req('POST', '/admin/storage/reconcile', {})).json();
    expect(report.applied).toBe(false);
    expect(report.before.orphans).toBe(1);
    expect(
      (await admin.req('GET', '/admin/storage')).json().categories[1].orphans,
      'report must not delete',
    ).toBe(1);
    const applied = (await admin.req('POST', '/admin/storage/reconcile', { apply: true })).json();
    expect(applied.removed.orphans).toBe(1);
    expect((await admin.req('GET', '/admin/storage')).json().categories[1].orphans).toBe(0);
  });

  it('a row without its file is a failure in storage and diagnostics', async () => {
    const { locker } = await admin.lockerKey();
    const e = await admin.createEntry({ title: 'x' });
    await database.db.insert(attachments).values({
      id: crypto.randomUUID(),
      vaultId: locker.id,
      entryId: e.entryId,
      wrappedKey: 'k',
      metaCipher: 'm',
      keyVersion: 1,
      size: 10,
      status: 'ready',
      createdBy: admin.userId,
    });
    const st = (await admin.req('GET', '/admin/storage')).json().categories[1];
    expect(st.missing).toBe(1);
    expect(st.status).toBe('fail');
    const d = (await admin.req('GET', '/admin/diagnostics')).json();
    const c = d.checks.find((x: { id: string }) => x.id === 'blobs-consistency');
    expect(c).toMatchObject({
      level: 'fail',
      state: 'blobs-consistency.missing',
      params: { n: 1 },
    });
    expect(d.level).toBe('fail');
    await database.db.delete(attachments);
  });

  it('every diagnostic carries a known state code, and its level matches the state', async () => {
    const d = (await admin.req('GET', '/admin/diagnostics')).json();
    expect(d.checks.length).toBeGreaterThanOrEqual(6);
    for (const c of d.checks) {
      expect(['ok', 'warn', 'fail']).toContain(c.level);
      // тексты строит интерфейс по коду: сервер не отдаёт фраз на одном языке
      expect(DIAGNOSTIC_STATES).toContain(c.state);
      expect(c.state.endsWith('.ok'), c.id).toBe(c.level === 'ok');
      expect(c.title).toBeUndefined();
    }
  });
});

describe('mail (SMTP)', () => {
  it('the password is stored sealed, never returned, and used only for the connection', async () => {
    const smtp = await mockSmtp('s3cret-smtp-pass');
    try {
      expect((await admin.req('GET', '/admin/smtp')).json()).toEqual({ configured: false });
      expect((await admin.req('POST', '/admin/smtp/test')).statusCode).toBe(409);
      const put = await admin.reqStep('PUT', '/admin/smtp', {
        host: '127.0.0.1',
        port: smtp.port,
        security: 'none',
        user: 'mailer',
        password: 's3cret-smtp-pass',
        from: 'arklock@example.com',
      });
      expect(put.statusCode).toBe(200);
      const got = (await admin.req('GET', '/admin/smtp')).json();
      expect(got).toMatchObject({
        configured: true,
        host: '127.0.0.1',
        user: 'mailer',
        hasPassword: true,
      });
      expect(JSON.stringify(got)).not.toContain('s3cret-smtp-pass');
      const [row] = await database.db
        .select()
        .from(settings)
        .where((await import('drizzle-orm')).eq(settings.key, 'smtp.config'));
      expect(JSON.stringify(row)).not.toContain('s3cret-smtp-pass');

      const test = (await admin.req('POST', '/admin/smtp/test')).json();
      expect(test.ok).toBe(true);
      expect(smtp.received).toHaveLength(0);

      const sent = (
        await admin.req('POST', '/admin/smtp/send-test', { to: 'boss@example.com' })
      ).json();
      expect(sent.ok).toBe(true);
      expect(smtp.received).toHaveLength(1);
      expect(smtp.received[0]!.to).toContain('boss@example.com');
      expect(smtp.received[0]!.auth).toBe('mailer:s3cret-smtp-pass');
      expect(smtp.received[0]!.data).toContain('Subject:');

      // сохранение без пароля оставляет прежний; неверный пароль даёт понятный отказ
      await admin.reqStep('PUT', '/admin/smtp', {
        host: '127.0.0.1',
        port: smtp.port,
        security: 'none',
        user: 'mailer',
        from: 'arklock@example.com',
      });
      expect((await admin.req('POST', '/admin/smtp/test')).json().ok).toBe(true);
      await admin.reqStep('PUT', '/admin/smtp', {
        host: '127.0.0.1',
        port: smtp.port,
        security: 'none',
        user: 'mailer',
        password: 'wrong',
        from: 'arklock@example.com',
      });
      const bad = (await admin.req('POST', '/admin/smtp/test')).json();
      expect(bad.ok).toBe(false);
      expect(bad.message).toContain('AUTH');
      // внедрение команд через адрес получателя невозможно
      await admin.reqStep('PUT', '/admin/smtp', {
        host: '127.0.0.1',
        port: smtp.port,
        security: 'none',
        user: 'mailer',
        password: 's3cret-smtp-pass',
        from: 'arklock@example.com',
      });
      const inj = (
        await admin.req('POST', '/admin/smtp/send-test', {
          to: 'a@example.com>\r\nRCPT TO:<evil@example.com',
        })
      ).json();
      expect(inj.ok).toBe(false);
      expect(smtp.received).toHaveLength(1);
    } finally {
      smtp.close();
    }
  });

  it('an unreachable server is reported, not thrown', async () => {
    await admin.reqStep('PUT', '/admin/smtp', {
      host: '127.0.0.1',
      port: 1,
      security: 'none',
      from: 'a@example.com',
    });
    const r = (await admin.req('POST', '/admin/smtp/test')).json();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('connect');
  });
});

describe('certificates', () => {
  it('lists nothing without a public https address and reports unreachable nodes honestly', async () => {
    expect((await admin.req('GET', '/admin/certificates')).json().items).toEqual([]);
    const probe = await probeCertificate('127.0.0.1', 1, 2000);
    expect(probe.ok).toBe(false);
    expect(probe.level).toBe('fail');
  });
});
