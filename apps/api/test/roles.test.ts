import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { encryptEntry } from '@arklock/crypto';
import type { EntryRecord } from '@arklock/contracts';
import { adminPermFor } from '../src/perms.js';
import { settings, vaultMembers } from '../src/db/schema.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let owner: TestClient;
let bob: TestClient;
let carol: TestClient;
let vaultId: string;
let vk: Uint8Array;
const roleIds: Record<string, string> = {};

const mkRole = async (name: string, over: object = {}) => {
  const r = await owner.req('POST', '/admin/roles', {
    name,
    scope: 'vault',
    allow: [],
    deny: [],
    parents: [],
    ...over,
  });
  expect(r.statusCode, name + ' ' + r.body).toBe(201);
  roleIds[name] = r.json().id;
  return r.json().id as string;
};
const assign = async (c: TestClient, roleId: string, extra: object = {}) =>
  owner.req('PUT', `/vaults/${vaultId}/members/${c.userId}`, {
    customRoleId: roleId,
    key: await owner.keyFor(c, vaultId, vk),
    ...extra,
  });

beforeAll(async () => {
  ({ app, database } = await createTestApp());
  owner = new TestClient(app, 'owner@example.com', 'owner-password-12345');
  expect((await owner.register()).statusCode).toBe(201);
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(app, 'bob@example.com', 'bob-password-12345');
  carol = new TestClient(app, 'carol@example.com', 'carol-password-1234');
  for (const c of [bob, carol]) expect((await c.register()).statusCode).toBe(201);
  for (const c of [owner, bob, carol]) await c.login();
  const v = await owner.createSharedVault('Roles');
  vaultId = v.id;
  vk = v.key;
});

afterAll(async () => {
  await app.close();
});

describe('role definitions', () => {
  it('only administrators manage roles; unknown permissions, scopes and cycles are rejected', async () => {
    expect((await bob.req('GET', '/admin/roles')).statusCode).toBe(403);
    expect((await bob.req('POST', '/admin/roles', { name: 'x', scope: 'vault' })).statusCode).toBe(
      403,
    );
    const bad = await owner.req('POST', '/admin/roles', {
      name: 'Bad',
      scope: 'vault',
      allow: ['entry.fly'],
    });
    expect(bad.statusCode).toBe(400);
    // административное полномочие в роли хранилища недопустимо
    expect(
      (
        await owner.req('POST', '/admin/roles', {
          name: 'Bad2',
          scope: 'vault',
          allow: ['admin.users'],
        })
      ).statusCode,
    ).toBe(400);

    await mkRole('Auditor', { allow: ['entry.read', 'entry.history'] });
    await mkRole('Contributor', {
      allow: ['entry.read', 'entry.create', 'entry.update', 'attachment.read'],
      deny: ['entry.delete'],
    });
    // наследование: «Старший» наследует «Участника» и пытается разрешить удаление — запрет предка сильнее
    await mkRole('Senior', {
      allow: ['entry.delete', 'entry.history'],
      parents: [roleIds['Contributor']],
    });
    const eff = (await owner.req('GET', `/admin/roles/${roleIds['Senior']}/effective`)).json()
      .permissions as string[];
    expect(eff).toContain('entry.update');
    expect(eff).toContain('entry.history');
    expect(eff).not.toContain('entry.delete');

    expect(
      (await owner.req('POST', '/admin/roles', { name: 'Auditor', scope: 'vault' })).statusCode,
    ).toBe(409);
    // цикл
    const cyc = await owner.req('PUT', `/admin/roles/${roleIds['Contributor']}`, {
      name: 'Contributor',
      scope: 'vault',
      allow: ['entry.read'],
      deny: [],
      parents: [roleIds['Senior']],
    });
    expect(cyc.statusCode).toBe(400);
    // родитель из другой области
    const a = await owner.req('POST', '/admin/roles', {
      name: 'AdmScope',
      scope: 'admin',
      allow: ['admin.ledger'],
    });
    expect(a.statusCode).toBe(201);
    roleIds['AdmScope'] = a.json().id;
    expect(
      (
        await owner.req('POST', '/admin/roles', {
          name: 'Cross',
          scope: 'vault',
          parents: [roleIds['AdmScope']],
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('enforcement in a vault', () => {
  let entryId: string;
  beforeAll(async () => {
    entryId = (await owner.createEntry({ title: 'Doc', password: 'pw' }, { vaultId, vaultKey: vk }))
      .entryId;
  });

  it('a read-only custom role reads and sees history but cannot write', async () => {
    expect((await assign(bob, roleIds['Auditor'])).statusCode).toBe(204);
    expect((await bob.req('GET', `/vaults/${vaultId}/entries/${entryId}`)).statusCode).toBe(200);
    expect(
      (await bob.req('GET', `/vaults/${vaultId}/entries/${entryId}/revisions`)).statusCode,
    ).toBe(200);
    const enc = await encryptEntry({ title: 'x' }, vk, vaultId, crypto.randomUUID(), 1);
    expect(
      (
        await bob.req('POST', `/vaults/${vaultId}/entries`, {
          id: crypto.randomUUID(),
          branchId: null,
          ...enc,
        })
      ).statusCode,
    ).toBe(403);
    const info = (await bob.vaults()).find((v) => v.id === vaultId)!;
    expect(info.permissions).toEqual(['entry.history', 'entry.read']);
    // не может управлять участниками или удалять хранилище
    expect((await bob.req('GET', `/vaults/${vaultId}/members`)).statusCode).toBe(403);
    expect((await bob.req('DELETE', `/vaults/${vaultId}`)).statusCode).toBe(403);
  });

  it('a role without a permission is refused exactly that action; an explicit deny wins', async () => {
    expect((await assign(bob, roleIds['Contributor'])).statusCode).toBe(204);
    const created = await bob.createEntry({ title: 'Mine' }, { vaultId, vaultKey: vk });
    expect(created.res.statusCode).toBe(201);
    const rec = (
      await bob.req('GET', `/vaults/${vaultId}/entries/${created.entryId}`)
    ).json() as EntryRecord;
    // нет полномочия истории
    expect(
      (await bob.req('GET', `/vaults/${vaultId}/entries/${created.entryId}/revisions`)).statusCode,
    ).toBe(403);
    // удаление запрещено явно
    const del = await bob.req(
      'DELETE',
      `/vaults/${vaultId}/entries/${created.entryId}?expectedVersion=${rec.version}`,
    );
    expect(del.statusCode).toBe(403);
    // запрет не обходится грантом «менеджер» на запись
    expect(
      (
        await owner.req('PUT', `/vaults/${vaultId}/grants`, {
          targetType: 'entry',
          targetId: created.entryId,
          subjectType: 'user',
          subjectId: bob.userId,
          role: 'manager',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await bob.req(
          'DELETE',
          `/vaults/${vaultId}/entries/${created.entryId}?expectedVersion=${rec.version}`,
        )
      ).statusCode,
    ).toBe(403);
    // роль «Старший» не может удалять из-за запрета предка
    expect((await assign(bob, roleIds['Senior'])).statusCode).toBe(204);
    expect(
      (
        await bob.req(
          'DELETE',
          `/vaults/${vaultId}/entries/${created.entryId}?expectedVersion=${rec.version}`,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await bob.req('GET', `/vaults/${vaultId}/entries/${created.entryId}/revisions`)).statusCode,
    ).toBe(200);
  });

  it('temporary access ends on its own; the server stops answering at the deadline', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    expect((await assign(carol, roleIds['Auditor'], { expiresAt: soon })).statusCode).toBe(204);
    expect((await carol.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(200);
    // срок прошёл (час спустя): участие не действует, хранилище неотличимо от несуществующего
    await database.db
      .update(vaultMembers)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(vaultMembers.userId, carol.userId));
    expect((await carol.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(404);
    expect((await carol.vaults()).some((v) => v.id === vaultId)).toBe(false);
    // продление возвращает доступ
    expect((await assign(carol, roleIds['Auditor'], { expiresAt: soon })).statusCode).toBe(204);
    expect((await carol.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(200);
    expect(
      (
        await owner.req('PUT', `/vaults/${vaultId}/members/${carol.userId}`, {
          customRoleId: roleIds['Auditor'],
          expiresAt: 'not a date',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('nobody can hand out more than they hold; manager-level roles need the owner', async () => {
    const adminLike = await mkRole('Delegate', {
      allow: ['entry.read', 'members.manage', 'grant.manage'],
    });
    const wide = await mkRole('Wide', { allow: ['entry.read', 'vault.delete'] });
    // владелец делает bob администратором-делегатом (builtin admin: может управлять участниками, но не удалять хранилище)
    expect((await owner.addMember(vaultId, bob, 'admin', vk)).statusCode).toBe(204);
    // bob не может назначить роль, дающую управление участниками (только владелец), или полномочие, которого у него нет
    expect((await assign2(bob, carol, adminLike)).statusCode).toBe(403);
    expect((await assign2(bob, carol, wide)).statusCode).toBe(403);
    expect((await assign2(bob, carol, roleIds['Auditor'])).statusCode).toBe(204);
    // и не может сменить участника, у которого есть управление участниками
    expect((await assign(carol, adminLike)).statusCode).toBe(204);
    expect((await assign2(bob, carol, roleIds['Auditor'])).statusCode).toBe(403);
    expect((await bob.req('DELETE', `/vaults/${vaultId}/members/${carol.userId}`)).statusCode).toBe(
      403,
    );
  });

  it('vault admins can list vault roles with effective permissions (administrative ones are hidden)', async () => {
    const r = await owner.req('GET', '/vault-roles');
    expect(r.statusCode).toBe(200);
    const list = r.json() as { id: string; name: string; permissions: string[] }[];
    const ro = list.find((x) => x.id === roleIds['Contributor'])!;
    expect(ro.permissions).toContain('entry.create');
    expect(list.some((x) => x.id === roleIds['AdmScope'])).toBe(false);
  });

  it('roles in use cannot be deleted; unused ones can', async () => {
    const r = await owner.req('DELETE', `/admin/roles/${roleIds['Contributor']}`); // наследуется ролью «Старший»
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('role_in_use');
    const free = await mkRole('Free');
    expect((await owner.req('DELETE', `/admin/roles/${free}`)).statusCode).toBe(204);
  });
});

async function assign2(by: TestClient, target: TestClient, roleId: string) {
  return by.req('PUT', `/vaults/${vaultId}/members/${target.userId}`, {
    customRoleId: roleId,
    key: await by.keyFor(target, vaultId, vk),
  });
}

describe('delegated administration', () => {
  let ledgerRole: string;
  let dave: TestClient;
  beforeAll(async () => {
    ledgerRole = roleIds['AdmScope']!;
    dave = new TestClient(app, 'dave@example.com', 'dave-password-12345');
    expect((await dave.register()).statusCode).toBe(201);
    await dave.login();
  });

  it('a delegated role opens exactly the granted sections', async () => {
    expect((await dave.req('GET', '/admin/ledger')).statusCode).toBe(403);
    const users = (await owner.req('GET', '/admin/users')).json() as {
      id: string;
      email: string;
    }[];
    const d = users.find((u) => u.email === 'dave@example.com')!;
    expect(
      (await owner.req('PATCH', `/admin/users/${d.id}`, { adminRoleId: ledgerRole })).statusCode,
    ).toBe(200);
    await dave.login(); // смена роли завершает сеансы
    expect((await dave.req('GET', '/auth/admin-perms')).json()).toEqual({
      full: false,
      permissions: ['admin.ledger'],
    });
    expect((await dave.req('GET', '/admin/ledger')).statusCode).toBe(200);
    // клиент узнаёт о делегировании из профиля и показывает панель
    expect((await dave.req('GET', '/auth/me')).json().user.delegated).toBe(true);
    expect((await owner.req('GET', '/auth/me')).json().user.delegated).toBe(false);
    for (const [m, u] of [
      ['GET', '/admin/users'],
      ['GET', '/admin/settings'],
      ['GET', '/admin/roles'],
      ['GET', '/admin/overview'],
      ['GET', '/admin/backups'],
      ['GET', '/admin/ldap'],
      ['GET', '/admin/invitations'],
    ] as const)
      expect((await dave.req(m, u)).statusCode, u).toBe(403);
    // не может назначать роли, менять полных администраторов и их фактор
    expect((await dave.req('PATCH', `/admin/users/${d.id}`, { role: 'admin' })).statusCode).toBe(
      403,
    );
    expect((await dave.req('POST', `/admin/users/${owner.userId}/mfa-reset`)).statusCode).toBe(403);
  });

  it('a delegated administrator cannot create roles above their own rights', async () => {
    const users = (await owner.req('GET', '/admin/users')).json() as {
      id: string;
      email: string;
    }[];
    const d = users.find((u) => u.email === 'dave@example.com')!;
    const mgr = (
      await owner.req('POST', '/admin/roles', {
        name: 'RoleManager',
        scope: 'admin',
        allow: ['admin.roles', 'admin.ledger'],
      })
    ).json().id;
    await owner.req('PATCH', `/admin/users/${d.id}`, { adminRoleId: mgr });
    await dave.login();
    expect(
      (
        await dave.req('POST', '/admin/roles', {
          name: 'Sneaky',
          scope: 'admin',
          allow: ['admin.users'],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await dave.req('POST', '/admin/roles', {
          name: 'Vault one',
          scope: 'vault',
          allow: ['entry.read'],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await dave.req('POST', '/admin/roles', {
          name: 'Ledger copy',
          scope: 'admin',
          allow: ['admin.ledger'],
        })
      ).statusCode,
    ).toBe(201);
    // снятие роли закрывает доступ немедленно
    await owner.req('PATCH', `/admin/users/${d.id}`, { adminRoleId: null });
    // сеанс завершён, после повторного входа доступа к разделу нет
    expect((await dave.req('GET', '/admin/roles')).statusCode).toBe(401);
    await dave.login();
    expect((await dave.req('GET', '/admin/roles')).statusCode).toBe(403);
  });

  it('an administrative role given to a group applies to its members and ends with membership', async () => {
    const users = (await owner.req('GET', '/admin/users')).json() as {
      id: string;
      email: string;
    }[];
    const d = users.find((u) => u.email === 'dave@example.com')!;
    const groupRole = (
      await owner.req('POST', '/admin/roles', {
        name: 'GroupLedger',
        scope: 'admin',
        allow: ['admin.ledger', 'admin.circles'],
      })
    ).json().id;
    const g = (await owner.req('POST', '/admin/circles', { name: 'Domain admins' })).json().id;
    const plain = (await owner.req('POST', '/admin/circles', { name: 'Plain' })).json().id;
    await dave.login();
    expect((await dave.req('GET', '/admin/ledger')).statusCode).toBe(403);
    expect(
      (await owner.req('PATCH', `/admin/circles/${g}`, { adminRoleId: groupRole })).statusCode,
    ).toBe(200);
    expect((await owner.req('PUT', `/admin/circles/${g}/members/${d.id}`)).statusCode).toBe(204);
    // права берутся из группы без повторного входа и входят в профиль
    expect((await dave.req('GET', '/admin/ledger')).statusCode).toBe(200);
    expect((await dave.req('GET', '/auth/me')).json().user.delegated).toBe(true);
    // делегат не назначает роль группе, не меняет её состав и не приглашает в неё
    expect(
      (await dave.req('PATCH', `/admin/circles/${plain}`, { adminRoleId: groupRole })).statusCode,
    ).toBe(403);
    expect((await dave.req('PUT', `/admin/circles/${g}/members/${d.id}`)).statusCode).toBe(403);
    expect(
      (await dave.req('PATCH', `/admin/circles/${g}/members`, { add: [], remove: [d.id] }))
        .statusCode,
    ).toBe(403);
    expect((await dave.req('DELETE', `/admin/circles/${g}/members/${d.id}`)).statusCode).toBe(403);
    expect(
      (await dave.req('PATCH', `/admin/circles/${plain}`, { name: 'Plain 2' })).statusCode,
    ).toBe(200);
    // роль, назначенная группе, нельзя удалить
    expect((await owner.req('DELETE', `/admin/roles/${groupRole}`)).statusCode).toBe(409);
    // исключение из группы немедленно закрывает доступ
    expect((await owner.req('DELETE', `/admin/circles/${g}/members/${d.id}`)).statusCode).toBe(204);
    expect((await dave.req('GET', '/admin/ledger')).statusCode).toBe(403);
    expect((await dave.req('GET', '/auth/me')).json().user.delegated).toBe(false);
  });

  it('every administrative route is mapped to a permission', () => {
    const routes = app.routeTable.filter((r) => r.url.startsWith('/api/v1/admin'));
    const unmapped = routes.filter(
      (r) =>
        !r.url.endsWith('/admin/reauth') &&
        adminPermFor(r.url.replace(/:[A-Za-z]+/g, 'x')) === null,
    );
    expect(unmapped.map((r) => `${r.method} ${r.url}`)).toEqual([]);
  });
});
