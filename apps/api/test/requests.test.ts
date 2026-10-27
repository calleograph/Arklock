import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBase64Url } from '@arklock/crypto';
import { classify } from '../src/shield/requests.js';
import { settings } from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let chief: TestClient;
const ip = (a: string) => ({ 'x-forwarded-for': a });

beforeAll(async () => {
  fixture = await createTestApp();
  chief = new TestClient(fixture.app, 'waf-chief@example.com', 'waf-chief-password-123');
  expect((await chief.register()).statusCode).toBe(201);
  await chief.login();
});
afterAll(async () => fixture.app.close());

const get = (url: string, headers: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET') =>
  fixture.app.inject({ method, url, headers });
const events = async (rule: string) => {
  await fixture.app.securityLog.flush();
  const r = await chief.req(
    'GET',
    `/admin/shield/events?period=all&rule=${encodeURIComponent(rule)}`,
  );
  return r.json().items as { kind: string; level: string; detail: Record<string, unknown> }[];
};
const reauth = async () => ({
  'x-reauth-token': (
    await chief.req('POST', '/admin/reauth', {
      authKey: toBase64Url((await chief.derive()).keys.authKey),
    })
  ).json().token as string,
});

describe('request rules', () => {
  it('hides scanner targets behind a plain 404 and records them', async () => {
    for (const p of [
      '/.env',
      '/wp-login.php',
      '/phpmyadmin/',
      '/.git/config',
      '/backup.sql',
      '/x/../../etc/passwd',
    ])
      expect([400, 404], p).toContain((await get(p, ip('198.51.100.60'))).statusCode);
    const ev = await events('scan.sensitive-path');
    expect(ev.some((e) => e.kind === 'waf_blocked')).toBe(true);
    // ответ не подтверждает, что путь «известен»: тот же 404, что и для любого другого
    const other = await get('/definitely-not-here', ip('198.51.100.61'));
    const env = await get('/.env', ip('198.51.100.62'));
    expect(env.statusCode).toBe(other.statusCode);
  });

  it('blocks path traversal and unexpected methods', async () => {
    expect((await get('/api/v1/health/..%2f..%2fetc', ip('198.51.100.63'))).statusCode).toBe(400);
    expect((await get('/api/v1/health/%00', ip('198.51.100.63'))).statusCode).toBe(400);
    const trace = await fixture.app.inject({
      method: 'TRACE' as never,
      url: '/api/v1/health',
      headers: ip('198.51.100.64'),
    });
    expect([405, 404]).toContain(trace.statusCode);
  });

  it('turns repeated scanning into a temporary address block', async () => {
    const scanner = '198.51.100.65';
    for (let i = 0; i < 20; i++) await get(`/.git/${i}`, ip(scanner));
    await new Promise((r) => setTimeout(r, 100));
    const r = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: ip(scanner),
      payload: { email: 'x@example.com', authKey: 'A'.repeat(43) },
    });
    expect(r.statusCode).toBe(429);
  });

  it('observes injection patterns first, and blocks them once switched to protection', async () => {
    const url = "/api/v1/health?q=1'%20or%20'1'%3D'1";
    expect((await get(url, ip('198.51.100.66'))).statusCode).toBe(200);
    expect((await events('inject.sql-pattern')).some((e) => e.kind === 'waf_observed')).toBe(true);
    const h = await reauth();
    const set = await fixture.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/shield/rules/inject.sql-pattern',
      headers: { ...chief.authHeader(), ...h },
      payload: { mode: 'protect' },
    });
    expect(set.statusCode).toBe(204);
    expect((await get(url, ip('198.51.100.67'))).statusCode).toBe(403);
    // обычный запрос с похожими словами в пути не блокируется
    expect((await get('/api/v1/health?name=union', ip('198.51.100.68'))).statusCode).toBe(200);
    const xss = await get(
      '/api/v1/health?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      ip('198.51.100.69'),
    );
    expect(xss.statusCode).toBe(200); // XSS-правило ещё в режиме наблюдения
    expect((await events('inject.xss-pattern')).length).toBeGreaterThan(0);
  });

  it('rejects unexpected media types but lets legitimate bodies through', async () => {
    const bad = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...ip('198.51.100.70'), 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(bad.statusCode).toBe(415);
    await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...ip('198.51.100.72'), 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=b',
    });
    // формы нужны обратному вызову SAML: правило их не отклоняет и не записывает
    const seen = (await chief.req('GET', '/admin/shield/events?period=all&ip=198.51.100.72')).json()
      .items;
    expect(seen.some((e: { kind: string }) => e.kind === 'waf_blocked')).toBe(false);
  });

  it('never inspects request bodies', async () => {
    const r = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: ip('198.51.100.71'),
      payload: { email: "x' or '1'='1@example.com", authKey: 'A'.repeat(43) },
    });
    expect(r.statusCode).not.toBe(403);
  });

  it('cannot be fully switched off: only two modes exist', async () => {
    const h = await reauth();
    const bad = await fixture.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/shield/rules/path.traversal',
      headers: { ...chief.authHeader(), ...h },
      payload: { mode: 'off' },
    });
    expect(bad.statusCode).toBe(400);
    const table = (await chief.req('GET', '/admin/shield/rules')).json();
    expect(table.rules.length).toBeGreaterThan(4);
    expect(table.limits.every((l: { min: number }) => l.min >= 60)).toBe(true);
  });
});

describe('limit classes', () => {
  it('classifies routes and exempts updates and streamed attachments', () => {
    expect(classify('POST', '/api/v1/auth/login')).toBe('auth');
    expect(classify('GET', '/api/v1/vaults/x/entries')).toBe('secrets');
    expect(classify('PUT', '/api/v1/vaults/x/members/y')).toBe('keys');
    expect(classify('GET', '/api/v1/admin/users')).toBe('admin');
    expect(classify('PUT', '/api/v1/admin/webhooks/a')).toBe('integrations');
    expect(classify('POST', '/api/v1/admin/updates')).toBeNull();
    expect(classify('GET', '/api/v1/vaults/x/attachments/y/content')).toBeNull();
    expect(classify('GET', '/api/v1/ready')).toBeNull();
    expect(classify('GET', '/assets/app.js')).toBeNull();
  });

  it('rejects a runaway client with 429 and Retry-After, per session, and records it', async () => {
    const g = fixture.app.requests;
    const saved = g.limits.admin;
    g.limits.admin = 5;
    try {
      let last = 0;
      let retry = '';
      for (let i = 0; i < 12; i++) {
        const r = await fixture.app.inject({
          url: '/api/v1/admin/shield/whoami',
          headers: { ...chief.authHeader(), ...ip('203.0.113.9') },
        });
        last = r.statusCode;
        retry = String(r.headers['retry-after'] ?? '');
      }
      expect(last).toBe(429);
      expect(Number(retry)).toBeGreaterThan(0);
      // другой адрес без сеанса не затронут
      expect((await get('/api/v1/auth/registration', ip('203.0.113.10'))).statusCode).toBe(200);
    } finally {
      g.limits.admin = saved;
    }
    expect((await events('rate.admin')).length).toBeGreaterThan(0);
  });
});

describe('identifier probing', () => {
  it('warns, then throttles the session that enumerates other people’s objects', async () => {
    await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
    const member = new TestClient(fixture.app, 'waf-member@example.com', 'waf-member-password-123');
    expect((await member.register()).statusCode).toBe(201);
    await member.login();
    const g = fixture.app.requests;
    const saved = { ...g.probing };
    g.probing = { warn: 5, block: 10 };
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 14; i++)
        statuses.push(
          (
            await fixture.app.inject({
              url: `/api/v1/vaults/${crypto.randomUUID()}/entries`,
              headers: { ...member.authHeader(), ...ip('203.0.113.20') },
            })
          ).statusCode,
        );
      expect(statuses.slice(0, 5).every((s) => s === 404)).toBe(true);
      expect(statuses[13]).toBe(429);
      const ev = await events('probing.ids');
      expect(ev.some((e) => e.level === 'warn')).toBe(true);
      expect(ev.some((e) => e.level === 'critical')).toBe(true);
      // ответ о чужом и о несуществующем сейфе одинаков
      expect(statuses[0]).toBe(404);
    } finally {
      g.probing = saved;
    }
  });
});
