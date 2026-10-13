import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { settings } from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let admin: TestClient;
let bob: TestClient;

beforeAll(async () => {
  ({ app, database } = await createTestApp());
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(app, 'bob@example.com', 'bob-password-12345');
  expect((await bob.register()).statusCode).toBe(201);
  await bob.login();
  await admin.login();
});

afterAll(async () => {
  await app.close();
});

/** Политика личных сейфов задаётся администратором; сервер проверяет её при каждой записи. */
const setPersonal = async (value: boolean) => {
  await database.db
    .insert(settings)
    .values({ key: 'vaults.personalLockers', value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
};

describe('корпоративный режим: личные сейфы', () => {
  it('while personal vaults are allowed, the locker accepts entries', async () => {
    await setPersonal(true);
    const made = await bob.createEntry({ title: 'before the switch' });
    expect(made.res.statusCode).toBe(201);
  });

  it('when turned off, writes into a personal vault are refused by the server', async () => {
    await setPersonal(false);
    const created = await bob.createEntry({ title: 'refused' });
    expect(created.res.statusCode).toBe(403);
    const { locker } = await bob.lockerKey();
    expect(locker.kind).toBe('locker');
  });

  it('existing personal data stays readable and is not deleted', async () => {
    await setPersonal(true);
    const made = await bob.createEntry({ title: 'kept' });
    expect(made.res.statusCode).toBe(201);
    await setPersonal(false);
    const read = await bob.req('GET', `/vaults/${made.vaultId}/entries/${made.entryId}`);
    expect(read.statusCode).toBe(200);
  });

  it('the policy is published to signed-in users and the administrator sees it', async () => {
    await setPersonal(false);
    const policy = (await bob.req('GET', '/auth/policy')).json() as Record<string, unknown>;
    expect(policy['vaults.personalLockers']).toBe(false);
    await setPersonal(true);
    const again = (await bob.req('GET', '/auth/policy')).json() as Record<string, unknown>;
    expect(again['vaults.personalLockers']).toBe(true);
  });

  it('a shared vault is unaffected by the switch', async () => {
    await setPersonal(false);
    const created = await admin.createSharedVault('Team');
    expect(created.res.statusCode).toBe(201);
    const made = await admin.createEntry(
      { title: 'shared' },
      { vaultId: created.id, vaultKey: created.key },
    );
    expect(made.res.statusCode).toBe(201);
    await setPersonal(true);
  });
});
