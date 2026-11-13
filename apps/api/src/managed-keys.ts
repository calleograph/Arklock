import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
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

/**
 * «У сотрудника есть доступ к сейфу»: прямая роль, роль через группу или правило на папку или запись. Единое условие
 * для всех выборок: выдача сервером и список «ожидают ключ» в панели не должны расходиться.
 */
const hasAccess = (vault: SQL, user: SQL) => sql`(
  exists (select 1 from vault_members m where m.vault_id = ${vault} and m.user_id = ${user})
  or exists (select 1 from vault_circles vc join circle_members cm on cm.circle_id = vc.circle_id
             where vc.vault_id = ${vault} and cm.user_id = ${user})
  or exists (select 1 from grants g where g.vault_id = ${vault} and (
    (g.subject_type = 'user' and g.subject_id = ${user}) or
    (g.subject_type = 'circle' and exists (select 1 from circle_members cm
                                           where cm.circle_id = g.subject_id and cm.user_id = ${user}))))
)`;
const lacksKey = (vault: SQL, user: SQL, version: SQL) =>
  sql`not exists (select 1 from vault_keys k where k.vault_id = ${vault} and k.user_id = ${user} and k.key_version = ${version})`;

/** Сотрудники, у которых есть доступ к сейфу, но нет ключа его текущей версии. */
export async function pendingKeyUsers(db: Db, vaultId: string, keyVersion: number) {
  const ids = await db.execute<{ id: string }>(sql`
    select distinct u.id from users u
    where u.disabled_at is null and not u.pending_activation
      and ${hasAccess(sql`${vaultId}`, sql`u.id`)}
      and ${lacksKey(sql`${vaultId}`, sql`u.id`, sql`${keyVersion}`)}`);
  const list: string[] = [];
  for (const r of rowsOf<{ id: string }>(ids))
    if ((await loadAccess(db, vaultId, r.id)).isMember) list.push(r.id);
  return list.length ? db.select().from(users).where(inArray(users.id, list)) : [];
}

/** Есть ли вообще участники с секретом на сервере: без них выдавать ключи некому и сверка не нужна. */
const hasManagedHolders = async (db: Db): Promise<boolean> =>
  (await db.select({ id: users.id }).from(users).where(isNotNull(users.managedSecret)).limit(1))
    .length > 0;

/** Сбой выдачи ключей не прерывает основное действие, но не должен оставаться незамеченным. */
export function logGrantFailure(e: unknown): number {
  process.stderr.write(`managed key grant failed: ${String(e)}\n`);
  return 0;
}

/** Обёртки закрытых ключей должны открываться секретом: иначе человек запер бы себя сам. */
export async function assertWrapsOpen(
  secret: string,
  userId: string,
  wrappedPrivateKey: string,
  wrappedSignPrivateKey: string,
): Promise<boolean> {
  const wrapKey = await managedWrapKey(fromBase64Url(secret));
  try {
    (await unwrapAccountPrivateKey(wrapKey, wrappedPrivateKey, userId)).fill(0);
    (await unwrapSignPrivateKey(wrapKey, wrappedSignPrivateKey, userId)).fill(0);
    return true;
  } catch {
    return false;
  } finally {
    wrapKey.fill(0);
  }
}

/**
 * Выдача ключей сервером (только в режиме «managed»): ключ сейфа открывает один из держателей ключа с секретом на сервере,
 * запечатывает его открытым ключом каждого, кому ключ ещё не выдан, и подписывает выдачу. Ротацию ключа сейфа это не заменяет:
 * она остаётся за клиентом администратора. Возвращает число выданных ключей; без подходящего держателя ничего не делает,
 * ключи выдаст клиент администратора, как в строгом режиме. Если держатели есть, но ни один не подошёл, пишет предупреждение.
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
      // параллельный запуск мог выдать те же ключи раньше: в журнал пишет тот, кто выдал
      if (issued.length) {
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
      }
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
  if (holders.length)
    process.stderr.write(
      `managed key grant: no holder could open the key of vault ${vaultId} (${pending.length} waiting)\n`,
    );
  return 0;
}

/** Все сейфы, к которым у сотрудника есть доступ без ключа: выдача сразу после создания учётной записи и при входе. */
export async function grantPendingKeysForUser(deps: ManagedDeps, userId: string): Promise<number> {
  if ((await keyModeOf(deps.db)) !== 'managed' || !(await hasManagedHolders(deps.db))) return 0;
  const rows = await deps.db.execute<{ id: string }>(sql`
    select v.id from vaults v
    where v.kind = 'shared'
      and ${hasAccess(sql`v.id`, sql`${userId}::uuid`)}
      and ${lacksKey(sql`v.id`, sql`${userId}::uuid`, sql`v.key_version`)}`);
  let n = 0;
  for (const r of rowsOf<{ id: string }>(rows)) n += await grantPendingKeys(deps, r.id);
  return n;
}

/**
 * Сейфы, где у кого-то есть доступ без ключа (догоняет изменения состава групп и каталога). За один запуск не больше 20
 * сейфов: сразу после включения режима проверка доступа по людям не должна занимать базу минутами, остальные — в следующий раз.
 */
export async function grantAllPendingKeys(deps: ManagedDeps): Promise<number> {
  if ((await keyModeOf(deps.db)) !== 'managed' || !(await hasManagedHolders(deps.db))) return 0;
  const rows = await deps.db.execute<{ id: string }>(sql`
    select distinct v.id from vaults v
    where v.kind = 'shared' and exists (
      select 1 from users u
      where u.disabled_at is null and not u.pending_activation and u.public_key <> ''
        and ${hasAccess(sql`v.id`, sql`u.id`)}
        and ${lacksKey(sql`v.id`, sql`u.id`, sql`v.key_version`)})
    limit 20`);
  let n = 0;
  for (const r of rowsOf<{ id: string }>(rows)) n += await grantPendingKeys(deps, r.id);
  return n;
}
