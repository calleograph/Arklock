import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  fromBase64Url,
  managedWrapKey,
  openVaultKey,
  sealVaultKeyFor,
  signKeyGrant,
  toBase64Url,
  unwrapAccountPrivateKey,
  unwrapSignPrivateKey,
} from '@arklock/crypto';
import { loadAccess } from './access.js';
import { audit } from './audit.js';
import { rowsOf, type Db } from './db/connect.js';
import { settings, users, vaultKeys, vaults } from './db/schema.js';
import { notifyUsers } from './notifications.js';
import { openSetting, sealSetting } from './secretbox.js';

/**
 * Режим ключей. «strict» — ключи шифрования есть только у сотрудников (пароль разблокировки сейфов, ключ восстановления),
 * сервер прочитать данные не может. «managed» («простой вход») — для сотрудников, входящих через каталог или единый вход,
 * секрет разблокировки хранит сервер (зашифрованным ключом установки) и выдаёт его только после входа и второго фактора:
 * пароля разблокировки нет, а ключи сейфов выдаёт сам сервер, как только человеку назначен доступ. Цена: тот, кто управляет
 * сервером и его базой, может расшифровать данные сотрудников такого режима.
 */
export const KEY_MODE_KEY = 'security.keyMode';
export type KeyMode = 'strict' | 'managed';

export async function keyModeOf(db: Db): Promise<KeyMode> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY_MODE_KEY));
  return row?.value === 'managed' ? 'managed' : 'strict';
}

/** Что нужно для выдачи ключей: база и ключ установки, которым зашифрованы секреты сотрудников. */
export interface ManagedDeps {
  db: Db;
  appSecret: string;
}

const PURPOSE = 'managed-secret';

/** Новый секрет сотрудника в открытом виде: его получает только сам сотрудник при создании учётной записи. */
export const newManagedSecret = (): string => toBase64Url(randomBytes(32));
export const sealManagedSecret = (appSecret: string, secret: string): string =>
  sealSetting(appSecret, PURPOSE, secret);
export const openManagedSecret = (appSecret: string, sealed: string): string =>
  openSetting(appSecret, PURPOSE, sealed);

/** Сотрудники, у которых есть доступ к сейфу, но нет ключа его текущей версии (и у которых уже есть открытый ключ). */
export async function pendingKeyUsers(db: Db, vaultId: string, keyVersion: number) {
  const ids = await db.execute<{ id: string }>(sql`
    select distinct u.id from users u
    where u.disabled_at is null and not u.pending_activation and (
      exists (select 1 from vault_members m where m.vault_id = ${vaultId} and m.user_id = u.id)
      or exists (select 1 from vault_circles vc join circle_members cm on cm.circle_id = vc.circle_id
                 where vc.vault_id = ${vaultId} and cm.user_id = u.id)
      or exists (select 1 from grants g where g.vault_id = ${vaultId} and (
        (g.subject_type = 'user' and g.subject_id = u.id) or
        (g.subject_type = 'circle' and exists (select 1 from circle_members cm where cm.circle_id = g.subject_id and cm.user_id = u.id))))
    ) and not exists (select 1 from vault_keys k where k.vault_id = ${vaultId} and k.user_id = u.id and k.key_version = ${keyVersion})`);
  const list: string[] = [];
  for (const r of rowsOf<{ id: string }>(ids))
    if ((await loadAccess(db, vaultId, r.id)).isMember) list.push(r.id);
  return list.length ? db.select().from(users).where(inArray(users.id, list)) : [];
}

/**
 * Выдача ключей сервером (только в режиме «managed»): ключ сейфа открывает один из держателей ключа с секретом на сервере,
 * запечатывает его открытым ключом каждого, кому ключ ещё не выдан, и подписывает выдачу. Ротацию ключа сейфа это не заменяет:
 * она остаётся за клиентом администратора. Возвращает число выданных ключей; без подходящего держателя ничего не делает,
 * ключи выдаст клиент администратора, как в строгом режиме.
 */
export async function grantPendingKeys(deps: ManagedDeps, vaultId: string): Promise<number> {
  const { db } = deps;
  if ((await keyModeOf(db)) !== 'managed') return 0;
  const [v] = await db.select().from(vaults).where(eq(vaults.id, vaultId));
  if (!v || v.kind !== 'shared') return 0;
  const pending = await pendingKeyUsers(db, vaultId, v.keyVersion);
  if (!pending.length) return 0;
  const holders = await db
    .select({ user: users, key: vaultKeys })
    .from(vaultKeys)
    .innerJoin(users, eq(users.id, vaultKeys.userId))
    .where(
      and(
        eq(vaultKeys.vaultId, vaultId),
        eq(vaultKeys.keyVersion, v.keyVersion),
        isNotNull(users.managedSecret),
        isNull(users.disabledAt),
        eq(users.pendingActivation, false),
      ),
    );
  for (const h of holders) {
    let vaultKey: Uint8Array | null = null;
    let signPrivate: Uint8Array | null = null;
    let privateKey: Uint8Array | null = null;
    try {
      const wrapKey = await managedWrapKey(
        fromBase64Url(openManagedSecret(deps.appSecret, h.user.managedSecret!)),
      );
      privateKey = await unwrapAccountPrivateKey(wrapKey, h.user.wrappedPrivateKey, h.user.id);
      signPrivate = await unwrapSignPrivateKey(wrapKey, h.user.wrappedSignPrivateKey, h.user.id);
      vaultKey = await openVaultKey(
        h.key.sealedKey,
        privateKey,
        fromBase64Url(h.user.publicKey),
        vaultId,
        h.user.id,
        v.keyVersion,
      );
      const rows = [];
      for (const r of pending) {
        if (!r.publicKey) continue;
        const sealedKey = await sealVaultKeyFor(
          vaultKey,
          fromBase64Url(r.publicKey),
          vaultId,
          r.id,
          v.keyVersion,
        );
        rows.push({
          vaultId,
          userId: r.id,
          keyVersion: v.keyVersion,
          sealedKey,
          grantedBy: h.user.id,
          signature: await signKeyGrant(signPrivate, vaultId, r.id, v.keyVersion, sealedKey),
        });
      }
      if (!rows.length) return 0;
      const issued = await db
        .insert(vaultKeys)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: vaultKeys.userId });
      await notifyUsers(
        db,
        issued.map((x) => x.id),
        {
          category: 'access',
          event: 'vault.key.issued',
          vaultId,
          resourceType: 'vault',
          resourceId: vaultId,
        },
      );
      await audit(db, 'system:managed-keys', 'vault.keys.auto', `vault:${vaultId}`, {
        count: issued.length,
        holder: h.user.id,
      });
      return issued.length;
    } catch {
      // этот держатель не подошёл (ключ не открылся): пробуем следующего
      continue;
    } finally {
      vaultKey?.fill(0);
      signPrivate?.fill(0);
      privateKey?.fill(0);
    }
  }
  return 0;
}

/** Все сейфы, к которым у сотрудника есть доступ без ключа: выдача сразу после создания учётной записи и при входе. */
export async function grantPendingKeysForUser(deps: ManagedDeps, userId: string): Promise<number> {
  if ((await keyModeOf(deps.db)) !== 'managed') return 0;
  const rows = await deps.db.execute<{ id: string }>(sql`
    select v.id from vaults v
    where v.kind = 'shared' and (
      exists (select 1 from vault_members m where m.vault_id = v.id and m.user_id = ${userId})
      or exists (select 1 from vault_circles vc join circle_members cm on cm.circle_id = vc.circle_id
                 where vc.vault_id = v.id and cm.user_id = ${userId})
      or exists (select 1 from grants g where g.vault_id = v.id and (
        (g.subject_type = 'user' and g.subject_id = ${userId}) or
        (g.subject_type = 'circle' and exists (select 1 from circle_members cm where cm.circle_id = g.subject_id and cm.user_id = ${userId}))))
    ) and not exists (select 1 from vault_keys k where k.vault_id = v.id and k.user_id = ${userId} and k.key_version = v.key_version)`);
  let n = 0;
  for (const r of rowsOf<{ id: string }>(rows)) n += await grantPendingKeys(deps, r.id);
  return n;
}

/** Сейфы, где у кого-то есть доступ без ключа (обслуживание: догоняет изменения состава групп и каталога). */
export async function grantAllPendingKeys(deps: ManagedDeps): Promise<number> {
  if ((await keyModeOf(deps.db)) !== 'managed') return 0;
  const rows = await deps.db.execute<{ id: string }>(sql`
    select distinct v.id from vaults v
    where v.kind = 'shared' and exists (
      select 1 from users u where u.disabled_at is null and not u.pending_activation and u.public_key <> '' and (
        exists (select 1 from vault_members m where m.vault_id = v.id and m.user_id = u.id)
        or exists (select 1 from vault_circles vc join circle_members cm on cm.circle_id = vc.circle_id
                   where vc.vault_id = v.id and cm.user_id = u.id)
      ) and not exists (select 1 from vault_keys k where k.vault_id = v.id and k.user_id = u.id and k.key_version = v.key_version))`);
  let n = 0;
  for (const r of rowsOf<{ id: string }>(rows)) n += await grantPendingKeys(deps, r.id);
  return n;
}

/** Выдача без права мешать основному действию: сбой записывается в журнал процесса, запрос не отменяется. */
export async function autoGrant(deps: ManagedDeps, vaultIds: string[]): Promise<void> {
  for (const id of new Set(vaultIds))
    await grantPendingKeys(deps, id).catch((e: unknown) => {
      process.stderr.write(`managed key grant failed for vault ${id}: ${String(e)}\n`);
    });
}
