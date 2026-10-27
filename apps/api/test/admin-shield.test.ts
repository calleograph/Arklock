import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBase64Url } from '@arklock/crypto';
import { eq } from 'drizzle-orm';
import { settings } from '../src/db/schema.js';
import { TestClient, cheapCaptcha, createTestApp } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let chief: TestClient;
let member: TestClient;
const ADMIN_IP = '203.0.113.5';

beforeAll(async () => {
  fixture = await createTestApp();
  await cheapCaptcha(fixture.app, fixture.database);
  chief = new TestClient(fixture.app, 'shield-chief@example.com', 'shield-chief-password-1');
  expect((await chief.register()).statusCode).toBe(201);
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  member = new TestClient(fixture.app, 'shield-member@example.com', 'shield-member-password-1');
  expect((await member.register()).statusCode).toBe(201);
  await chief.login();
  await member.login();
});
afterAll(async () => fixture.app.close());

const reauth = async (c: TestClient) =>
  (
    await c.req('POST', '/admin/reauth', {
      authKey: toBase64Url((await c.derive()).keys.authKey),
    })
  ).json().token as string;

async function call(
  c: TestClient,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  opts: { ip?: string; step?: boolean } = {},
) {
  return fixture.app.inject({
    method,
    url: '/api/v1' + url,
    headers: {
      ...c.authHeader(),
      'x-forwarded-for': opts.ip ?? ADMIN_IP,
      ...(opts.step ? { 'x-reauth-token': await reauth(c) } : {}),
    },
    payload: payload as never,
  });
}

describe('the section is for the chief administrator only', () => {
  it('refuses an ordinary employee on every route', async () => {
    for (const [m, u] of [
      ['GET', '/admin/shield/overview'],
      ['GET', '/admin/shield/events'],
      ['GET', '/admin/shield/blocks'],
      ['GET', '/admin/shield/access'],
      ['PUT', '/admin/shield/settings'],
      ['POST', '/admin/shield/blocks'],
    ] as const)
      expect([401, 403], `${m} ${u}`).toContain((await call(member, m, u, {})).statusCode);
  });

  it('shows real numbers on the overview and marks unknown parts', async () => {
    const o = (await call(chief, 'GET', '/admin/shield/overview')).json();
    expect(o.loginProtection.active).toBe(true);
    expect(o.unknown).toEqual([]);
    expect(typeof o.last24h.failedLogins).toBe('number');
    expect(Array.isArray(o.hourly)).toBe(true);
  });
});

describe('settings', () => {
  it('requires re-confirmation, validates bounds and keeps protection on', async () => {
    expect(
      (await call(chief, 'PUT', '/admin/shield/settings', { captchaAfter: 4 })).json().error.code,
    ).toBe('reauth_required');
    const ok = await call(
      chief,
      'PUT',
      '/admin/shield/settings',
      { captchaAfter: 4 },
      { step: true },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().captchaAfter).toBe(4);
    // нельзя «выключить» защиту: порог проверки не выше 20, окно не короче минуты
    for (const bad of [
      { captchaAfter: 0 },
      { captchaAfter: 500 },
      { windowMinutes: 0 },
      { blockMinutes: 0 },
    ])
      expect(
        (await call(chief, 'PUT', '/admin/shield/settings', bad, { step: true })).statusCode,
      ).toBe(400);
    await call(chief, 'PUT', '/admin/shield/settings', { captchaAfter: 5 }, { step: true });
  });
});

describe('allowed subnets are protected against self-lockout', () => {
  it('refuses to enable with no rules or without the administrator address', async () => {
    const none = await call(
      chief,
      'POST',
      '/admin/shield/access/enable',
      { acknowledge: true },
      { step: true },
    );
    expect(none.json().error.code).toBe('rules_required');
    expect(
      (
        await call(
          chief,
          'POST',
          '/admin/shield/access/rules',
          { cidr: '192.0.2.0/24', comment: 'Офис' },
          { step: true },
        )
      ).statusCode,
    ).toBe(201);
    const out = await call(
      chief,
      'POST',
      '/admin/shield/access/enable',
      { acknowledge: true },
      { step: true },
    );
    expect(out.statusCode).toBe(409);
    expect(out.json().error.code).toBe('would_lock_out');
    expect((await call(chief, 'GET', '/admin/shield/access')).json().enabled).toBe(false);
  });

  it('rejects malformed rules and accepts IPv4 and IPv6 forms', async () => {
    for (const cidr of ['not-an-ip', '192.0.2.0/33', '192.0.2.1/24/1', '2001:db8::/129'])
      expect(
        (await call(chief, 'POST', '/admin/shield/access/rules', { cidr }, { step: true }))
          .statusCode,
      ).toBe(400);
    for (const cidr of ['203.0.113.0/24', '2001:db8::/32', '198.51.100.7'])
      expect(
        (await call(chief, 'POST', '/admin/shield/access/rules', { cidr }, { step: true }))
          .statusCode,
      ).toBe(201);
  });

  it('enables in confirmation mode, blocks other addresses, and rolls back unconfirmed changes', async () => {
    const on = await call(
      chief,
      'POST',
      '/admin/shield/access/enable',
      { acknowledge: true },
      { step: true },
    );
    expect(on.statusCode).toBe(200);
    // чужой адрес — отказ ещё до обработки запроса, на любом пути
    for (const url of ['/api/v1/health', '/api/v1/auth/registration', '/']) {
      const r = await fixture.app.inject({ url, headers: { 'x-forwarded-for': '198.51.100.200' } });
      expect(r.statusCode, url).toBe(403);
    }
    // разрешённый адрес и консоль сервера проходят
    expect((await call(chief, 'GET', '/admin/shield/access')).statusCode).toBe(200);
    expect((await fixture.app.inject({ url: '/api/v1/health' })).statusCode).toBe(200);
    // подмена заголовка не открывает доступ: адрес берёт прокси, доверенный по числу звеньев
    const spoof = await fixture.app.inject({
      url: '/api/v1/auth/registration',
      headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.200' },
    });
    expect(spoof.statusCode).toBe(403);
    // подтверждение снимает таймер отката
    expect((await call(chief, 'POST', '/admin/shield/access/confirm')).json().confirmed).toBe(true);
    expect(fixture.app.shield).toBeDefined();
    // нельзя удалить правило, под которое подпадает сам администратор
    const rules = (await call(chief, 'GET', '/admin/shield/access')).json().rules as {
      id: string;
      cidr: string;
    }[];
    const own = rules.find((r) => r.cidr === '203.0.113.0/24')!;
    const del = await call(chief, 'DELETE', `/admin/shield/access/rules/${own.id}`, undefined, {
      step: true,
    });
    expect(del.statusCode).toBe(409);
  });

  it('rolls back on the server when the confirmation never arrives', async () => {
    await call(chief, 'POST', '/admin/shield/access/disable', {}, { step: true });
    await call(chief, 'POST', '/admin/shield/access/enable', { acknowledge: true }, { step: true });
    // имитация «администратор не подтвердил»: срок истёк
    await fixture.database.db
      .update(settings)
      .set({ value: { enabled: true, confirmBy: Date.now() - 1000 } })
      .where(eq(settings.key, 'security.access'));
    // сервер сам читает состояние (раз в 10 секунд) и откатывает: здесь — тот же разбор состояния
    await fixture.app.access.reload();
    const state = await fixture.database.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'security.access'));
    expect((state[0]!.value as { enabled: boolean }).enabled).toBe(false);
    expect(
      (
        await fixture.app.inject({
          url: '/api/v1/health',
          headers: { 'x-forwarded-for': '198.51.100.200' },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('trusted proxies are separate from allowed subnets', () => {
  it('rejects a catch-all proxy and stores a valid list', async () => {
    expect(
      (await call(chief, 'PUT', '/admin/shield/proxies', { cidrs: ['0.0.0.0/0'] }, { step: true }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          chief,
          'PUT',
          '/admin/shield/proxies',
          { cidrs: ['not-a-subnet'] },
          { step: true },
        )
      ).statusCode,
    ).toBe(400);
    const ok = await call(
      chief,
      'PUT',
      '/admin/shield/proxies',
      { cidrs: ['192.0.2.128/25'] },
      { step: true },
    );
    expect(ok.json().cidrs).toEqual(['192.0.2.128/25']);
    // этот список не разрешает доступ клиентам и не зависит от подсетей доступа
    const rules = (await call(chief, 'GET', '/admin/shield/access')).json().rules as {
      cidr: string;
    }[];
    expect(rules.some((r) => r.cidr.startsWith('192.0.2.128'))).toBe(false);
    await call(chief, 'PUT', '/admin/shield/proxies', { cidrs: [] }, { step: true });
  });
});

describe('blocks and events', () => {
  it('blocks manually, refuses to block yourself, releases, and keeps history', async () => {
    const own = await call(
      chief,
      'POST',
      '/admin/shield/blocks',
      { ip: ADMIN_IP, minutes: 10, reason: 'тест' },
      { step: true },
    );
    expect(own.statusCode).toBe(409);
    const made = await call(
      chief,
      'POST',
      '/admin/shield/blocks',
      { ip: '192.0.2.77', minutes: 10, reason: 'Подозрительный сканер' },
      { step: true },
    );
    expect(made.statusCode).toBe(201);
    const blocked = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': '192.0.2.77' },
      payload: { email: 'x@example.com', authKey: 'A'.repeat(43) },
    });
    expect(blocked.statusCode).toBe(429);
    const list = (await call(chief, 'GET', '/admin/shield/blocks')).json();
    expect(list.active.some((b: { ip: string }) => b.ip === '192.0.2.77')).toBe(true);
    const id = made.json().id as string;
    expect(
      (await call(chief, 'POST', `/admin/shield/blocks/${id}/release`, {}, { step: true }))
        .statusCode,
    ).toBe(204);
    const after = (await call(chief, 'GET', '/admin/shield/blocks')).json();
    expect(after.active.some((b: { id: string }) => b.id === id)).toBe(false);
    expect(
      after.history.some((b: { id: string; releasedBy: string }) => b.id === id && b.releasedBy),
    ).toBe(true);
  });

  it('lists events with filters and server-side pagination, without secrets', async () => {
    await fixture.app.securityLog.flush();
    const all = (await call(chief, 'GET', '/admin/shield/events?period=all&pageSize=10')).json();
    expect(all.total).toBeGreaterThan(0);
    expect(all.items.length).toBeLessThanOrEqual(10);
    const crit = (
      await call(chief, 'GET', '/admin/shield/events?period=all&level=critical')
    ).json();
    expect(crit.items.every((e: { level: string }) => e.level === 'critical')).toBe(true);
    const dump = JSON.stringify(all);
    expect(dump).not.toContain('authKey');
    expect(dump).not.toContain('password');
    expect((await call(chief, 'GET', '/admin/shield/events?pageSize=1000')).statusCode).toBe(400);
  });
});
