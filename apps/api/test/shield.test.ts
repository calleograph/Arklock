import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { securityBlocks, securityEvents, settings } from '../src/db/schema.js';
import { SecurityLog } from '../src/shield/events.js';
import { Shield } from '../src/shield/throttle.js';
import { APP_SECRET, TestClient, createTestApp, solveChallenge } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let owner: TestClient;
const ipOf = (a: string) => ({ 'x-forwarded-for': a });
const fails = async (c: TestClient, n: number, ip: string) => {
  for (let i = 0; i < n; i++)
    expect((await c.loginRaw('wrong-' + i, { solve: false, headers: ipOf(ip) })).statusCode).toBe(
      401,
    );
};
const code = (r: { json(): { error?: { code?: string } } }) => r.json().error?.code;

beforeAll(async () => {
  ({ app, database } = await createTestApp());
  // в тестах сложность проверки минимальная (12 бит): иначе сотни решений занимают минуты; формат и проверка те же
  await database.db
    .insert(settings)
    .values({ key: 'security.shield', value: { captchaBits: 12, captchaMaxBits: 14 } });
  await app.shield.reloadPolicy();
  owner = new TestClient(app, 'owner@example.com', 'owner-password-12345');
  expect((await owner.register()).statusCode).toBe(201);
  await owner.login();
});
afterAll(async () => {
  await app.close();
});

describe('login protection', () => {
  it('asks for verification after five failures; the server refuses the right password without it', async () => {
    await fails(owner, 5, '198.51.100.10');
    const r = await owner.loginRaw(undefined, { solve: false, headers: ipOf('198.51.100.10') });
    expect(r.statusCode).toBe(403);
    expect(code(r)).toBe('captcha_required');
  });

  it('a direct request with a forged or missing solution is refused and a solution works once', async () => {
    const ip = '198.51.100.11';
    await fails(owner, 5, ip);
    const first = await owner.loginRaw(undefined, { solve: false, headers: ipOf(ip) });
    const challenge = first.json().error.details.captcha;
    const { keys } = await owner.derive();
    const { toBase64Url } = await import('@arklock/crypto');
    const post = (captcha: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: ipOf(ip),
        payload: { email: owner.email, authKey: toBase64Url(keys.authKey), captcha },
      });
    // подделка: число, не дающее нужных нулевых бит
    expect(code(await post({ ...challenge, number: 1 }))).toBe('captcha_required');
    // подпись другого задания
    const other = (await owner.loginRaw(undefined, { solve: false, headers: ipOf(ip) })).json()
      .error.details.captcha;
    expect(code(await post({ ...solveChallenge(challenge), sig: other.sig }))).toBe(
      'captcha_required',
    );
    // верное решение принимается один раз
    const solved = solveChallenge(challenge);
    expect((await post(solved)).statusCode).toBe(200);
    expect(code(await post(solved))).toBe('captcha_required');
  });

  it('is independent of cookies, user agent and browser state: only the server counts', async () => {
    const ip = '198.51.100.12';
    for (let i = 0; i < 5; i++)
      await owner.loginRaw('bad' + i, {
        solve: false,
        headers: { ...ipOf(ip), 'user-agent': 'UA-' + i },
      });
    const r = await owner.loginRaw(undefined, {
      solve: false,
      headers: { ...ipOf(ip), 'user-agent': 'a-completely-different-browser', cookie: '' },
    });
    expect(code(r)).toBe('captcha_required');
  });

  it('failures from other addresses do not lock the owner out', async () => {
    for (let n = 0; n < 12; n++)
      await owner.loginRaw('spray' + n, { solve: false, headers: ipOf(`203.0.113.${n + 1}`) });
    // владелец с «своего» адреса, где уже входил: без проверки и без блокировки
    const known = await owner.loginRaw(undefined, { solve: false, headers: ipOf('198.51.100.99') });
    // адрес незнакомый — просят проверку, но не отказывают
    expect([200, 403]).toContain(known.statusCode);
    if (known.statusCode === 403) expect(code(known)).toBe('captcha_required');
    const solved = await owner.loginRaw(undefined, { headers: ipOf('198.51.100.99') });
    expect(solved.statusCode).toBe(200);
  });

  it('blocks a pair, then a whole address; blocks survive a restart; release keeps history', async () => {
    // одна учётная запись с одного адреса: ограничивается пара «адрес + запись», остальные записи с адреса не затронуты
    const pairIp = '198.51.100.20';
    let status = 0;
    for (let i = 0; i < 40 && status !== 429; i++)
      status = (await owner.loginRaw('x' + i, { headers: ipOf(pairIp) })).statusCode;
    expect(status).toBe(429);
    const pairRow = (await database.db.select().from(securityBlocks)).find((r) =>
      r.key.startsWith(`pair:${pairIp}|`),
    )!;
    expect(pairRow.source).toBe('auto');
    const other = new TestClient(app, 'someone-else@example.com', 'x-password-12345');
    expect((await other.loginRaw('nope', { headers: ipOf(pairIp) })).statusCode).toBe(401);

    // много разных записей с одного адреса: блокируется адрес целиком
    const ip = '198.51.100.21';
    status = 0;
    for (let i = 0; i < 60 && status !== 429; i++)
      status = (
        await new TestClient(app, `spray${i}@example.com`, 'x-password-12345').loginRaw('nope', {
          headers: ipOf(ip),
        })
      ).statusCode;
    expect(status).toBe(429);
    const row = (await database.db.select().from(securityBlocks)).find(
      (r) => r.key === `ip:${ip}`,
    )!;
    expect(row.rule).toBe('ip.failures');
    // «перезапуск»: новый экземпляр читает блокировки из базы
    const fresh = new Shield(database.db, APP_SECRET, new SecurityLog(database.db));
    await fresh.refreshBlocks();
    expect(fresh.blockedFor(ip)?.seconds).toBeGreaterThan(0);
    // снятие не стирает историю
    expect(await fresh.release(row.id, 'test-admin')).toBe(true);
    const after = (
      await database.db.select().from(securityBlocks).where(eq(securityBlocks.id, row.id))
    )[0]!;
    expect(after.releasedAt).not.toBeNull();
    expect(fresh.blockedFor(ip)).toBeNull();
  });

  it('records security events without secrets and hashes the account', async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const rows = await database.db.select().from(securityEvents);
    expect(rows.length).toBeGreaterThan(5);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('owner@example.com');
    expect(dump).not.toContain('authKey');
    expect(rows.some((r) => r.kind === 'ip_blocked' && r.level === 'critical')).toBe(true);
    expect(rows.some((r) => r.kind === 'ip_unblocked')).toBe(true);
  });
});

describe('real client address', () => {
  it('does not trust X-Forwarded-For when no proxy is configured', async () => {
    const { app: direct } = await createTestApp({ TRUSTED_PROXY_HOPS: '0' });
    const c = new TestClient(direct, 'direct@example.com', 'direct-password-12345');
    await c.register();
    // подмена заголовка не даёт обойти счётчик: все попытки считаются на адрес сокета
    for (let i = 0; i < 5; i++)
      await c.loginRaw('bad' + i, { solve: false, headers: ipOf(`192.0.2.${i + 1}`) });
    const r = await c.loginRaw(undefined, { solve: false, headers: ipOf('192.0.2.200') });
    expect(code(r)).toBe('captcha_required');
    await direct.close();
  });

  it('takes the address added by the trusted proxy, not the one the client wrote', async () => {
    const { app: proxied } = await createTestApp({ TRUSTED_PROXY_HOPS: '1' });
    const c = new TestClient(proxied, 'proxied@example.com', 'proxied-password-12345');
    await c.register();
    // клиент прислал «чужой адрес», прокси добавил настоящий 192.0.2.50: считается последний
    for (let i = 0; i < 5; i++)
      await c.loginRaw('bad' + i, {
        solve: false,
        headers: ipOf(`198.51.100.${100 + i}, 192.0.2.50`),
      });
    const r = await c.loginRaw(undefined, {
      solve: false,
      headers: ipOf('198.51.100.250, 192.0.2.50'),
    });
    expect(code(r)).toBe('captcha_required');
    await proxied.close();
  });
});
