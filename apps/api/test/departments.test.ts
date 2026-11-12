import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TestClient } from './helpers.js';

let fixture: Awaited<ReturnType<typeof createTestApp>>;
let admin: TestClient;
let bob: TestClient;
let spaceId = '';
let circleId = '';
let vaultId = '';

beforeAll(async () => {
  fixture = await createTestApp();
  admin = new TestClient(fixture.app, 'dept-admin@example.com', 'dept-admin-password-1234');
  expect((await admin.register()).statusCode).toBe(201);
  await admin.login();
  await admin.req('PUT', '/admin/settings', { 'registration.mode': 'open' });
  bob = new TestClient(fixture.app, 'dept-bob@example.com', 'dept-bob-password-123456');
  expect((await bob.register()).statusCode).toBe(201);
  await bob.login();
});
afterAll(async () => fixture.app.close());

describe('department card, rename and delete', () => {
  it('the card shows head, members and vaults of a department', async () => {
    circleId = (
      await admin.req('POST', '/admin/circles', { name: 'Sales', description: '' })
    ).json().id;
    spaceId = (await admin.req('POST', '/spaces', { name: 'Sales', publicToOrg: false })).json().id;
    await admin.req('PUT', `/spaces/${spaceId}/circles/${circleId}`, { role: 'member' });
    await admin.req('PATCH', `/admin/circles/${circleId}/members`, { add: [bob.userId] });
    const created = await admin.createSharedVault('Sales', { spaceId });
    expect(created.res.statusCode).toBe(201);
    vaultId = created.id;
    await admin.req('PUT', `/vaults/${vaultId}/circles/${circleId}`, { role: 'editor' });
    const lead = await admin.createSharedVault('Sales · Leadership', { spaceId });
    expect(lead.res.statusCode).toBe(201);
    const other = await admin.createSharedVault('Salesforce tools', { spaceId });
    expect(other.res.statusCode).toBe(201);
    const card = (await admin.req('GET', `/admin/departments/${spaceId}`)).json();
    expect(card).toMatchObject({
      name: 'Sales',
      circleId,
      members: 1,
      waiting: 0,
      directoryLinks: 0,
      archived: false,
    });
    expect(card.heads.map((h: { email: string }) => h.email)).toEqual(['dept-admin@example.com']);
    expect(card.vaults.find((v: { id: string }) => v.id === vaultId)).toMatchObject({
      role: 'editor',
    });
    // обычная группа и общее пространство подразделением не считаются
    expect((await admin.req('GET', `/admin/departments/${DEFAULT_SPACE}`)).statusCode).toBe(404);
    expect((await bob.req('GET', `/admin/departments/${spaceId}`)).statusCode).toBe(403);
  });

  it('renames the space, the group and the department vaults together, not foreign vaults', async () => {
    const r = await admin.req('PATCH', `/admin/departments/${spaceId}`, {
      name: 'Retail',
      description: 'Розница',
    });
    expect(r.statusCode).toBe(200);
    const card = (await admin.req('GET', `/admin/departments/${spaceId}`)).json();
    expect(card).toMatchObject({ name: 'Retail', description: 'Розница' });
    expect(card.vaults.map((v: { name: string }) => v.name).sort()).toEqual([
      'Retail',
      'Retail · Leadership',
      'Salesforce tools',
    ]);
    const group = (await admin.req('GET', '/admin/circles?q=Retail')).json();
    expect(group[0]).toMatchObject({ id: circleId, name: 'Retail', description: 'Розница' });
  });

  it('refuses a name taken by another group', async () => {
    await admin.req('POST', '/admin/circles', { name: 'Support', description: '' });
    const r = await admin.req('PATCH', `/admin/departments/${spaceId}`, { name: 'Support' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('name_taken');
    expect((await admin.req('GET', `/admin/departments/${spaceId}`)).json().name).toBe('Retail');
  });

  it('lists members page by page with search, flags and the number of directory links', async () => {
    const page = (
      await admin.req('GET', `/admin/circles/${circleId}/members?limit=1&offset=0&q=bob`)
    ).json();
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ email: 'dept-bob@example.com', pending: false });
    // без параметров — прежний полный список
    expect((await admin.req('GET', `/admin/circles/${circleId}/members`)).json()).toHaveLength(1);
    const list = (await admin.req('GET', '/admin/circles?q=Retail')).json();
    expect(list[0].directoryLinks).toBe(0);
  });

  it('the user card tells which spaces the person heads', async () => {
    const p = (await admin.req('GET', `/admin/users/${admin.userId}/profile`)).json();
    expect(p.spaces.find((s: { id: string }) => s.id === spaceId)).toMatchObject({ head: true });
    const b = (await admin.req('GET', `/admin/users/${bob.userId}/profile`)).json();
    expect(b.spaces.find((s: { id: string }) => s.id === spaceId)).toMatchObject({ head: false });
  });

  it('deleting is refused while vaults remain and removes an empty department with its group', async () => {
    const busy = await admin.req('DELETE', `/admin/departments/${spaceId}`);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('space_not_empty');
    const tmpCircle = (
      await admin.req('POST', '/admin/circles', { name: 'Temp', description: '' })
    ).json().id;
    const tmpSpace = (
      await admin.req('POST', '/spaces', { name: 'Temp', publicToOrg: false })
    ).json().id;
    await admin.req('PUT', `/spaces/${tmpSpace}/circles/${tmpCircle}`, { role: 'member' });
    const done = await admin.req('DELETE', `/admin/departments/${tmpSpace}`);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ circleDeleted: true });
    expect((await admin.req('GET', `/admin/circles?q=Temp`)).json()).toEqual([]);
  });
});

const DEFAULT_SPACE = '00000000-0000-4000-8000-000000000001';
