import dgram from 'node:dgram';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { formatSyslog } from '../src/syslog.js';
import { settings } from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

/** Проверка, доходят ли UDP-датаграммы по петле (в некоторых средах разработки они блокируются файрволом). */
const udpWorks = await new Promise<boolean>((resolve) => {
  const rx = dgram.createSocket('udp4');
  rx.on('message', () => {
    rx.close();
    resolve(true);
  });
  rx.bind(0, '127.0.0.1', () => {
    const tx = dgram.createSocket('udp4');
    tx.send('probe', rx.address().port, '127.0.0.1', () => tx.close());
  });
  setTimeout(() => {
    try {
      rx.close();
    } catch {
      /* уже закрыт */
    }
    resolve(false);
  }, 700);
});

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let admin: TestClient;
const udpMessages: string[] = [];
const tcpMessages: string[] = [];
let udp: dgram.Socket;
let tcp: net.Server;
let udpPort = 0;
let tcpPort = 0;

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

beforeAll(async () => {
  udp = dgram.createSocket('udp4');
  udp.on('message', (m) => udpMessages.push(m.toString()));
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  udpPort = udp.address().port;
  // TCP-приёмник разбирает кадры «длина сообщение» (RFC 6587, подсчёт октетов)
  tcp = net.createServer((sock) => {
    let buf = '';
    sock.on('error', () => undefined);
    sock.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        const sp = buf.indexOf(' ');
        if (sp < 0) return;
        const len = Number(buf.slice(0, sp));
        if (!Number.isFinite(len) || buf.length < sp + 1 + len) return;
        tcpMessages.push(buf.slice(sp + 1, sp + 1 + len));
        buf = buf.slice(sp + 1 + len);
      }
    });
  });
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
  tcpPort = (tcp.address() as net.AddressInfo).port;

  ({ app, database } = await createTestApp());
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  await admin.login();
});

afterAll(async () => {
  await app.close();
  udp.close();
  tcp.close();
});

describe('syslog message format (RFC 5424)', () => {
  it('has priority, version, timestamp, app name, structured data and neutralises injection', () => {
    const msg = formatSyslog(
      {
        at: new Date('2026-10-12T01:02:03.000Z'),
        actor: 'user:abc',
        action: 'auth.login.failed',
        target: 'user:abc',
        detail: { ip: '203.0.113.9', note: 'a"b]c\\d\r\nINJECTED' },
      },
      'host1',
    );
    expect(msg).toMatch(
      /^<132>1 2026-10-12T01:02:03\.000Z host1 arklock - auth\.login\.failed \[arklock@0 /,
    );
    expect(msg).toContain('actor="user:abc"');
    expect(msg).toContain('result="failure"');
    expect(
      formatSyslog({
        at: new Date(),
        actor: 'user:abc',
        action: 'entry.create',
        target: null,
        detail: null,
      }),
    ).toContain('result="success"');
    expect(msg).toContain('ip="203.0.113.9"');
    expect(msg).toContain('note="a\\"b\\]c\\\\d INJECTED"'); // кавычки, скобка и обратная косая экранированы, перевод строки убран
    expect(msg.includes('\n')).toBe(false);
  });
});

describe('forwarding of ledger events', () => {
  it('only administrators can see or change the settings', async () => {
    const m = new TestClient(app, 'member@example.com', 'member-password-1234');
    expect((await m.register()).statusCode).toBe(201);
    await m.login();
    expect((await m.req('GET', '/admin/syslog')).statusCode).toBe(403);
    expect((await m.req('PUT', '/admin/syslog', {})).statusCode).toBe(403);
  });

  it('an unreachable TCP collector is reported by the test message', async () => {
    const bad = await admin.req('POST', '/admin/syslog/test', {
      enabled: true,
      host: '127.0.0.1',
      port: 1,
      protocol: 'tcp',
    });
    expect(bad.json().ok).toBe(false);
    expect(bad.json().message).toBeTruthy();
  });

  it.skipIf(!udpWorks)('the test message reaches a UDP collector', async () => {
    const ok = await admin.req('POST', '/admin/syslog/test', {
      enabled: true,
      host: '127.0.0.1',
      port: udpPort,
      protocol: 'udp',
    });
    expect(ok.json().ok).toBe(true);
    expect(await until(() => udpMessages.some((m) => m.includes('admin.syslog.test')))).toBe(true);
  });

  it.skipIf(!udpWorks)(
    'events go to the collector over UDP once enabled; the prefix filter applies',
    async () => {
      udpMessages.length = 0;
      expect(
        (
          await admin.req('PUT', '/admin/syslog', {
            enabled: true,
            host: '127.0.0.1',
            port: udpPort,
            protocol: 'udp',
            prefixes: ['auth.'],
          })
        ).statusCode,
      ).toBe(200);
      await admin.login(); // auth.login
      await admin.req('PUT', '/admin/settings', { 'trash.retentionDays': 40 }); // не auth.*
      expect(await until(() => udpMessages.some((m) => m.includes(' auth.login ')))).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      expect(udpMessages.some((m) => m.includes('admin.settings'))).toBe(false);
      // секреты в сообщениях не встречаются
      for (const m of udpMessages) {
        expect(m).not.toContain('admin-password-123');
        expect(m).not.toContain('aks_');
      }
    },
  );

  it('events go over TCP with octet-counting framing', async () => {
    await admin.req('PUT', '/admin/syslog', {
      enabled: true,
      host: '127.0.0.1',
      port: tcpPort,
      protocol: 'tcp',
      prefixes: [],
    });
    tcpMessages.length = 0;
    await admin.req('PUT', '/admin/settings', { 'trash.retentionDays': 41 });
    await admin.login();
    expect(await until(() => tcpMessages.some((m) => m.includes('auth.login')))).toBe(true);
    expect(tcpMessages.every((m) => m.startsWith('<'))).toBe(true);
    expect(tcpMessages.some((m) => m.includes('auth.login'))).toBe(true);
    const st = (await admin.req('GET', '/admin/syslog')).json().status;
    expect(st.sent).toBeGreaterThan(0);
  });

  it('a dead collector never breaks the application; the failure is counted and shown', async () => {
    await admin.req('PUT', '/admin/syslog', {
      enabled: true,
      host: '127.0.0.1',
      port: 1,
      protocol: 'tcp',
      prefixes: [],
    });
    const before = (await admin.req('GET', '/admin/syslog')).json().status.failed;
    const res = await admin.loginRaw();
    expect(res.statusCode).toBe(200);
    expect(await until(async () => true)).toBe(true);
    await until(() => false, 600);
    const st = (await admin.req('GET', '/admin/syslog')).json().status;
    expect(st.failed).toBeGreaterThan(before);
    expect(st.lastError).toBeTruthy();
  });
});
