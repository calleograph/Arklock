import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, TestClient } from './helpers.js';
import { fakeSmtp } from './smtp-fake.js';

// Лимиты по умолчанию: 5 тестовых писем и 10 проверок за 10 минут на администратора.
let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let relay: Awaited<ReturnType<typeof fakeSmtp>>;
let id = '';

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'throttle-admin@example.com', 'throttle-admin-password-1');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
  relay = await fakeSmtp();
  const r = await admin.reqStep('POST', '/admin/smtp/profiles', {
    name: 'Relay',
    host: '127.0.0.1',
    port: relay.port,
    security: 'none',
    from: 'arklock@example.com',
    confirmInsecure: true,
  });
  id = r.json().id;
});
afterAll(async () => {
  await relay.close();
  await fixture.app.close();
});

it('test mail is limited per administrator and nothing extra reaches the mail server', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 7; i++)
    codes.push(
      (await admin.req('POST', `/admin/smtp/profiles/${id}/send-test`, { to: `t${i}@example.com` }))
        .statusCode,
    );
  expect(codes.filter((c) => c === 200)).toHaveLength(5);
  expect(codes.filter((c) => c === 429)).toHaveLength(2);
  expect(relay.received).toHaveLength(5);
});

it('connection checks are limited too, and a refused request says what to do', async () => {
  const codes: number[] = [];
  let last = { error: { code: '' } };
  for (let i = 0; i < 12; i++) {
    const r = await admin.req('POST', `/admin/smtp/profiles/${id}/check`);
    codes.push(r.statusCode);
    if (r.statusCode === 429) last = r.json();
  }
  expect(codes.filter((c) => c === 200)).toHaveLength(10);
  expect(codes.filter((c) => c === 429)).toHaveLength(2);
  expect(last.error.code).toBe('smtp_rate_limited');
});
