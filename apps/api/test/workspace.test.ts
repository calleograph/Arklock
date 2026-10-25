import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CryptoAuthError,
  createVaultKey,
  decryptBranchName,
  decryptEntry,
  encryptBranchName,
  encryptEntry,
  generateSigningKeyPair,
  rewrapBranchName,
  rewrapEntry,
  sealVaultKeyFor,
  signKeyGrant,
  verifyKeyLog,
} from '@arklock/crypto';
import type { BranchRecord, EntryRecord, RevisionRecord } from '@arklock/contracts';
import { entries, grants, settings } from '../src/db/schema.js';
import { runMaintenance } from '../src/maintenance.js';
import { TestClient, createTestApp } from './helpers.js';

let app: FastifyInstance;
let database: Awaited<ReturnType<typeof createTestApp>>['database'];
let admin: TestClient;
let bob: TestClient;
let carol: TestClient;
let dave: TestClient;
let vaultId: string;
let vk: Uint8Array;

const tree = async (c: TestClient, id = vaultId, trash = false) =>
  (await c.req('GET', `/vaults/${id}/tree${trash ? '?trash=1' : ''}`)).json() as {
    branches: BranchRecord[];
    entries: EntryRecord[];
  };

beforeAll(async () => {
  ({ app, database } = await createTestApp());
  admin = new TestClient(app, 'admin@example.com', 'admin-password-123');
  expect((await admin.register()).statusCode).toBe(201);
  await database.db.insert(settings).values({ key: 'registration.mode', value: 'open' });
  bob = new TestClient(app, 'bob@example.com', 'bob-password-12345');
  carol = new TestClient(app, 'carol@example.com', 'carol-password-1234');
  dave = new TestClient(app, 'dave@example.com', 'dave-password-12345');
  for (const c of [bob, carol, dave]) expect((await c.register()).statusCode).toBe(201);
  for (const c of [admin, bob, carol, dave]) await c.login();
});

afterAll(async () => {
  await app.close();
});

describe('shared vaults and keys', () => {
  it('only administrators create vaults by default; members may after the policy changes', async () => {
    expect((await bob.createSharedVault('Bob vault')).res.statusCode).toBe(403);
    const created = await admin.createSharedVault('Team');
    expect(created.res.statusCode).toBe(201);
    vaultId = created.id;
    vk = created.key;
    const mine = (await admin.vaults()).find((v) => v.id === vaultId)!;
    expect(mine.role).toBe('owner');
    expect(mine.pendingKey).toBe(false);
    expect((await bob.vaults()).some((v) => v.id === vaultId)).toBe(false);
    expect((await bob.req('GET', `/vaults/${vaultId}/tree`)).statusCode).toBe(404);
  });

  it('a key grant signed by someone else is rejected', async () => {
    const mallory = await generateSigningKeyPair();
    const sealed = await sealVaultKeyFor(vk, bob.publicKey, vaultId, bob.userId, 1);
    const forged = await signKeyGrant(mallory.privateKey, vaultId, bob.userId, 1, sealed);
    const res = await admin.req('PUT', `/vaults/${vaultId}/members/${bob.userId}`, {
      role: 'editor',
      key: { keyVersion: 1, sealedKey: sealed, signature: forged },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_signature');
  });

  it('adds members with keys; roles are enforced', async () => {
    expect((await admin.addMember(vaultId, bob, 'editor', vk)).statusCode).toBe(204);
    const bobVault = (await bob.vaults()).find((v) => v.id === vaultId)!;
    expect(bobVault.role).toBe('editor');
    const bobKey = await bob.openVault(bobVault);
    expect(Buffer.from(bobKey).equals(Buffer.from(vk))).toBe(true);

    const made = await bob.createEntry({ title: 'Wiki' }, { vaultId, vaultKey: bobKey });
    expect(made.res.statusCode).toBe(201);
    expect(await admin.readEntry(vaultId, made.entryId, vk)).toEqual({ title: 'Wiki' });

    // редактор не управляет участниками
    expect((await bob.addMember(vaultId, carol, 'reader', bobKey)).statusCode).toBe(403);
    expect((await bob.req('GET', `/vaults/${vaultId}/members`)).statusCode).toBe(403);
    expect((await bob.req('DELETE', `/vaults/${vaultId}`)).statusCode).toBe(403);
  });

  it('a member without a key is pending until an administrator distributes it', async () => {
    expect((await admin.addMember(vaultId, carol, 'reader')).statusCode).toBe(204);
    const v = (await carol.vaults()).find((x) => x.id === vaultId)!;
    expect(v.pendingKey).toBe(true);
    expect(v.key).toBeNull();
    const pending = (await admin.req('GET', `/vaults/${vaultId}/pending-keys`)).json();
    expect(pending.users.map((u: { userId: string }) => u.userId)).toContain(carol.userId);

    const key = await admin.keyFor(carol, vaultId, vk);
    const res = await admin.req('POST', `/vaults/${vaultId}/keys`, {
      keys: [{ userId: carol.userId, ...key }],
    });
    expect(res.statusCode).toBe(204);
    const v2 = (await carol.vaults()).find((x) => x.id === vaultId)!;
    expect(v2.pendingKey).toBe(false);
    const carolKey = await carol.openVault(v2);
    // читатель читает, но не пишет
    const entryId = (await tree(carol)).entries[0]!.id;
    expect(await carol.readEntry(vaultId, entryId, carolKey)).toEqual({ title: 'Wiki' });
    expect(
      (await carol.createEntry({ t: 1 }, { vaultId, vaultKey: carolKey })).res.statusCode,
    ).toBe(403);
  });

  it('only the owner manages administrators; nobody removes the owner', async () => {
    expect((await admin.addMember(vaultId, dave, 'admin', vk)).statusCode).toBe(204);
    const daveVault = (await dave.vaults()).find((v) => v.id === vaultId)!;
    expect(daveVault.role).toBe('admin');
    // администратор (не владелец) не может назначить другого администратора и удалить владельца
    expect((await dave.addMember(vaultId, bob, 'admin')).statusCode).toBe(403);
    expect(
      (await dave.req('DELETE', `/vaults/${vaultId}/members/${admin.userId}`)).statusCode,
    ).toBe(403);
    expect(
      (await admin.req('DELETE', `/vaults/${vaultId}/members/${dave.userId}`)).statusCode,
    ).toBe(200);
    expect((await dave.vaults()).some((v) => v.id === vaultId)).toBe(false);
  });

  it('ownership moves to a member who already holds the key; there is always exactly one owner', async () => {
    // отдельное хранилище: остальные проверки файла его не видят
    const t = await admin.createSharedVault('Transfer');
    const tid = t.id;
    const url = `/vaults/${tid}/transfer-ownership`;
    // посторонний и сам владелец (на себя) не могут
    expect((await carol.req('POST', url, { userId: carol.userId })).statusCode).toBe(404); // не участник: хранилища для него нет
    expect((await admin.req('POST', url, { userId: admin.userId })).statusCode).toBe(400);
    // не участник
    expect((await admin.req('POST', url, { userId: bob.userId })).json().error.code).toBe(
      'not_a_member',
    );
    // участник, которому ключ ещё не выдан
    expect((await admin.addMember(tid, carol, 'editor')).statusCode).toBe(204);
    expect((await admin.req('POST', url, { userId: carol.userId })).json().error.code).toBe(
      'key_missing',
    );
    // участник с ключом становится владельцем, прежний владелец — администратором
    expect((await admin.addMember(tid, dave, 'admin', t.key)).statusCode).toBe(204);
    const done = await admin.req('POST', url, { userId: dave.userId });
    expect(done.statusCode, done.body).toBe(200);
    expect((await dave.vaults()).find((v) => v.id === tid)!.role).toBe('owner');
    expect((await admin.vaults()).find((v) => v.id === tid)!.role).toBe('admin');
    // прежний владелец больше не передаёт владение и не удаляет хранилище
    expect((await admin.req('POST', url, { userId: dave.userId })).statusCode).toBe(403);
    expect((await admin.req('DELETE', `/vaults/${tid}`)).statusCode).toBe(403);
    // новый владелец передаёт обратно
    expect((await dave.req('POST', url, { userId: admin.userId })).statusCode).toBe(200);
    expect((await admin.vaults()).find((v) => v.id === tid)!.role).toBe('owner');
    // личный сейф передать нельзя
    const locker = (await admin.vaults()).find((v) => v.kind === 'locker')!;
    expect(
      (await admin.req('POST', `/vaults/${locker.id}/transfer-ownership`, { userId: dave.userId }))
        .statusCode,
    ).toBe(403);
  });

  it('the personal locker cannot be shared or renamed', async () => {
    const locker = (await admin.vaults()).find((v) => v.kind === 'locker')!;
    expect((await admin.addMember(locker.id, bob, 'reader')).statusCode).toBe(403);
    expect((await admin.req('PATCH', `/vaults/${locker.id}`, { name: 'x' })).statusCode).toBe(403);
    expect((await admin.req('DELETE', `/vaults/${locker.id}`)).statusCode).toBe(403);
  });
});

describe('folders, moving, trash and bulk operations', () => {
  let a: string, b: string, c: string;
  const names = new Map<string, string>();

  it('creates nested branches with encrypted names and refuses cycles', async () => {
    a = (await admin.createBranch(vaultId, vk, 'Finance')).id;
    b = (await admin.createBranch(vaultId, vk, 'Payroll', a)).id;
    c = (await admin.createBranch(vaultId, vk, 'Q4', b)).id;
    const t = await tree(admin);
    expect(t.branches).toHaveLength(3);
    for (const br of t.branches)
      names.set(br.id, await decryptBranchName(br.nameCipher, vk, vaultId, br.id, br.keyVersion));
    expect(names.get(a)).toBe('Finance');
    expect(JSON.stringify(t)).not.toContain('Finance');
    // переместить Finance внутрь собственного потомка нельзя
    const cyc = await admin.req('PATCH', `/vaults/${vaultId}/branches/${a}`, { parentId: c });
    expect(cyc.statusCode).toBe(409);
    expect(cyc.json().error.code).toBe('cycle');
    expect(
      (await admin.req('PATCH', `/vaults/${vaultId}/branches/${a}`, { parentId: a })).statusCode,
    ).toBe(409);
  });

  it('renames and moves branches', async () => {
    const nameCipher = await encryptBranchName('Q4 2026', vk, vaultId, c, 1);
    expect(
      (await admin.req('PATCH', `/vaults/${vaultId}/branches/${c}`, { nameCipher, keyVersion: 1 }))
        .statusCode,
    ).toBe(200);
    expect(
      (await admin.req('PATCH', `/vaults/${vaultId}/branches/${c}`, { parentId: a })).statusCode,
    ).toBe(200);
    const br = (await tree(admin)).branches.find((x) => x.id === c)!;
    expect(br.parentId).toBe(a);
    expect(await decryptBranchName(br.nameCipher, vk, vaultId, c, 1)).toBe('Q4 2026');
  });

  it('puts entries into branches, moves them, deletes a branch with content and restores it together', async () => {
    const e1 = (await admin.createEntry({ title: 'Bank' }, { vaultId, vaultKey: vk, branchId: b }))
      .entryId;
    const e2 = (await admin.createEntry({ title: 'Tax' }, { vaultId, vaultKey: vk, branchId: c }))
      .entryId;
    const e3 = (await admin.createEntry({ title: 'Loose' }, { vaultId, vaultKey: vk })).entryId;

    expect(
      (
        await admin.req('POST', `/vaults/${vaultId}/entries/bulk`, {
          ids: [e3],
          action: 'move',
          branchId: b,
        })
      ).statusCode,
    ).toBe(200);
    expect((await tree(admin)).entries.find((e) => e.id === e3)!.branchId).toBe(b);

    expect((await admin.req('DELETE', `/vaults/${vaultId}/branches/${a}`)).statusCode).toBe(204);
    const live = await tree(admin);
    expect(live.branches.find((x) => x.id === a)).toBeUndefined();
    expect(live.entries.find((e) => e.id === e1)).toBeUndefined();
    const trash = await tree(admin, vaultId, true);
    expect(trash.branches.map((x) => x.id).sort()).toEqual([a, b, c].sort());
    expect(trash.entries.map((e) => e.id).sort()).toEqual([e1, e2, e3].sort());

    expect((await admin.req('POST', `/vaults/${vaultId}/branches/${a}/restore`)).statusCode).toBe(
      204,
    );
    const back = await tree(admin);
    expect(back.branches.map((x) => x.id)).toEqual(expect.arrayContaining([a, b, c]));
    expect(back.entries.map((e) => e.id)).toEqual(expect.arrayContaining([e1, e2, e3]));
    expect((await tree(admin, vaultId, true)).entries).toHaveLength(0);
  });

  it('purge requires the trash first; bulk trash/restore/purge work and are all-or-nothing', async () => {
    const x = (await admin.createEntry({ title: 'X' }, { vaultId, vaultKey: vk })).entryId;
    const y = (await admin.createEntry({ title: 'Y' }, { vaultId, vaultKey: vk })).entryId;
    expect((await admin.req('DELETE', `/vaults/${vaultId}/entries/${x}?purge=1`)).statusCode).toBe(
      409,
    );
    expect(
      (await admin.req('POST', `/vaults/${vaultId}/entries/bulk`, { ids: [x, y], action: 'trash' }))
        .statusCode,
    ).toBe(200);
    expect((await tree(admin, vaultId, true)).entries.map((e) => e.id)).toEqual(
      expect.arrayContaining([x, y]),
    );
    expect(
      (await admin.req('POST', `/vaults/${vaultId}/entries/bulk`, { ids: [x], action: 'restore' }))
        .statusCode,
    ).toBe(200);
    expect((await tree(admin)).entries.some((e) => e.id === x)).toBe(true);
    // читатель не может выполнять массовые операции; ни одна запись не изменяется
    const carolsTree = await tree(carol);
    expect(carolsTree.entries.length).toBeGreaterThan(0);
    const denied = await carol.req('POST', `/vaults/${vaultId}/entries/bulk`, {
      ids: [x],
      action: 'trash',
    });
    expect(denied.statusCode).toBe(403);
    expect(
      (await admin.req('POST', `/vaults/${vaultId}/entries/bulk`, { ids: [y], action: 'purge' }))
        .statusCode,
    ).toBe(200);
    expect((await tree(admin, vaultId, true)).entries.some((e) => e.id === y)).toBe(false);
    expect(
      (await admin.req('POST', `/vaults/${vaultId}/entries/bulk`, { ids: [y], action: 'trash' }))
        .statusCode,
    ).toBe(404);
  });

  it('the maintenance job purges the trash after the retention period', async () => {
    const z = (await admin.createEntry({ title: 'Old' }, { vaultId, vaultKey: vk })).entryId;
    await admin.req('POST', `/vaults/${vaultId}/entries/bulk`, { ids: [z], action: 'trash' });
    expect((await runMaintenance(database.db)).trash).toBe(0);
    const future = new Date(Date.now() + 31 * 86_400_000);
    expect((await runMaintenance(database.db, future)).trash).toBeGreaterThanOrEqual(1);
    expect((await tree(admin, vaultId, true)).entries.some((e) => e.id === z)).toBe(false);
  });
});

describe('revision history', () => {
  it('keeps previous versions, restores them, and hides history from users who lost access', async () => {
    const { entryId } = await admin.createEntry(
      { title: 'Router', password: 'v1' },
      { vaultId, vaultKey: vk },
    );
    const update = async (payload: unknown, expectedVersion: number) => {
      const enc = await encryptEntry(payload, vk, vaultId, entryId, 1);
      return admin.req('PUT', `/vaults/${vaultId}/entries/${entryId}`, { ...enc, expectedVersion });
    };
    expect((await update({ title: 'Router', password: 'v2' }, 1)).statusCode).toBe(200);
    expect((await update({ title: 'Router', password: 'v3' }, 2)).statusCode).toBe(200);

    const revs = (
      await admin.req('GET', `/vaults/${vaultId}/entries/${entryId}/revisions`)
    ).json() as RevisionRecord[];
    expect(revs.map((r) => r.version)).toEqual([2, 1]);
    expect(await decryptEntry(revs[1]!, vk, vaultId, entryId)).toMatchObject({ password: 'v1' });

    const restored = await admin.req(
      'POST',
      `/vaults/${vaultId}/entries/${entryId}/revisions/${revs[1]!.id}/restore`,
      { expectedVersion: 3 },
    );
    expect(restored.statusCode).toBe(200);
    expect(await admin.readEntry(vaultId, entryId, vk)).toMatchObject({ password: 'v1' });
    const after = (
      await admin.req('GET', `/vaults/${vaultId}/entries/${entryId}/revisions`)
    ).json() as RevisionRecord[];
    expect(after.map((r) => r.version)).toEqual([3, 2, 1]); // состояние до возврата не потеряно

    // конфликт версий при возврате
    expect(
      (
        await admin.req(
          'POST',
          `/vaults/${vaultId}/entries/${entryId}/revisions/${revs[0]!.id}/restore`,
          { expectedVersion: 1 },
        )
      ).statusCode,
    ).toBe(409);

    // не участник и участник без доступа историю не видят
    expect(
      (await dave.req('GET', `/vaults/${vaultId}/entries/${entryId}/revisions`)).statusCode,
    ).toBe(404);
  });

  it('keeps at most 100 revisions per entry', async () => {
    const { entryId } = await admin.createEntry({ n: 0 }, { vaultId, vaultKey: vk });
    for (let v = 1; v <= 105; v++) {
      const enc = await encryptEntry({ n: v }, vk, vaultId, entryId, 1);
      expect(
        (
          await admin.req('PUT', `/vaults/${vaultId}/entries/${entryId}`, {
            ...enc,
            expectedVersion: v,
          })
        ).statusCode,
      ).toBe(200);
    }
    const revs = (
      await admin.req('GET', `/vaults/${vaultId}/entries/${entryId}/revisions`)
    ).json() as RevisionRecord[];
    expect(revs).toHaveLength(100);
    expect(revs[0]!.version).toBe(105);
  }, 60_000);
});

describe('grants on branches and entries', () => {
  it('a limited member sees only what was granted, with inheritance down the tree and expiry', async () => {
    const root = (await admin.createBranch(vaultId, vk, 'Projects')).id;
    const child = (await admin.createBranch(vaultId, vk, 'Alpha', root)).id;
    const other = (await admin.createBranch(vaultId, vk, 'Secret')).id;
    const inChild = (
      await admin.createEntry({ title: 'Alpha key' }, { vaultId, vaultKey: vk, branchId: child })
    ).entryId;
    const inOther = (
      await admin.createEntry({ title: 'Hidden' }, { vaultId, vaultKey: vk, branchId: other })
    ).entryId;
    const single = (await admin.createEntry({ title: 'Single' }, { vaultId, vaultKey: vk }))
      .entryId;

    expect((await admin.addMember(vaultId, dave, 'limited', vk)).statusCode).toBe(204);
    expect((await tree(dave)).entries).toHaveLength(0);

    const put = (body: object) => admin.req('PUT', `/vaults/${vaultId}/grants`, body);
    expect(
      (
        await put({
          targetType: 'branch',
          targetId: root,
          subjectType: 'user',
          subjectId: dave.userId,
          role: 'reader',
        })
      ).statusCode,
    ).toBe(200);
    let t = await tree(dave);
    expect(t.entries.map((e) => e.id)).toEqual([inChild]);
    expect(t.entries[0]!.access).toBe('reader');
    expect(t.branches.map((b) => b.id).sort()).toEqual([root, child].sort());

    // право на чтение не даёт записи и удаления
    const daveKey = await dave.openVault((await dave.vaults()).find((v) => v.id === vaultId)!);
    const enc = await encryptEntry({ x: 1 }, daveKey, vaultId, inChild, 1);
    expect(
      (
        await dave.req('PUT', `/vaults/${vaultId}/entries/${inChild}`, {
          ...enc,
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(403);
    expect((await dave.req('GET', `/vaults/${vaultId}/entries/${inOther}`)).statusCode).toBe(404);

    // грант на отдельную запись и повышение права на дочерней ветви
    expect(
      (
        await put({
          targetType: 'entry',
          targetId: single,
          subjectType: 'user',
          subjectId: dave.userId,
          role: 'reader',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await put({
          targetType: 'branch',
          targetId: child,
          subjectType: 'user',
          subjectId: dave.userId,
          role: 'editor',
        })
      ).statusCode,
    ).toBe(200);
    t = await tree(dave);
    expect(t.entries.map((e) => e.id).sort()).toEqual([inChild, single].sort());
    expect(t.entries.find((e) => e.id === inChild)!.access).toBe('editor');
    expect(
      (
        await dave.req('PUT', `/vaults/${vaultId}/entries/${inChild}`, {
          ...enc,
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);

    // истёкший грант не действует
    await database.db
      .update(grants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        (await import('drizzle-orm')).and(
          (await import('drizzle-orm')).eq(grants.targetId, single),
          (await import('drizzle-orm')).eq(grants.subjectId, dave.userId),
        ),
      );
    expect((await tree(dave)).entries.map((e) => e.id)).not.toContain(single);

    // прошедший срок при создании отклоняется
    const past = await put({
      targetType: 'entry',
      targetId: single,
      subjectType: 'user',
      subjectId: dave.userId,
      role: 'reader',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.statusCode).toBe(400);

    // участник без прав управления не выдаёт гранты; отзыв гранта действует сразу
    expect(
      (
        await dave.req('PUT', `/vaults/${vaultId}/grants`, {
          targetType: 'branch',
          targetId: child,
          subjectType: 'user',
          subjectId: carol.userId,
          role: 'reader',
        })
      ).statusCode,
    ).toBe(403);
    const list = (await admin.req('GET', `/vaults/${vaultId}/grants?targetId=${root}`)).json();
    expect(list).toHaveLength(1);
    expect((await admin.req('DELETE', `/vaults/${vaultId}/grants/${list[0].id}`)).statusCode).toBe(
      204,
    );
    expect((await tree(dave)).entries.map((e) => e.id)).toEqual([inChild]); // осталась запись из гранта на дочернюю ветвь
  });

  it('a manager grant lets a user delegate on that branch only', async () => {
    const br = (await admin.createBranch(vaultId, vk, 'Delegated')).id;
    const outside = (await admin.createBranch(vaultId, vk, 'Elsewhere')).id;
    await admin.req('PUT', `/vaults/${vaultId}/grants`, {
      targetType: 'branch',
      targetId: br,
      subjectType: 'user',
      subjectId: dave.userId,
      role: 'manager',
    });
    const ok = await dave.req('PUT', `/vaults/${vaultId}/grants`, {
      targetType: 'branch',
      targetId: br,
      subjectType: 'user',
      subjectId: carol.userId,
      role: 'reader',
    });
    expect(ok.statusCode).toBe(200);
    const no = await dave.req('PUT', `/vaults/${vaultId}/grants`, {
      targetType: 'branch',
      targetId: outside,
      subjectType: 'user',
      subjectId: carol.userId,
      role: 'reader',
    });
    expect([403, 404]).toContain(no.statusCode);
  });
});

describe('circles', () => {
  it('members of a circle receive the circle role in the vault; removal takes it away', async () => {
    const created = await admin.req('POST', '/admin/circles', {
      name: 'Support',
      description: 'Help desk',
    });
    expect(created.statusCode).toBe(201);
    const circleId = created.json().id as string;
    expect(
      (await admin.req('PUT', `/admin/circles/${circleId}/members/${bob.userId}`)).statusCode,
    ).toBe(204);
    expect((await admin.req('POST', '/admin/circles', { name: 'Support' })).statusCode).toBe(409);

    const v2 = await admin.createSharedVault('Support vault');
    const before = (await bob.vaults()).some((v) => v.id === v2.id);
    expect(before).toBe(false);
    expect(
      (await admin.req('PUT', `/vaults/${v2.id}/circles/${circleId}`, { role: 'editor' }))
        .statusCode,
    ).toBe(204);
    const bobSees = (await bob.vaults()).find((v) => v.id === v2.id)!;
    expect(bobSees.role).toBe('editor');
    expect(bobSees.pendingKey).toBe(true);
    const pending = (await admin.req('GET', `/vaults/${v2.id}/pending-keys`)).json();
    expect(pending.users.map((u: { userId: string }) => u.userId)).toEqual([bob.userId]);
    // полномочие управлять участниками: у администратора сейфа есть, у редактора нет; очередь и выдачу ключей
    // участник без полномочия не получает, даже с корректно подписанным ключом
    expect((await admin.vaults()).find((v) => v.id === v2.id)!.canManageMembers).toBe(true);
    expect(bobSees.canManageMembers).toBe(false);
    expect((await bob.req('GET', `/vaults/${v2.id}/pending-keys`)).statusCode).toBe(403);
    expect(
      (
        await bob.req('POST', `/vaults/${v2.id}/keys`, {
          keys: [{ userId: bob.userId, ...(await admin.keyFor(bob, v2.id, v2.key)) }],
        })
      ).statusCode,
    ).toBe(403);
    await admin.req('POST', `/vaults/${v2.id}/keys`, {
      keys: [{ userId: bob.userId, ...(await admin.keyFor(bob, v2.id, v2.key)) }],
    });
    expect(
      (await bob.createEntry({ t: 1 }, { vaultId: v2.id, vaultKey: v2.key })).res.statusCode,
    ).toBe(201);

    expect(
      (await admin.req('DELETE', `/admin/circles/${circleId}/members/${bob.userId}`)).statusCode,
    ).toBe(204);
    expect((await bob.vaults()).some((v) => v.id === v2.id)).toBe(false);
    expect((await bob.req('GET', `/vaults/${v2.id}/tree`)).statusCode).toBe(404);
    // обычный пользователь круги не администрирует
    expect((await bob.req('POST', '/admin/circles', { name: 'Evil' })).statusCode).toBe(403);
  });
});

describe('revoking access and rotating the vault key', () => {
  it('rotation re-encrypts everything; the removed member and the old key lose access to current data', async () => {
    const v = await admin.createSharedVault('Rotation');
    const { entryId } = await admin.createEntry(
      { title: 'Prod DB', password: 'secret-1' },
      { vaultId: v.id, vaultKey: v.key },
    );
    const branch = (await admin.createBranch(v.id, v.key, 'Servers')).id;
    // ревизия
    const enc2 = await encryptEntry(
      { title: 'Prod DB', password: 'secret-2' },
      v.key,
      v.id,
      entryId,
      1,
    );
    await admin.req('PUT', `/vaults/${v.id}/entries/${entryId}`, { ...enc2, expectedVersion: 1 });

    await admin.addMember(v.id, bob, 'editor', v.key);
    await admin.addMember(v.id, carol, 'reader', v.key);
    const removed = await admin.req('DELETE', `/vaults/${v.id}/members/${bob.userId}`);
    expect(removed.json().rotationRecommended).toBe(true);
    expect((await bob.req('GET', `/vaults/${v.id}/tree`)).statusCode).toBe(404);

    // ротация без ревизий отклоняется (набор должен быть полным)
    const newKey = createVaultKey();
    const records = (
      await admin.req('GET', `/vaults/${v.id}/entries/${entryId}`)
    ).json() as EntryRecord;
    const revs = (
      await admin.req('GET', `/vaults/${v.id}/entries/${entryId}/revisions`)
    ).json() as RevisionRecord[];
    const br = (await tree(admin, v.id)).branches.find((x) => x.id === branch)!;
    const keys = await Promise.all(
      [admin, carol].map(async (u) => {
        const sealedKey = await sealVaultKeyFor(newKey, u.publicKey, v.id, u.userId, 2);
        return {
          userId: u.userId,
          sealedKey,
          signature: await signKeyGrant(admin.signPrivateKey, v.id, u.userId, 2, sealedKey),
        };
      }),
    );
    const rewrappedEntry = await rewrapEntry(records, v.key, newKey, v.id, entryId, 2);
    const rewrappedRevs = await Promise.all(
      revs.map(async (r) => ({
        id: r.id,
        ...(await rewrapEntry(r, v.key, newKey, v.id, entryId, 2)),
      })),
    );
    const incomplete = await admin.req('POST', `/vaults/${v.id}/rotate`, {
      newKeyVersion: 2,
      keys,
      entries: [{ id: entryId, expectedVersion: records.version, ...rewrappedEntry }],
      revisions: [],
      branches: [
        {
          id: branch,
          expectedVersion: br.version,
          nameCipher: await rewrapBranchName(br.nameCipher, v.key, newKey, v.id, branch, 1, 2),
        },
      ],
    });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().error.code).toBe('incomplete_rotation');

    // ротация без ключа для действующего участника тоже отклоняется
    const missingKey = await admin.req('POST', `/vaults/${v.id}/rotate`, {
      newKeyVersion: 2,
      keys: [keys[0]],
      entries: [{ id: entryId, expectedVersion: records.version, ...rewrappedEntry }],
      revisions: rewrappedRevs,
      branches: [
        {
          id: branch,
          expectedVersion: br.version,
          nameCipher: await rewrapBranchName(br.nameCipher, v.key, newKey, v.id, branch, 1, 2),
        },
      ],
    });
    expect(missingKey.statusCode).toBe(409);

    const ok = await admin.req('POST', `/vaults/${v.id}/rotate`, {
      newKeyVersion: 2,
      keys,
      entries: [{ id: entryId, expectedVersion: records.version, ...rewrappedEntry }],
      revisions: rewrappedRevs,
      branches: [
        {
          id: branch,
          expectedVersion: br.version,
          nameCipher: await rewrapBranchName(br.nameCipher, v.key, newKey, v.id, branch, 1, 2),
        },
      ],
    });
    expect(ok.statusCode).toBe(200);

    // новый ключ открывает данные и ревизии; старый — нет
    const after = (
      await admin.req('GET', `/vaults/${v.id}/entries/${entryId}`)
    ).json() as EntryRecord;
    expect(after.keyVersion).toBe(2);
    expect(await decryptEntry(after, newKey, v.id, entryId)).toMatchObject({
      password: 'secret-2',
    });
    await expect(decryptEntry(after, v.key, v.id, entryId)).rejects.toBeInstanceOf(CryptoAuthError);
    const revsAfter = (
      await admin.req('GET', `/vaults/${v.id}/entries/${entryId}/revisions`)
    ).json() as RevisionRecord[];
    expect(await decryptEntry(revsAfter[0]!, newKey, v.id, entryId)).toMatchObject({
      password: 'secret-1',
    });
    const brAfter = (await tree(admin, v.id)).branches[0]!;
    expect(await decryptBranchName(brAfter.nameCipher, newKey, v.id, branch, 2)).toBe('Servers');

    // оставшийся участник получает новый ключ; запись со старой версией ключа отклоняется
    const carolVault = (await carol.vaults()).find((x) => x.id === v.id)!;
    expect(carolVault.keyVersion).toBe(2);
    expect(carolVault.key!.keyVersion).toBe(2);
    expect(Buffer.from(await carol.openVault(carolVault)).equals(Buffer.from(newKey))).toBe(true);
    const stale = await admin.createEntry(
      { t: 1 },
      { vaultId: v.id, vaultKey: v.key, keyVersion: 1 },
    );
    expect(stale.res.statusCode).toBe(409);
    expect(stale.res.json().error.code).toBe('stale_key_version');
    // удалённый участник не может получить ни данные, ни ключ
    expect((await bob.vaults()).some((x) => x.id === v.id)).toBe(false);
  });
});

describe('handoff links', () => {
  const create = (c: TestClient, body: object = {}) => {
    const id = crypto.randomUUID();
    return c
      .req('POST', '/handoffs', {
        id,
        label: 'router password',
        ciphertext: 'ak1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAA',
        hasPassphrase: false,
        expiresInMinutes: 60,
        maxViews: 1,
        ...body,
      })
      .then((res) => ({ res, id }));
  };
  const open = (id: string) => app.inject({ method: 'POST', url: `/api/v1/handoffs/${id}/open` });

  it('a one-time link can be opened exactly once, without logging in', async () => {
    const { res, id } = await create(admin);
    expect(res.statusCode).toBe(201);
    const meta = await app.inject(`/api/v1/handoffs/${id}/meta`);
    expect(meta.statusCode).toBe(200);
    expect(meta.json().remainingViews).toBe(1);
    const first = await open(id);
    expect(first.statusCode).toBe(200);
    expect(first.json().ciphertext).toContain('ak1.');
    expect((await open(id)).statusCode).toBe(404);
    expect((await app.inject(`/api/v1/handoffs/${id}/meta`)).statusCode).toBe(404);
    const mine = (await admin.req('GET', '/handoffs')).json();
    expect(mine.find((h: { id: string }) => h.id === id).status).toBe('used');
  });

  it('counts views atomically, expires and can be revoked; all failures look the same', async () => {
    const multi = await create(admin, { maxViews: 3 });
    const results = await Promise.all([
      open(multi.id),
      open(multi.id),
      open(multi.id),
      open(multi.id),
      open(multi.id),
    ]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);

    const revoked = await create(admin, { maxViews: 5 });
    expect((await bob.req('DELETE', `/handoffs/${revoked.id}`)).statusCode).toBe(404); // чужую ссылку отозвать нельзя
    expect((await admin.req('DELETE', `/handoffs/${revoked.id}`)).statusCode).toBe(204);
    const gone = await open(revoked.id);
    const never = await open(crypto.randomUUID());
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toMatchObject({
      code: never.json().error.code,
      message: never.json().error.message,
    });

    const short = await create(admin, { expiresInMinutes: 1 });
    const { handoffs } = await import('../src/db/schema.js');
    await database.db.update(handoffs).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await open(short.id)).statusCode).toBe(404);
  });

  it('a link with an open window works for N minutes after the first open, then closes for good', async () => {
    const { res, id } = await create(admin, { maxViews: 10, openWindowMinutes: 5 });
    expect(res.statusCode).toBe(201);
    expect((await app.inject(`/api/v1/handoffs/${id}/meta`)).json().openWindowMinutes).toBe(5);
    expect((await open(id)).statusCode).toBe(200);
    expect((await open(id)).statusCode).toBe(200); // в окне — снова можно
    const { handoffs } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    await database.db
      .update(handoffs)
      .set({ firstOpenedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(handoffs.id, id));
    expect((await open(id)).statusCode).toBe(404);
    expect((await app.inject(`/api/v1/handoffs/${id}/meta`)).statusCode).toBe(404);
    const mine = (await admin.req('GET', '/handoffs')).json();
    expect(mine.find((h: { id: string }) => h.id === id).status).toBe('expired');
    // обслуживание стирает шифртекст закрытой ссылки, не дожидаясь общего срока
    const { runMaintenance } = await import('../src/maintenance.js');
    await runMaintenance(database.db);
    const [row] = await database.db.select().from(handoffs).where(eq(handoffs.id, id));
    expect(row!.ciphertext).toBe('');
  });

  it('organization limits on links are enforced by the server; the recipient sees the organization note', async () => {
    const put = (body: object) => admin.req('PUT', '/admin/settings', body);
    expect(
      (await put({ 'links.maxMinutes': 30, 'links.maxViews': 3, 'links.notice': 'Не пересылайте' }))
        .statusCode,
    ).toBe(200);
    const tooLong = await create(admin, { expiresInMinutes: 60 });
    expect(tooLong.res.statusCode).toBe(400);
    expect(tooLong.res.json().error.code).toBe('link_limit');
    expect((await create(admin, { expiresInMinutes: 30, maxViews: 4 })).res.statusCode).toBe(400);
    const ok = await create(admin, { expiresInMinutes: 30, maxViews: 3 });
    expect(ok.res.statusCode).toBe(201);
    expect((await app.inject(`/api/v1/handoffs/${ok.id}/meta`)).json().notice).toBe(
      'Не пересылайте',
    );
    expect((await admin.req('GET', '/auth/policy')).json()['links.maxViews']).toBe(3);
    expect(
      (await put({ 'links.maxMinutes': 0, 'links.maxViews': 100, 'links.notice': '' })).statusCode,
    ).toBe(200);
  });

  it('generator defaults of the organization reach every member; exclusions are printable characters only', async () => {
    const put = (body: object) => admin.req('PUT', '/admin/settings', body);
    expect(
      (
        await put({
          'generator.length': 32,
          'generator.symbols': false,
          'generator.exclude': 'O0l1',
        })
      ).statusCode,
    ).toBe(200);
    expect((await bob.req('GET', '/auth/policy')).json()).toMatchObject({
      'generator.length': 32,
      'generator.symbols': false,
      'generator.upper': true,
      'generator.exclude': 'O0l1',
    });
    expect((await put({ 'generator.exclude': 'a b' })).statusCode).toBe(400);
    expect((await put({ 'generator.length': 4 })).statusCode).toBe(400);
    expect(
      (await put({ 'generator.length': 20, 'generator.symbols': true, 'generator.exclude': '' }))
        .statusCode,
    ).toBe(200);
  });

  it('rejects malformed requests', async () => {
    expect((await create(admin, { maxViews: 0 })).res.statusCode).toBe(400);
    expect((await create(admin, { expiresInMinutes: 60 * 24 * 31 })).res.statusCode).toBe(400);
    expect((await create(admin, { ciphertext: 'plain text' })).res.statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/handoffs', payload: {} })).statusCode,
    ).toBe(401);
  });
});

describe('security signals', () => {
  it('stores problems by entry id only, closes the ones that disappeared, and is limited to vault administrators', async () => {
    const v = await admin.createSharedVault('Signals');
    const e1 = (await admin.createEntry({ title: 'a' }, { vaultId: v.id, vaultKey: v.key }))
      .entryId;
    const e2 = (await admin.createEntry({ title: 'b' }, { vaultId: v.id, vaultKey: v.key }))
      .entryId;
    const post = (items: object[]) =>
      admin.req('POST', `/vaults/${v.id}/signals`, { items, checkedTypes: ['weak', 'reused'] });
    expect(
      (
        await post([
          { entryId: e1, type: 'weak' },
          { entryId: e2, type: 'reused' },
        ])
      ).json().created,
    ).toBe(2);
    const list = (await admin.req('GET', `/vaults/${v.id}/signals`)).json();
    expect(list).toHaveLength(2);
    expect(JSON.stringify(list)).not.toMatch(/password|secret/i);

    const sig = list.find((s: { type: string }) => s.type === 'weak');
    const patched = await admin.req('PATCH', `/vaults/${v.id}/signals/${sig.id}`, {
      status: 'in_progress',
      assignedTo: admin.userId,
    });
    expect(patched.json().status).toBe('in_progress');
    expect(
      (await admin.req('PATCH', `/vaults/${v.id}/signals/${sig.id}`, { assignedTo: bob.userId }))
        .statusCode,
    ).toBe(400);

    const second = await post([{ entryId: e2, type: 'reused' }]);
    expect(second.json().resolved).toBe(1);
    const after = (await admin.req('GET', `/vaults/${v.id}/signals`)).json();
    expect(after.find((s: { id: string }) => s.id === sig.id).status).toBe('resolved');

    await admin.addMember(v.id, carol, 'reader', v.key);
    expect((await carol.req('GET', `/vaults/${v.id}/signals`)).statusCode).toBe(403);
    expect(
      (await bob.req('POST', `/vaults/${v.id}/signals`, { items: [], checkedTypes: [] }))
        .statusCode,
    ).toBe(404);
  });
});

describe('pins, directory, key log', () => {
  it('pins are personal and disappear when access is revoked', async () => {
    const v = await admin.createSharedVault('Pins');
    const { entryId } = await admin.createEntry({ title: 'P' }, { vaultId: v.id, vaultKey: v.key });
    await admin.addMember(v.id, bob, 'reader', v.key);
    expect((await bob.req('PUT', `/vaults/${v.id}/entries/${entryId}/pin`)).statusCode).toBe(204);
    expect(((await bob.req('GET', '/pins')).json() as unknown[]).length).toBe(1);
    expect((await tree(bob, v.id)).entries[0]!.pinned).toBe(true);
    expect((await tree(admin, v.id)).entries[0]!.pinned).toBe(false);
    await admin.req('DELETE', `/vaults/${v.id}/members/${bob.userId}`);
    expect(((await bob.req('GET', '/pins')).json() as unknown[]).length).toBe(0);
  });

  it('finds users by name or e-mail and exposes a verifiable key log', async () => {
    const found = (await admin.req('GET', '/directory/users?q=carol')).json();
    expect(found).toHaveLength(1);
    expect(found[0].email).toBe('carol@example.com');
    expect((await admin.req('GET', '/directory/users?q=c')).json()).toEqual([]);
    expect((await admin.req('GET', '/directory/users?q=%25')).json()).toEqual([]);

    const log = (await admin.req('GET', '/key-log')).json();
    expect(log).toHaveLength(4);
    expect(await verifyKeyLog(log)).toBe(true);
    expect(log.map((l: { userId: string }) => l.userId)).toContain(carol.userId);
    // подмена записи в журнале обнаруживается
    const tampered = structuredClone(log);
    tampered[1].encPublic = tampered[0].encPublic;
    expect(await verifyKeyLog(tampered)).toBe(false);
    // ключи пользователя в каталоге совпадают с записью журнала
    const entry = log.find((l: { userId: string }) => l.userId === carol.userId);
    expect(entry.encPublic).toBe(found[0].publicKey);
    expect(entry.signPublic).toBe(found[0].signPublicKey);
  });
});

describe('administration', () => {
  it('lists users, protects the last administrator, and ends sessions of disabled users', async () => {
    const list = (await admin.req('GET', '/admin/users')).json();
    expect(list.map((u: { email: string }) => u.email)).toEqual(
      expect.arrayContaining(['admin@example.com', 'bob@example.com']),
    );
    expect((await bob.req('GET', '/admin/users')).statusCode).toBe(403);

    const self = await admin.req('PATCH', `/admin/users/${admin.userId}`, { role: 'member' });
    expect(self.statusCode).toBe(409);
    // единственный администратор — главный: роль сначала передаётся
    expect(self.json().error.code).toBe('chief_admin');
    expect(
      (await admin.req('PATCH', `/admin/users/${admin.userId}`, { disabled: true })).statusCode,
    ).toBe(409);

    const victim = new TestClient(app, 'victim@example.com', 'victim-password-123');
    await victim.register();
    await victim.login();
    expect((await victim.vaults()).length).toBe(1);
    expect(
      (
        await admin.req('PATCH', `/admin/users/${victim.userId}`, {
          disabled: true,
          disabledNote: 'Утерян ноутбук',
        })
      ).statusCode,
    ).toBe(200);
    expect((await victim.req('GET', '/vaults')).statusCode).toBe(401);
    expect((await victim.loginRaw()).statusCode).toBe(401);
    // причина и пояснение видны в списке пользователей
    const row = async () =>
      ((await admin.req('GET', '/admin/users')).json() as { email: string }[]).find(
        (u) => u.email === 'victim@example.com',
      );
    expect(await row()).toMatchObject({
      disabled: true,
      disabledReason: 'manual',
      disabledNote: 'Утерян ноутбук',
    });
    expect(
      (await admin.req('PATCH', `/admin/users/${victim.userId}`, { disabled: false })).statusCode,
    ).toBe(200);
    expect(await row()).toMatchObject({
      disabled: false,
      disabledReason: null,
      disabledNote: null,
    });
    expect((await victim.loginRaw()).statusCode).toBe(200);
  });

  it('validates and stores settings', async () => {
    expect(
      (await admin.req('PUT', '/admin/settings', { 'trash.retentionDays': 7 })).statusCode,
    ).toBe(200);
    expect(
      ((await admin.req('GET', '/admin/settings')).json() as Record<string, unknown>)[
        'trash.retentionDays'
      ],
    ).toBe(7);
    expect(
      (await admin.req('PUT', '/admin/settings', { 'trash.retentionDays': 0 })).statusCode,
    ).toBe(400);
    expect((await admin.req('PUT', '/admin/settings', { 'unknown.key': 1 })).statusCode).toBe(400);
    expect(
      (await bob.req('PUT', '/admin/settings', { 'vaults.creators': 'members' })).statusCode,
    ).toBe(403);
    await admin.req('PUT', '/admin/settings', { 'vaults.creators': 'members' });
    expect((await bob.createSharedVault('Bob now may')).res.statusCode).toBe(201);
  });

  it('the action log filters, pages, exports CSV and contains no secrets', async () => {
    const all = (await admin.req('GET', '/admin/ledger?limit=500')).json();
    expect(all.items.length).toBeGreaterThan(20);
    expect(JSON.stringify(all)).not.toMatch(/ak1\.|as1\.|password-123|"authKey"/);
    const filtered = (await admin.req('GET', '/admin/ledger?action=vault.&limit=500')).json();
    expect(filtered.items.every((i: { action: string }) => i.action.startsWith('vault.'))).toBe(
      true,
    );
    const page1 = (await admin.req('GET', '/admin/ledger?limit=5')).json();
    const page2 = (await admin.req('GET', `/admin/ledger?limit=5&before=${page1.next}`)).json();
    expect(page2.items[0].id).toBeLessThan(page1.items[4].id);
    // сортировка по действию и по времени в обе стороны: страницы продолжают друг друга без пропусков
    const walk = async (query: string) => {
      const seen: { id: number; action: string }[] = [];
      let before = '';
      for (let i = 0; i < 100; i++) {
        const r = (await admin.req('GET', `/admin/ledger?limit=7&${query}${before}`)).json();
        seen.push(...r.items);
        if (!r.next) break;
        before = `&before=${encodeURIComponent(String(r.next))}`;
      }
      return seen;
    };
    const total = (await admin.req('GET', '/admin/ledger?limit=500')).json().items.length;
    const byAction = await walk('sort=action&dir=asc');
    expect(byAction).toHaveLength(total);
    expect(new Set(byAction.map((i) => i.id)).size).toBe(total);
    const key = (i: { id: number; action: string }) => [i.action, i.id] as const;
    for (let i = 1; i < byAction.length; i++) {
      const [a, b] = [key(byAction[i - 1]!), key(byAction[i]!)];
      expect(a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])).toBe(true);
    }
    const byActionDesc = await walk('sort=action&dir=desc');
    expect(byActionDesc.map((i) => i.id)).toEqual(byAction.map((i) => i.id).reverse());
    const oldest = await walk('dir=asc');
    expect(oldest.map((i) => i.id)).toEqual([...oldest.map((i) => i.id)].sort((a, b) => a - b));
    expect(oldest).toHaveLength(total);
    expect((await admin.req('GET', '/admin/ledger?before=1;drop')).statusCode).toBe(400);
    const csv = (await admin.req('GET', '/admin/ledger?format=csv&limit=10')).json().csv as string;
    expect(csv.split('\n')[0]).toBe(
      'id,at,actor,actor_name,action,target,target_name,detail,level',
    );
    // поиск по сотруднику: имя или почта автора
    const byPerson = (await admin.req('GET', '/admin/ledger?q=bob%40example&limit=500')).json();
    expect(byPerson.items.length).toBeGreaterThan(0);
    expect(
      byPerson.items.every(
        (i: { actorName: string | null; targetName: string | null; target: string | null }) =>
          `${i.actorName} ${i.targetName} ${i.target}`.includes('bob@example'),
      ),
    ).toBe(true);
    // журнал сотрудника: его действия и действия над его учётной записью — и только они
    const own = (await admin.req('GET', `/admin/ledger?user=${bob.userId}&limit=500`)).json();
    const mine = (i: { actor: string; target: string | null }) =>
      i.actor === `user:${bob.userId}` || i.target === `user:${bob.userId}`;
    expect(own.items.length).toBeGreaterThan(0);
    expect(own.items.every(mine)).toBe(true);
    expect(own.items.length).toBe(all.items.filter(mine).length);
    // поиск по IP: адрес входа хранится в подробностях события
    const ip = all.items.find((i: { detail: { ip?: string } | null }) => i.detail?.ip)?.detail
      .ip as string;
    expect(ip).toBeTruthy();
    const byIp = (
      await admin.req('GET', `/admin/ledger?q=${encodeURIComponent(ip)}&limit=500`)
    ).json();
    expect(byIp.items.some((i: { action: string }) => i.action === 'auth.login')).toBe(true);
    expect((await admin.req('GET', '/admin/ledger?user=not-a-uuid')).statusCode).toBe(400);
    expect((await bob.req('GET', '/admin/ledger')).statusCode).toBe(403);
    void entries;
  });
});
