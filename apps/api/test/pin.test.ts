import { afterAll, beforeAll, expect, it } from 'vitest';
import { toBase64Url } from '@arklock/crypto';
import { pinDevices } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
const key = (c: string) => c.repeat(43);
beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'admin@example.com', 'admin-password-123');
  await admin.register();
  await admin.login();
});
afterAll(async () => fixture.app.close());

const master = async () => toBase64Url((await admin.derive()).keys.authKey);

it('PIN unlock is off by default and needs the master password to set up', async () => {
  expect((await admin.req('GET', '/auth/pin')).json().enabled).toBe(false);
  const off = await admin.req('POST', '/auth/pin', {
    name: 'Ноутбук',
    currentAuthKey: await master(),
    authKey: key('a'),
  });
  expect(off.statusCode).toBe(403);
  expect(off.json().error.code).toBe('pin_disabled');
  expect(
    (await admin.req('PUT', '/admin/settings', { 'security.pinUnlock': true })).statusCode,
  ).toBe(200);
  const wrong = await admin.req('POST', '/auth/pin', {
    name: 'Ноутбук',
    currentAuthKey: key('z'),
    authKey: key('a'),
  });
  expect(wrong.statusCode).toBe(401);
});

let deviceId = '';
let share = '';
it('releases the key share only after the right PIN, and five wrong attempts delete the device', async () => {
  const ok = await admin.req('POST', '/auth/pin', {
    name: 'Ноутбук',
    currentAuthKey: await master(),
    authKey: key('a'),
  });
  expect(ok.statusCode).toBe(201);
  ({ deviceId, share } = ok.json());
  expect(share).toHaveLength(43);
  const listed = (await admin.req('GET', '/auth/pin')).json();
  expect(JSON.stringify(listed)).not.toContain(share);
  expect(listed.devices).toHaveLength(1);
  // два неверных PIN, затем верный: счётчик сбрасывается
  for (let i = 0; i < 2; i++) {
    const bad = await admin.req('POST', `/auth/pin/${deviceId}/unlock`, { authKey: key('b') });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.details.remaining).toBe(4 - i);
  }
  const good = await admin.req('POST', `/auth/pin/${deviceId}/unlock`, { authKey: key('a') });
  expect(good.json().share).toBe(share);
  for (let i = 0; i < 4; i++)
    expect(
      (await admin.req('POST', `/auth/pin/${deviceId}/unlock`, { authKey: key('b') })).statusCode,
    ).toBe(401);
  const locked = await admin.req('POST', `/auth/pin/${deviceId}/unlock`, { authKey: key('b') });
  expect(locked.statusCode).toBe(423);
  expect(locked.json().error.code).toBe('pin_locked');
  // устройство удалено: даже верный PIN больше не выдаёт долю
  const after = await admin.req('POST', `/auth/pin/${deviceId}/unlock`, { authKey: key('a') });
  expect(after.statusCode).toBe(404);
  expect((await fixture.database.db.select().from(pinDevices)).length).toBe(0);
});

it('the administrator policy is enforced by the server and a device can be removed', async () => {
  const made = await admin.req('POST', '/auth/pin', {
    name: 'Телефон',
    currentAuthKey: await master(),
    authKey: key('c'),
  });
  const id = made.json().deviceId as string;
  await admin.req('PUT', '/admin/settings', { 'security.pinUnlock': false });
  const refused = await admin.req('POST', `/auth/pin/${id}/unlock`, { authKey: key('c') });
  expect(refused.statusCode).toBe(403);
  await admin.req('PUT', '/admin/settings', { 'security.pinUnlock': true });
  expect(
    (await admin.req('POST', `/auth/pin/${id}/unlock`, { authKey: key('c') })).statusCode,
  ).toBe(200);
  expect((await admin.req('DELETE', `/auth/pin/${id}`)).statusCode).toBe(204);
  expect((await admin.req('DELETE', `/auth/pin/${id}`)).statusCode).toBe(404);
});

it('parallel guesses cannot check more than five PINs', async () => {
  const made = await admin.req('POST', '/auth/pin', {
    name: 'Планшет',
    currentAuthKey: await master(),
    authKey: key('d'),
  });
  const id = made.json().deviceId as string;
  const codes = await Promise.all(
    Array.from({ length: 30 }, () =>
      admin.req('POST', `/auth/pin/${id}/unlock`, { authKey: key('e') }).then((r) => r.statusCode),
    ),
  );
  expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(4);
  // устройство удалено: верный PIN больше не принимается
  expect(
    (await admin.req('POST', `/auth/pin/${id}/unlock`, { authKey: key('d') })).statusCode,
  ).toBe(404);
});
