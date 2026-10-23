import { afterAll, beforeAll, expect, it } from 'vitest';
import { toBase64Url } from '@arklock/crypto';
import { normalizePublicUrl } from '../src/public-url.js';
import { settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let member: TestClient;
beforeAll(async () => {
  fixture = await createTestApp({
    APP_PUBLIC_URL: 'https://install.example.com',
    APP_BIND: '127.0.0.1',
    APP_HOST_PORT: '8443',
  });
  admin = new TestClient(fixture.app, 'admin@example.com', 'admin-password-123');
  await admin.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  member = new TestClient(fixture.app, 'm@example.com', 'member-password-123');
  await member.register();
  await admin.login();
  await member.login();
});
afterAll(async () => fixture.app.close());

/** Изменение адреса — с подтверждением мастер-паролем (как откат и удаление копий). */
async function put(publicUrl: string | null) {
  const authKey = toBase64Url((await admin.derive()).keys.authKey);
  const token = (await admin.req('POST', '/admin/reauth', { authKey })).json().token as string;
  return fixture.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/network',
    headers: { ...admin.authHeader(), 'x-reauth-token': token },
    payload: { publicUrl },
  });
}

it('accepts only an origin over HTTPS (HTTP only for localhost)', () => {
  expect(normalizePublicUrl('https://Ark.Example.com/')).toBe('https://ark.example.com');
  expect(normalizePublicUrl('http://localhost:8080')).toBe('http://localhost:8080');
  for (const bad of [
    'http://ark.example.com',
    'https://user:pw@ark.example.com',
    'https://ark.example.com/path',
    'https://ark.example.com/?x=1',
    'javascript:alert(1)',
    'not a url',
  ])
    expect(() => normalizePublicUrl(bad), bad).toThrow();
});

it('shows where each value comes from; only a full administrator changes the address', async () => {
  expect((await member.req('GET', '/admin/network')).statusCode).toBe(403);
  const v = (await admin.req('GET', '/admin/network')).json();
  expect(v.publicUrl).toMatchObject({
    value: 'https://install.example.com',
    source: 'install',
    https: true,
  });
  expect(v.listen).toMatchObject({ bind: '127.0.0.1', port: 8443 });
  // без подтверждения мастер-паролем адрес не меняется
  expect(
    (await admin.req('PUT', '/admin/network', { publicUrl: 'https://evil.example.com' })).json()
      .error.code,
  ).toBe('reauth_required');
  const bad = await put('http://ark.example.com');
  expect(bad.statusCode).toBe(400);
  // причина приходит кодом, чтобы интерфейс объяснил её пользователю
  expect(bad.json()).toMatchObject({
    error: { code: 'invalid_url', details: { reason: 'https' } },
  });
});

it('a new address applies at once (invitation links, passkeys) and clearing it returns to the install value', async () => {
  const set = await put('https://ark.example.com/');
  expect(set.statusCode).toBe(200);
  expect(set.json().publicUrl).toMatchObject({ value: 'https://ark.example.com', source: 'panel' });
  const inv = (
    await admin.req('POST', '/admin/invitations', {
      email: 'new.person@example.com',
      circleIds: [],
    })
  ).json();
  expect(inv.link ?? inv.url ?? JSON.stringify(inv)).toContain('https://ark.example.com');
  const cleared = (await put(null)).json();
  expect(cleared.publicUrl).toMatchObject({
    value: 'https://install.example.com',
    source: 'install',
  });
  const log = (await admin.req('GET', '/admin/ledger?action=admin.setting')).json();
  expect(JSON.stringify(log)).toContain('system.publicUrl');
});
