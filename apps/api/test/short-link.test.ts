import { afterAll, beforeAll, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let owner: TestClient;
let stranger: TestClient;

beforeAll(async () => {
  fixture = await createTestApp();
  owner = new TestClient(fixture.app, 'sl-owner@example.com', 'short-link-pass-1234');
  await owner.register();
  await owner.login();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  stranger = new TestClient(fixture.app, 'sl-stranger@example.com', 'short-link-pass-1234');
});
afterAll(async () => fixture.app.close());

it('opens an entry by its short code only for people who can see it; everyone else gets the same 404', async () => {
  const v = await owner.createSharedVault('Ссылки');
  const e = await owner.createEntry(
    {
      kind: 'login',
      title: 'Сервер',
      username: 'u',
      password: 'p',
      url: '',
      notes: '',
      totp: '',
      fields: [],
      tags: [],
    },
    { vaultId: v.id, vaultKey: v.key },
  );
  const code = e.entryId.replace(/-/g, '').slice(0, 12);
  expect((await owner.req('GET', `/entries/by-short/${code}`)).json()).toEqual({
    vaultId: v.id,
    id: e.entryId,
  });
  // у постороннего права нет: ответ такой же, как для несуществующего кода
  await stranger.register();
  await stranger.login();
  const denied = await stranger.req('GET', `/entries/by-short/${code}`);
  expect(denied.statusCode).toBe(404);
  const missing = await owner.req('GET', '/entries/by-short/000000000000');
  expect(missing.statusCode).toBe(404);
  expect((await owner.req('GET', '/entries/by-short/abc')).statusCode).toBe(400);
  // удалённая запись по ссылке не открывается
  await owner.req('DELETE', `/vaults/${v.id}/entries/${e.entryId}?expectedVersion=1`);
  expect((await owner.req('GET', `/entries/by-short/${code}`)).statusCode).toBe(404);
});
