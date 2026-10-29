import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

// Публичная точка /access: как приложение видит соединение. На ней строятся проверки установщика и подсказка на странице входа.
const opened: { close: () => Promise<unknown> }[] = [];
const make = async (env: Record<string, string> = {}) => {
  const f = await createTestApp(env);
  opened.push(f.app);
  const get = async (headers: Record<string, string> = {}) =>
    (await f.app.inject({ method: 'GET', url: '/api/v1/access', headers })).json();
  return { ...f, get };
};
afterAll(async () => {
  await Promise.all(opened.map((a) => a.close()));
});

describe('GET /access', () => {
  it('http on an ordinary address is not a secure context; the first registration is reported as open', async () => {
    const { get } = await make({ APP_PUBLIC_URL: 'https://arklock.example.com' });
    const r = await get({ host: 'arklock.example.com' });
    expect(r).toMatchObject({
      protocol: 'http',
      secure: false,
      host: 'arklock.example.com',
      publicUrl: 'https://arklock.example.com',
      publicMatches: false,
      firstUser: true,
    });
  });

  it('localhost is a secure context for the browser even over http', async () => {
    const { get } = await make();
    for (const host of ['localhost:8080', '127.0.0.1:8080'])
      expect((await get({ host })).secure, host).toBe(true);
    expect((await get({ host: '192.0.2.10:8080' })).secure).toBe(false);
  });

  it('behind a trusted proxy that sends X-Forwarded-Proto the connection counts as https and matches the public address', async () => {
    const { get } = await make({
      APP_PUBLIC_URL: 'https://arklock.example.com',
      TRUSTED_PROXY_HOPS: '1',
    });
    const r = await get({
      host: 'arklock.example.com',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '198.51.100.7',
    });
    expect(r).toMatchObject({
      protocol: 'https',
      secure: true,
      publicMatches: true,
      trustedProxyHops: 1,
      forwardedProto: 'https',
    });
    // прокси подключил другой узел или забыл заголовок: расхождение видно
    expect(
      (await get({ host: 'other.example.com', 'x-forwarded-proto': 'https' })).publicMatches,
    ).toBe(false);
    const noHeader = await get({ host: 'arklock.example.com' });
    expect(noHeader).toMatchObject({
      protocol: 'http',
      secure: false,
      forwardedProto: null,
      publicMatches: false,
    });
  });

  it('when proxies are not trusted the header is ignored, but its presence is reported so the cause is visible', async () => {
    const { get } = await make({
      APP_PUBLIC_URL: 'https://arklock.example.com',
      TRUSTED_PROXY_HOPS: '0',
    });
    const r = await get({ host: 'arklock.example.com', 'x-forwarded-proto': 'https' });
    expect(r).toMatchObject({
      protocol: 'http',
      secure: false,
      trustedProxyHops: 0,
      forwardedProto: 'https',
    });
  });

  it('never returns the caller address, a secret or the setup code', async () => {
    const { get } = await make({ BOOTSTRAP_TOKEN: 'synthetic-setup-code-for-access-test-1' });
    const text = JSON.stringify(await get({ 'x-forwarded-for': '198.51.100.7' }));
    expect(text).not.toContain('198.51.100.7');
    expect(text).not.toContain('synthetic-setup-code');
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      [
        'firstUser',
        'forwardedProto',
        'host',
        'protocol',
        'publicMatches',
        'publicUrl',
        'secure',
        'trustedProxyHops',
      ].sort(),
    );
  });
});
