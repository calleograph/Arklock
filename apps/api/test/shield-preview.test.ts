import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBase64Url } from '@arklock/crypto';
import { count } from 'drizzle-orm';
import { securityBlocks, securityEvents, settings } from '../src/db/schema.js';
import { DEFAULT_POLICY, shieldPolicy } from '../src/shield/policy.js';
import { checkPolicy, describePolicy } from '../src/shield/preview.js';
import { TestClient, createTestApp, solveChallenge } from './helpers.js';

const ENV = { hops: 1, forwarded: false, authRatePerMinute: 240 };
const codes = (r: ReturnType<typeof checkPolicy>) => r.warnings.map((w) => w.code);

describe('policy check', () => {
  it('describes the defaults in plain numbers', () => {
    const r = checkPolicy({}, DEFAULT_POLICY, ENV);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.summary).toMatchObject({
      windowMinutes: 15,
      captchaAfter: 5,
      blockPairAfter: 10,
      blockIpAfter: 25,
      blockSteps: [5, 10, 20, 40, 80, 160, 320, 640],
      covered: ['login', 'recovery', 'directory'],
      alwaysOn: { authRatePerMinute: 240 },
      externalService: false,
    });
    expect(r.summary!.solveSeconds.slow).toBeGreaterThan(r.summary!.solveSeconds.fast);
    expect(
      describePolicy(shieldPolicy.parse({ blockMinutes: 1000, blockMaxMinutes: 1440 }), ENV)
        .blockSteps,
    ).toEqual([1000, 1440]);
  });

  it('rejects values out of range, thresholds that contradict each other and a block longer than its cap', () => {
    const fields = (c: unknown) =>
      checkPolicy(c, DEFAULT_POLICY, ENV).errors.map((e) => `${e.field}:${e.code}`);
    expect(fields({ captchaAfter: 0 })).toEqual(['captchaAfter:out_of_range']);
    expect(fields({ captchaAfter: 1000 })).toEqual(['captchaAfter:out_of_range']);
    expect(fields({ windowMinutes: -5 })).toEqual(['windowMinutes:out_of_range']);
    expect(fields({ blockMinutes: 1.5 })).toEqual(['blockMinutes:not_integer']);
    expect(fields({ blockMinutes: 'abc' })).toEqual(['blockMinutes:required']);
    expect(fields({ blockMinutes: 60, blockMaxMinutes: 30 })).toEqual([
      'blockMinutes:block_over_max',
    ]);
    expect(fields({ captchaAfter: 20, blockPairAfter: 3, blockIpAfter: 5 })).toEqual([
      'captchaAfter:inconsistent',
    ]);
    const bad = checkPolicy({ captchaAfter: 0 }, DEFAULT_POLICY, ENV);
    expect(bad).toMatchObject({ ok: false, effective: null, summary: null });
  });

  it('warns about the risk of locking many employees out, and about weakening the protection', () => {
    expect(codes(checkPolicy({ blockIpAfter: 8 }, DEFAULT_POLICY, ENV))).toContain(
      'ip_threshold_low',
    );
    expect(codes(checkPolicy({ blockPairAfter: 3 }, DEFAULT_POLICY, ENV))).toContain(
      'pair_threshold_low',
    );
    expect(codes(checkPolicy({ captchaAfter: 2 }, DEFAULT_POLICY, ENV))).toContain(
      'captcha_every_typo',
    );
    expect(codes(checkPolicy({ captchaAfter: 12 }, DEFAULT_POLICY, ENV))).toContain(
      'captcha_after_pair_block',
    );
    expect(codes(checkPolicy({ blockMinutes: 90 }, DEFAULT_POLICY, ENV))).toContain('long_block');
    expect(
      codes(checkPolicy({ windowMinutes: 200, blockIpAfter: 20 }, DEFAULT_POLICY, ENV)),
    ).toContain('long_window');
    expect(codes(checkPolicy({ captchaMaxBits: 22 }, DEFAULT_POLICY, ENV))).toContain(
      'slow_on_phones',
    );
    // прокси есть, а Arklock ему не доверяет: все сотрудники — один адрес
    expect(codes(checkPolicy({}, DEFAULT_POLICY, { ...ENV, hops: 0, forwarded: true }))).toContain(
      'proxy_not_trusted',
    );
    expect(
      codes(checkPolicy({}, DEFAULT_POLICY, { ...ENV, hops: 0, forwarded: false })),
    ).not.toContain('proxy_not_trusted');
    const weaker = checkPolicy({ captchaAfter: 8, blockMinutes: 1 }, DEFAULT_POLICY, ENV);
    expect(weaker.ok).toBe(true);
    expect(codes(weaker)).toContain('weaker_than_current');
    // поправка, которую сервер делает сам, показывается заранее
    const fixed = checkPolicy({ captchaBits: 20, captchaMaxBits: 15 }, DEFAULT_POLICY, ENV);
    expect(fixed.effective!.captchaMaxBits).toBe(20);
    expect(codes(fixed)).toContain('max_bits_raised');
    expect(codes(checkPolicy({}, DEFAULT_POLICY, ENV))).toEqual([]);
  });
});

describe('admin routes', () => {
  let fixture: Awaited<ReturnType<typeof createTestApp>>;
  let chief: TestClient;
  let other: TestClient;
  let employee: TestClient;
  const IP = '203.0.113.5';

  beforeAll(async () => {
    fixture = await createTestApp();
    // дешёвое задание: проверяется механизм, а не время подбора
    await fixture.database.db.insert(settings).values({
      key: 'security.shield',
      value: { captchaBits: 12, captchaMaxBits: 12, captchaAfter: 3 },
    });
    await fixture.app.shield.reloadPolicy();
    chief = new TestClient(fixture.app, 'sp-chief@example.com', 'sp-chief-password-1');
    expect((await chief.register()).statusCode).toBe(201);
    await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
    employee = new TestClient(fixture.app, 'sp-employee@example.com', 'sp-employee-password-1');
    expect((await employee.register()).statusCode).toBe(201);
    other = new TestClient(fixture.app, 'sp-other@example.com', 'sp-other-password-1');
    expect((await other.register()).statusCode).toBe(201);
    await chief.login();
    await employee.login();
  });
  afterAll(async () => fixture.app.close());

  const call = (
    c: TestClient,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fixture.app.inject({
      method,
      url: '/api/v1' + url,
      headers: { ...c.authHeader(), 'x-forwarded-for': IP, ...headers },
      payload: payload as never,
    });
  const blocks = async () =>
    (await fixture.database.db.select({ n: count() }).from(securityBlocks))[0]!.n;
  const failures = async () => {
    await fixture.app.securityLog.flush(); // события пишутся пачками
    const rows = await fixture.database.db.select().from(securityEvents);
    return rows.filter((r) =>
      ['login_failed', 'captcha_invalid', 'captcha_required'].includes(r.kind),
    ).length;
  };

  it('the check changes nothing, shows the effect, and needs the chief administrator but no password', async () => {
    const before = (await call(chief, 'GET', '/admin/shield/settings')).json();
    expect(before.summary).toMatchObject({ captchaAfter: 3, externalService: false });
    const r = await call(chief, 'POST', '/admin/shield/settings/check', {
      captchaAfter: 6,
      blockMinutes: 90,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, summary: { captchaAfter: 6 } });
    expect(r.json().warnings.map((w: { code: string }) => w.code)).toContain('long_block');
    const bad = await call(chief, 'POST', '/admin/shield/settings/check', { captchaAfter: 99 });
    expect(bad.json()).toMatchObject({
      ok: false,
      errors: [{ field: 'captchaAfter', code: 'out_of_range' }],
    });
    // ничего не сохранено
    const after = (await call(chief, 'GET', '/admin/shield/settings')).json();
    expect(after.captchaAfter).toBe(3);
    expect(after.blockMinutes).toBe(before.blockMinutes);
    expect((await call(employee, 'POST', '/admin/shield/settings/check', {})).statusCode).toBe(403);
    expect((await call(employee, 'GET', '/admin/shield/login/preview')).statusCode).toBe(403);
    const anon = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/admin/shield/login/preview',
    });
    expect(anon.statusCode).toBe(401);
  });

  it('the preview issues a real task, accepts a correct answer once and refuses wrong, reused and foreign answers', async () => {
    const issued = (await call(chief, 'GET', '/admin/shield/login/preview')).json();
    expect(issued).toMatchObject({ bits: 12, ttlSeconds: 300 });
    const good = solveChallenge(issued.challenge);
    expect(
      (await call(chief, 'POST', '/admin/shield/login/preview/verify', { solution: good })).json(),
    ).toEqual({ ok: true });
    // повтор того же решения не принимается: задание одноразовое
    expect(
      (await call(chief, 'POST', '/admin/shield/login/preview/verify', { solution: good })).json(),
    ).toEqual({ ok: false });
    // неверное число
    const second = (await call(chief, 'GET', '/admin/shield/login/preview')).json();
    expect(
      (
        await call(chief, 'POST', '/admin/shield/login/preview/verify', {
          solution: { ...second.challenge, number: Number.MAX_SAFE_INTEGER - 1 },
        })
      ).json(),
    ).toEqual({ ok: false });
    // подделанная сложность и подпись
    const forged = solveChallenge({ ...second.challenge, bits: 1 });
    expect(
      (
        await call(chief, 'POST', '/admin/shield/login/preview/verify', { solution: forged })
      ).json(),
    ).toEqual({ ok: false });
    // задание привязано к сеансу: чужой сеанс главного администратора его не примет
    const again = await chief.loginRaw();
    expect(again.statusCode).toBe(200);
    const mine = (await call(chief, 'GET', '/admin/shield/login/preview')).json();
    const token = again.json().token as string;
    const foreign = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/admin/shield/login/preview/verify',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': IP },
      payload: { solution: solveChallenge(mine.challenge) },
    });
    expect(foreign.json()).toEqual({ ok: false });
    expect(
      (await call(chief, 'POST', '/admin/shield/login/preview/verify', { solution: { id: 1 } }))
        .statusCode,
    ).toBe(400);
  });

  it('previews never count as failed sign-ins, never block the administrator and leave the counters alone', async () => {
    const e0 = await failures();
    const b0 = await blocks();
    for (let i = 0; i < 12; i++) {
      const t = (await call(chief, 'GET', '/admin/shield/login/preview')).json();
      await call(chief, 'POST', '/admin/shield/login/preview/verify', {
        solution: { ...t.challenge, number: 1 },
      });
    }
    expect(await failures()).toBe(e0);
    expect(await blocks()).toBe(b0);
    // администратор входит без дополнительной проверки: его счётчики чисты
    const login = await chief.loginRaw();
    expect(login.statusCode).toBe(200);
    const overview = (await call(chief, 'GET', '/admin/shield/overview')).json();
    expect(JSON.stringify(overview.blocks ?? {})).not.toContain('captcha_invalid');
  });

  it('the applied policy works on a real test account: the check appears after the configured number of failures', async () => {
    const policy = await call(
      chief,
      'PUT',
      '/admin/shield/settings',
      { captchaAfter: 4 },
      { 'x-reauth-token': await reauthToken() },
    );
    expect(policy.statusCode).toBe(200);
    const victim = new TestClient(fixture.app, 'sp-victim@example.com', 'sp-victim-password-1');
    expect((await victim.register()).statusCode).toBe(201);
    const attempt = (password: string, captcha?: unknown) =>
      fixture.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': '198.51.100.77' },
        payload: {
          email: 'sp-victim@example.com',
          authKey: toBase64Url(new Uint8Array(32).fill(password.length)),
          ...(captcha ? { captcha } : {}),
        },
      });
    const statuses: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await attempt('x'.repeat(i + 1));
      statuses.push(`${r.statusCode}:${r.json().error?.code ?? ''}`);
    }
    // 4 ошибки, затем сервер требует проверку; настоящий сервер, а не браузер, решает, когда
    expect(statuses.slice(0, 4).every((s) => s.startsWith('401') || s.startsWith('400'))).toBe(
      true,
    );
    expect(statuses.slice(4).some((s) => s.endsWith('captcha_required'))).toBe(true);
    // политика не зависит от cookie и сеанса браузера: тот же адрес без cookie получает то же требование
    const fresh = await attempt('another-guess');
    expect(fresh.json().error?.code).toBe('captcha_required');
    // и они действительно записаны как ошибки входа (без этого сравнение «до и после» выше было бы пустым)
    expect(await failures()).toBeGreaterThanOrEqual(5);
    // администратор с другого адреса не затронут
    expect((await chief.loginRaw()).statusCode).toBe(200);
  });

  async function reauthToken(): Promise<string> {
    return (
      await chief.req('POST', '/admin/reauth', {
        authKey: toBase64Url((await chief.derive()).keys.authKey),
      })
    ).json().token as string;
  }
});
