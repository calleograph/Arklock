import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { roles } from '../src/db/schema.js';
import { PRESET_ROLES, seedPresetRoles } from '../src/preset-roles.js';
import { ADMIN_PERMS, VAULT_PERMS } from '../src/perms.js';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'preset-admin@example.com', 'preset-admin-password-1234');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
});
afterAll(async () => fixture.app.close());

it('creates the ready roles once, only with known permissions, and does not bring back a deleted one', async () => {
  const known = new Set<string>([...VAULT_PERMS, ...ADMIN_PERMS]);
  for (const p of PRESET_ROLES)
    for (const a of p.allow) expect(known.has(a), `${p.name}: ${a}`).toBe(true);
  expect(await seedPresetRoles(fixture.database.db)).toBe(PRESET_ROLES.length);
  expect(await seedPresetRoles(fixture.database.db)).toBe(0);
  const list = (await admin.req('GET', '/admin/roles')).json().roles as {
    id: string;
    name: string;
    scope: string;
    uses: number;
  }[];
  for (const p of PRESET_ROLES)
    expect(list.find((r) => r.name === p.name)).toMatchObject({ scope: p.scope, uses: 0 });
  // роль можно удалить: заново при следующем запуске она не появляется
  const curator = list.find((r) => r.name === 'Куратор сейфа')!;
  expect((await admin.req('DELETE', `/admin/roles/${curator.id}`)).statusCode).toBe(204);
  expect(await seedPresetRoles(fixture.database.db)).toBe(0);
  expect(
    await fixture.database.db.select().from(roles).where(eq(roles.name, 'Куратор сейфа')),
  ).toHaveLength(0);
});

it('counts where a role is used', async () => {
  const role = list(await admin.req('GET', '/admin/roles')).find(
    (r) => r.name === 'Просмотр журнала',
  )!;
  const circle = (
    await admin.req('POST', '/admin/circles', { name: 'Контроль', description: '' })
  ).json();
  expect(
    (await admin.req('PATCH', `/admin/circles/${circle.id}`, { adminRoleId: role.id })).statusCode,
  ).toBe(200);
  expect(list(await admin.req('GET', '/admin/roles')).find((r) => r.id === role.id)!.uses).toBe(1);
});

const list = (res: { json: () => unknown }) =>
  (res.json() as { roles: { id: string; name: string; uses: number }[] }).roles;
