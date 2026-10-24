import { afterAll, beforeAll, expect, it } from 'vitest';
import { circleMembers, circles, settings, vaultCircles } from '../src/db/schema.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let jo: TestClient;

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'map-admin@example.com', 'map-admin-password-1');
  await admin.register();
  await fixture.database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  jo = new TestClient(fixture.app, 'map-jo@example.com', 'map-jo-password-123');
  await jo.register();
  await admin.login();
  await jo.login();
});
afterAll(async () => fixture.app.close());

it('the employee card shows where access comes from and how much of the vault the person sees', async () => {
  const db = fixture.database.db;
  const vault = await admin.createSharedVault('Mapped');
  const a = (await admin.createEntry({ password: 'a' }, { vaultId: vault.id, vaultKey: vault.key }))
    .entryId;
  await admin.createEntry({ password: 'b' }, { vaultId: vault.id, vaultKey: vault.key });
  expect((await admin.addMember(vault.id, jo, 'reader', vault.key)).statusCode).toBe(204);
  const team = crypto.randomUUID();
  await db.insert(circles).values({ id: team, name: 'Map team' });
  await db.insert(circleMembers).values({ circleId: team, userId: jo.userId });
  await db.insert(vaultCircles).values({ vaultId: vault.id, circleId: team, role: 'editor' });
  expect(
    (
      await admin.req('PUT', `/vaults/${vault.id}/grants`, {
        targetType: 'entry',
        targetId: a,
        subjectType: 'user',
        subjectId: jo.userId,
        role: 'none',
      })
    ).statusCode,
  ).toBe(200);

  const card = (await admin.req('GET', `/admin/users/${jo.userId}/profile`)).json();
  expect(card.access).toEqual([
    {
      id: vault.id,
      name: 'Mapped',
      direct: 'reader',
      groups: [{ name: 'Map team', role: 'editor' }],
      rules: { allow: 0, deny: 1 },
      sees: 1,
      total: 2,
    },
  ]);
});
