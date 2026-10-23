import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import {
  createHandoff,
  createVaultKey,
  decryptBranchMeta,
  decryptBranchName,
  decryptEntry,
  encryptBranchMeta,
  encryptBranchName,
  encryptEntry,
  fromBase64Url,
  AttachmentDecryptor,
  AttachmentReencryptor,
  beginAttachment,
  encryptStream,
  encryptedSize,
  openAttachmentKey,
  openAttachmentMeta,
  openVaultKey,
  rewrapBranchMeta,
  rewrapBranchName,
  rewrapEntry,
  sealVaultKeyFor,
  signKeyGrant,
  verifyKeyGrant,
  verifyKeyLog,
  ctx,
  sign,
  toBase64Url,
  utf8,
} from '@arklock/crypto';
import type {
  AttachmentRecord,
  BranchRecord,
  EntryRecord,
  RevisionRecord,
  VaultInfo,
  SpaceInfo,
} from '@arklock/contracts';
import { api, ApiError, apiBinary, apiStream } from '../services/api';
import {
  blankEntry,
  normalizeEntry,
  searchText,
  type BranchItem,
  type EntryData,
  type EntryItem,
} from '../services/model';
import { useAuthStore } from './auth';
import { checkPolicy, type PasswordPolicy } from '../services/policy';
import { cleanIcon, type ObjectIcon } from '../services/objectIcons';
import type { RecoveryRecipient, RecoverySecrets } from '../services/corporate-recovery';

/** Ключи хранилищ — вне реактивного состояния; стираются при блокировке. */
const vaultKeys = new Map<string, Uint8Array>();
const keyOf = (vaultId: string, version: number) => vaultKeys.get(`${vaultId}:${version}`);

interface KeyLogEntry {
  seq: number;
  userId: string;
  encPublic: string;
  signPublic: string;
  prevHash: string;
  hash: string;
}

export interface VaultView extends VaultInfo {
  /** Ключ открыт и подпись выдавшего подтверждена. */
  unlocked: boolean;
  problem?: 'pending' | 'bad-signature' | 'unknown-signer' | 'no-key';
}

export interface MemberInfo {
  userId: string;
  name: string;
  email: string;
  publicKey: string;
  signPublicKey: string;
  directRole: string | null;
  directCustomRoleId: string | null;
  directExpiresAt: string | null;
  circles: { id: string; name: string; role: string }[];
  hasKey: boolean;
  spaceAllowed?: boolean;
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const vaults = ref<VaultView[]>([]);
  const spaces = ref<SpaceInfo[]>([]);
  const currentSpaceId = ref<string | null>(null);
  const currentId = ref<string | null>(null);
  const branches = shallowRef<BranchItem[]>([]);
  const entries = shallowRef<EntryItem[]>([]);
  /** Итог последней проверки утечек: для какого набора записей и что найдено (только в памяти вкладки). */
  const breaches = shallowRef<{ snapshot: string; found: Map<string, number> } | null>(null);
  const trash = shallowRef<{ branches: BranchItem[]; entries: EntryItem[] }>({
    branches: [],
    entries: [],
  });
  const loading = ref(false);
  const skipped = ref(0);
  const keyLogOk = ref(true);
  /** Поиск по паролям: строка в шапке, список читает её здесь. */
  const searchQuery = ref('');
  /** Политика организации: false — личные сейфы не показываются и не принимают записи. */
  const personalAllowed = ref(false);
  const personalDataRestricted = ref(false);
  /** Записей в личном сейфе (без содержимого) и закрытые сотрудником уведомления — из профиля на сервере. */
  const personalEntries = ref(0);
  const dismissedNotices = ref<string[]>([]);
  let keyLog: KeyLogEntry[] = [];

  const current = computed(() => vaults.value.find((v) => v.id === currentId.value) ?? null);
  const locker = computed(() => vaults.value.find((v) => v.kind === 'locker') ?? null);
  const spaceVaults = computed(() =>
    vaults.value.filter((v) =>
      currentSpaceId.value ? v.spaceId === currentSpaceId.value : v.kind === 'locker',
    ),
  );

  function clear(): void {
    for (const k of vaultKeys.values()) k.fill(0);
    vaultKeys.clear();
    vaults.value = [];
    spaces.value = [];
    currentSpaceId.value = null;
    searchQuery.value = '';
    currentId.value = null;
    branches.value = [];
    entries.value = [];
    trash.value = { branches: [], entries: [] };
    keyLog = [];
    personalAllowed.value = false;
    personalDataRestricted.value = false;
  }

  // ------------------------------------------------------------------ доверие к ключам

  /**
   * Журнал привязки ключей: проверяется целостность цепочки и то, что ранее сохранённая вершина осталась на месте
   * (сервер не переписывал историю).
   */
  async function loadKeyLog(): Promise<void> {
    const all: KeyLogEntry[] = [];
    let after = 0;
    for (;;) {
      const page = await api<KeyLogEntry[]>('GET', `/key-log?after=${after}`);
      all.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1]!.seq;
    }
    keyLog = all;
    let ok = await verifyKeyLog(all);
    const me = useAuthStore().user!.id;
    const pinKey = `arklock.keylog.${me}`;
    try {
      const saved = JSON.parse(localStorage.getItem(pinKey) ?? 'null') as {
        seq: number;
        hash: string;
      } | null;
      if (saved) {
        const at = all.find((e) => e.seq === saved.seq);
        if (!at || at.hash !== saved.hash) ok = false;
      }
      const tip = all[all.length - 1];
      if (ok && tip) localStorage.setItem(pinKey, JSON.stringify({ seq: tip.seq, hash: tip.hash }));
    } catch {
      /* хранилище недоступно — проверяется только целостность цепочки */
    }
    keyLogOk.value = ok;
  }

  /** Подписывающий ключ пользователя из проверенного журнала (а не из ответа сервера по хранилищу). */
  function signerKey(userId: string): string | null {
    for (let i = keyLog.length - 1; i >= 0; i--)
      if (keyLog[i]!.userId === userId) return keyLog[i]!.signPublic;
    return null;
  }

  // ------------------------------------------------------------------ хранилища

  async function loadVaults(): Promise<void> {
    const auth = useAuthStore();
    const { privateKey, publicKey } = auth.keys();
    spaces.value = await api<SpaceInfo[]>('GET', '/spaces');
    await loadKeyLog();
    const policy = await api<Record<string, unknown>>('GET', '/auth/policy').catch(
      (): Record<string, unknown> => ({}),
    );
    personalAllowed.value = policy['vaults.personalLockers'] === true;
    personalDataRestricted.value = policy['vaults.personalDataRestricted'] === true;
    personalEntries.value = Number(policy['vaults.personalEntries'] ?? 0);
    dismissedNotices.value = (policy['notices.dismissed'] as string[] | undefined) ?? [];
    let infos = (await api<VaultInfo[]>('GET', '/vaults')).filter(
      (v) => personalAllowed.value || v.kind !== 'locker',
    );
    if (personalAllowed.value && !infos.some((v) => v.kind === 'locker')) {
      const id = crypto.randomUUID();
      const key = createVaultKey();
      try {
        const sealedKey = await sealVaultKeyFor(key, publicKey, id, auth.user!.id, 1);
        await api('POST', '/auth/locker', {
          vaultId: id,
          sealedKey,
          signature: await signKeyGrant(
            auth.keys().signPrivateKey,
            id,
            auth.user!.id,
            1,
            sealedKey,
          ),
        });
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'already_exists')) throw e;
      } finally {
        key.fill(0);
      }
      infos = await api<VaultInfo[]>('GET', '/vaults');
    }
    const out: VaultView[] = [];
    for (const v of infos) {
      const view: VaultView = { ...v, unlocked: false };
      if (!v.key) {
        view.problem = 'pending';
      } else {
        const trusted = signerKey(v.key.grantedBy);
        if (!trusted || trusted !== v.key.grantedBySignKey) {
          view.problem = 'unknown-signer';
        } else if (
          !(await verifyKeyGrant(
            fromBase64Url(trusted),
            v.key.signature,
            v.id,
            auth.user!.id,
            v.key.keyVersion,
            v.key.sealedKey,
          ).catch(() => false))
        ) {
          view.problem = 'bad-signature';
        } else {
          try {
            const key = await openVaultKey(
              v.key.sealedKey,
              privateKey,
              publicKey,
              v.id,
              auth.user!.id,
              v.key.keyVersion,
            );
            vaultKeys.set(`${v.id}:${v.key.keyVersion}`, key);
            view.unlocked = v.key.keyVersion === v.keyVersion;
            if (!view.unlocked) view.problem = 'pending';
          } catch {
            view.problem = 'no-key';
          }
        }
      }
      out.push(view);
    }
    vaults.value = out;
    const available = new Set(out.map((v) => v.id));
    for (const [id, key] of vaultKeys) {
      if (!available.has(id.split(':')[0]!)) {
        key.fill(0);
        vaultKeys.delete(id);
      }
    }
    if (currentSpaceId.value && !spaces.value.some((s) => s.id === currentSpaceId.value))
      currentSpaceId.value = null;
    if (!currentSpaceId.value && !currentId.value) {
      // Организация по умолчанию; если в ней для пользователя нет сейфов, а личный сейф есть — открываем личное пространство
      const home = spaces.value.find((s) => s.isDefault) ?? spaces.value[0];
      const homeHasVaults = !!home && out.some((v) => v.spaceId === home.id);
      currentSpaceId.value =
        home && (homeHasVaults || !out.some((v) => v.kind === 'locker')) ? home.id : null;
    }
    if (!currentId.value || !out.some((v) => v.id === currentId.value)) {
      currentId.value = spaceVaults.value[0]?.id ?? null;
    }
    if (current.value) currentSpaceId.value = current.value.spaceId ?? null;
    void distributeAllPending();
  }

  async function select(id: string): Promise<void> {
    currentSpaceId.value = vaults.value.find((v) => v.id === id)?.spaceId ?? null;
    currentId.value = id;
    await loadTree();
  }

  async function selectSpace(id: string | null): Promise<void> {
    currentSpaceId.value = id;
    currentId.value = spaceVaults.value[0]?.id ?? null;
    await loadTree();
  }

  // ------------------------------------------------------------------ дерево

  async function decryptEntryRecord(vaultId: string, r: EntryRecord): Promise<EntryItem | null> {
    const key = keyOf(vaultId, r.keyVersion);
    if (!key) return null;
    try {
      const data = normalizeEntry(await decryptEntry(r, key, vaultId, r.id));
      return {
        id: r.id,
        vaultId,
        branchId: r.branchId,
        version: r.version,
        keyVersion: r.keyVersion,
        access: r.access,
        pinned: r.pinned,
        deletedAt: r.deletedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        data,
      };
    } catch {
      return null; // запись повреждена или подменена
    }
  }

  // испорченное оформление не мешает показать папку: остаётся значок по умолчанию
  async function branchIcon(vaultId: string, b: BranchRecord, key: Uint8Array) {
    try {
      return cleanIcon(
        JSON.parse(await decryptBranchMeta(b.metaCipher!, key, vaultId, b.id, b.keyVersion)),
      );
    } catch {
      return undefined;
    }
  }

  async function decryptBranchRecord(vaultId: string, b: BranchRecord): Promise<BranchItem | null> {
    const key = keyOf(vaultId, b.keyVersion);
    if (!key) return null;
    try {
      return {
        id: b.id,
        parentId: b.parentId,
        name: await decryptBranchName(b.nameCipher, key, vaultId, b.id, b.keyVersion),
        version: b.version,
        access: b.access,
        deletedAt: b.deletedAt,
        icon: b.metaCipher ? await branchIcon(vaultId, b, key) : undefined,
      };
    } catch {
      return null;
    }
  }

  async function fetchTree(vaultId: string, inTrash: boolean) {
    const t = await api<{ branches: BranchRecord[]; entries: EntryRecord[] }>(
      'GET',
      `/vaults/${vaultId}/tree${inTrash ? '?trash=1' : ''}`,
    );
    const [bs, es] = await Promise.all([
      Promise.all(t.branches.map((b) => decryptBranchRecord(vaultId, b))),
      Promise.all(t.entries.map((e) => decryptEntryRecord(vaultId, e))),
    ]);
    return {
      branches: bs.filter((x): x is BranchItem => !!x),
      entries: es.filter((x): x is EntryItem => !!x),
      skipped: bs.filter((x) => !x).length + es.filter((x) => !x).length,
    };
  }

  async function loadTree(): Promise<void> {
    const v = current.value;
    if (!v || !v.unlocked) {
      branches.value = [];
      entries.value = [];
      trash.value = { branches: [], entries: [] };
      return;
    }
    loading.value = true;
    try {
      const [live, bin] = await Promise.all([fetchTree(v.id, false), fetchTree(v.id, true)]);
      if (currentId.value !== v.id || !useAuthStore().unlocked) return;
      branches.value = live.branches;
      entries.value = live.entries;
      trash.value = { branches: bin.branches, entries: bin.entries };
      skipped.value = live.skipped + bin.skipped;
    } finally {
      loading.value = false;
    }
  }

  async function searchEverywhere(query: string) {
    const q = query.trim().toLowerCase().slice(0, 500);
    const userId = useAuthStore().user?.id;
    const matches: {
      id: string;
      vaultId: string;
      vaultName: string | null;
      title: string;
      username: string;
      path: string;
    }[] = [];
    let unavailable = 0;
    for (const vault of vaults.value) {
      if (!vault.unlocked) {
        unavailable++;
        continue;
      }
      try {
        const tree = await fetchTree(vault.id, false);
        if (!useAuthStore().unlocked || useAuthStore().user?.id !== userId)
          return { matches: [], unavailable: 0 };
        const branches = new Map(tree.branches.map((b) => [b.id, b]));
        for (const entry of tree.entries) {
          if (entry.data.archived) continue;
          const path: string[] = [];
          const seen = new Set<string>();
          let branchId = entry.branchId;
          while (branchId && !seen.has(branchId)) {
            seen.add(branchId);
            const branch = branches.get(branchId);
            if (!branch) break;
            path.unshift(branch.name);
            branchId = branch.parentId;
          }
          if (searchText(entry.data).includes(q) || path.join(' / ').toLowerCase().includes(q))
            matches.push({
              id: entry.id,
              vaultId: vault.id,
              vaultName: vault.name,
              title: entry.data.title,
              username: entry.data.username,
              path: path.join(' / '),
            });
        }
      } catch {
        unavailable++;
      }
    }
    return { matches: matches.sort((a, b) => a.title.localeCompare(b.title)), unavailable };
  }

  // ------------------------------------------------------------------ записи

  function needKey(): { vault: VaultView; key: Uint8Array } {
    const v = current.value;
    const key = v ? keyOf(v.id, v.keyVersion) : undefined;
    if (!v || !key) throw new Error('vault is locked');
    return { vault: v, key };
  }

  async function saveEntry(
    data: EntryData,
    existing?: EntryItem,
    branchId?: string | null,
  ): Promise<EntryItem> {
    const { vault, key } = needKey();
    await enforceEntryPolicy(
      data,
      vault.id,
      branchId === undefined ? (existing?.branchId ?? null) : branchId,
      existing?.id,
    );
    const id = existing?.id ?? crypto.randomUUID();
    const clean: EntryData = {
      ...data,
      title: data.title.trim(),
      tags: [...new Set(data.tags.map((t) => t.trim()).filter(Boolean))],
    };
    if (existing && existing.data.password !== clean.password)
      clean.passwordChangedAt = new Date().toISOString();
    if (!existing && clean.password) clean.passwordChangedAt = new Date().toISOString();
    const enc = await encryptEntry(clean, key, vault.id, id, vault.keyVersion);
    const rec = existing
      ? await api<EntryRecord>('PUT', `/vaults/${vault.id}/entries/${id}`, {
          ...enc,
          branchId: branchId === undefined ? existing.branchId : branchId,
          expectedVersion: existing.version,
        })
      : await api<EntryRecord>('POST', `/vaults/${vault.id}/entries`, {
          id,
          branchId: branchId ?? null,
          ...enc,
        });
    const item = (await decryptEntryRecord(vault.id, rec))!;
    entries.value = existing
      ? entries.value.map((e) => (e.id === id ? item : e))
      : [...entries.value, item];
    return item;
  }

  async function enforceEntryPolicy(
    data: EntryData,
    vaultId: string,
    branchId: string | null,
    entryId?: string,
  ): Promise<void> {
    if (!data.password || data.kind === 'note') return;
    const parent = `/vaults/${vaultId}${branchId ? `/branches/${branchId}` : ''}/policy`;
    const { effective } = await api<{ effective: PasswordPolicy }>(
      'GET',
      entryId ? `/vaults/${vaultId}/entries/${entryId}/policy` : parent,
    );
    if (entryId) {
      const destination = await api<{ effective: PasswordPolicy }>('GET', parent);
      effective.minLength = Math.max(effective.minLength, destination.effective.minLength);
      effective.classes = Math.max(effective.classes, destination.effective.classes);
    }
    const violations = checkPolicy(data.password, effective);
    if (violations.length)
      throw new ApiError(400, 'password_policy', 'Password does not meet the effective policy', {
        ...effective,
        violations,
      });
  }

  async function trashEntry(item: EntryItem): Promise<void> {
    await api(
      'DELETE',
      `/vaults/${item.vaultId}/entries/${item.id}?expectedVersion=${item.version}`,
    );
    await loadTree();
  }

  async function restoreEntry(item: EntryItem): Promise<void> {
    await api('POST', `/vaults/${item.vaultId}/entries/${item.id}/restore`);
    await loadTree();
  }

  async function purgeEntry(item: EntryItem): Promise<void> {
    await api('DELETE', `/vaults/${item.vaultId}/entries/${item.id}?purge=1`);
    await loadTree();
  }

  /**
   * Перенос записи в другой сейф. Запись перешифровывается ключом целевого сейфа (шифртекст привязан к сейфу
   * и идентификатору), создаётся в целевом сейфе, исходная отправляется в корзину. Права проверяет сервер:
   * создание в целевом сейфе требует права редактирования, удаление исходной записи — тоже.
   * Вложения копируются: каждый файл расшифровывается ключом исходного сейфа и шифруется ключом целевого. Если любой шаг
   * не удался, непроверенная копия удаляется, исходная запись остаётся на месте. Проверенная копия сохраняется при
   * неопределённом результате удаления источника. История изменений остаётся в
   * исходном сейфе (в корзине); переносятся текущие данные записи.
   */
  async function moveEntryRaw(
    item: EntryItem,
    targetVaultId: string,
    targetBranchId: string | null = null,
  ): Promise<void> {
    if (targetVaultId === item.vaultId) throw new Error('same_vault');
    const target = vaults.value.find((v) => v.id === targetVaultId);
    if (!target) throw new Error('vault is not available');
    const targetKey = keyOf(target.id, target.keyVersion);
    if (!targetKey) throw new Error('target vault is locked');
    await enforceEntryPolicy(item.data, target.id, targetBranchId);
    const files = await attachmentList(item);
    const id = crypto.randomUUID();
    const enc = await encryptEntry(item.data, targetKey, target.id, id, target.keyVersion);
    let created: EntryRecord | null = null;
    try {
      created = await api<EntryRecord>('POST', `/vaults/${target.id}/entries`, {
        id,
        branchId: targetBranchId,
        ...enc,
      });
      const copy = await decryptEntryRecord(target.id, created);
      if (!copy || JSON.stringify(copy.data) !== JSON.stringify(normalizeEntry(item.data)))
        throw new ApiError(
          409,
          'move_verification_failed',
          'The copied entry could not be verified',
        );
      if (files.length) {
        const copiedIds: string[] = [];
        for (const f of files) {
          if (f.problem)
            throw new ApiError(
              409,
              'move_verification_failed',
              'Source attachment metadata could not be verified',
            );
          // файл расшифровывается ключом исходного сейфа и тут же шифруется ключом целевого
          const chunks: Uint8Array[] = [];
          await attachmentDownload_(item, f.id, {
            write: async (c) => {
              chunks.push(c);
            },
          });
          const file = new File(chunks as BlobPart[], f.name, { type: f.type });
          if (file.size !== f.size)
            throw new ApiError(
              409,
              'move_verification_failed',
              'Source attachment size did not match',
            );
          const attachmentId = await attachmentAdd_(copy, file);
          copiedIds.push(attachmentId);
          let verified = 0;
          await attachmentDownload_(copy, attachmentId, {
            write: async (chunk) => {
              const expected = new Uint8Array(
                await file.slice(verified, verified + chunk.length).arrayBuffer(),
              );
              if (
                expected.length !== chunk.length ||
                !chunk.every((byte, index) => byte === expected[index])
              )
                throw new ApiError(
                  409,
                  'move_verification_failed',
                  'The copied attachment did not match',
                );
              verified += chunk.length;
            },
          });
          if (verified !== file.size)
            throw new ApiError(
              409,
              'move_verification_failed',
              'The copied attachment was incomplete',
            );
        }
        const storedFiles = await attachmentList(copy);
        if (
          storedFiles.length !== files.length ||
          files.some((file, index) => {
            const stored = storedFiles.find((row) => row.id === copiedIds[index]);
            return (
              !stored ||
              stored.problem ||
              stored.name !== file.name ||
              stored.type !== file.type ||
              stored.size !== file.size
            );
          })
        )
          throw new ApiError(
            409,
            'move_verification_failed',
            'The copied attachment metadata did not match',
          );
      }
      const stored = await api<EntryRecord>('GET', `/vaults/${target.id}/entries/${id}`);
      const verified = await decryptEntryRecord(target.id, stored);
      if (
        !verified ||
        verified.deletedAt ||
        verified.branchId !== targetBranchId ||
        JSON.stringify(verified.data) !== JSON.stringify(normalizeEntry(item.data))
      )
        throw new ApiError(
          409,
          'move_verification_failed',
          'The stored target entry could not be verified',
        );
    } catch (e) {
      try {
        await api(
          'DELETE',
          `/vaults/${target.id}/entries/${id}?expectedVersion=${created?.version ?? 1}`,
        );
        await api('DELETE', `/vaults/${target.id}/entries/${id}?purge=1`);
      } catch (cleanupError) {
        if (!(cleanupError instanceof ApiError && cleanupError.status === 404))
          throw new ApiError(
            409,
            'move_cleanup_failed',
            'The original entry is preserved; the incomplete target could not be removed',
            { targetVaultId: target.id, targetEntryId: id },
          );
      }
      throw e;
    }
    try {
      await api(
        'DELETE',
        `/vaults/${item.vaultId}/entries/${item.id}?expectedVersion=${item.version}`,
      );
    } catch {
      // Ответ мог потеряться после удаления: проверенную целевую копию сохраняем в любом случае.
      throw new ApiError(
        409,
        'move_source_failed',
        'The verified target is preserved; the source deletion could not be confirmed',
        { targetVaultId: target.id, targetEntryId: id },
      );
    }
    await loadTree();
  }

  async function bulk(
    ids: string[],
    action: 'move' | 'trash' | 'restore' | 'purge',
    branchId?: string | null,
  ): Promise<void> {
    const v = current.value!;
    await api('POST', `/vaults/${v.id}/entries/bulk`, { ids, action, branchId });
    await loadTree();
  }

  async function setPinned(item: EntryItem, pinned: boolean): Promise<void> {
    await api(pinned ? 'PUT' : 'DELETE', `/vaults/${item.vaultId}/entries/${item.id}/pin`);
    const upd = { ...item, pinned };
    entries.value = entries.value.map((e) => (e.id === item.id ? upd : e));
  }

  async function revisions(
    item: EntryItem,
  ): Promise<{ rev: RevisionRecord; data: EntryData | null }[]> {
    const list = await api<RevisionRecord[]>(
      'GET',
      `/vaults/${item.vaultId}/entries/${item.id}/revisions`,
    );
    const out: { rev: RevisionRecord; data: EntryData | null }[] = [];
    for (const rev of list) {
      const key = keyOf(item.vaultId, rev.keyVersion);
      let data: EntryData | null = null;
      if (key)
        data = await decryptEntry(rev, key, item.vaultId, item.id)
          .then(normalizeEntry)
          .catch(() => null);
      out.push({ rev, data });
    }
    return out;
  }

  async function restoreRevision(item: EntryItem, revisionId: string): Promise<void> {
    await api(
      'POST',
      `/vaults/${item.vaultId}/entries/${item.id}/revisions/${revisionId}/restore`,
      {
        expectedVersion: item.version,
      },
    );
    await loadTree();
  }

  // ------------------------------------------------------------------ ветви

  async function createBranch(name: string, parentId: string | null): Promise<void> {
    const { vault, key } = needKey();
    const id = crypto.randomUUID();
    await api('POST', `/vaults/${vault.id}/branches`, {
      id,
      parentId,
      nameCipher: await encryptBranchName(name.trim(), key, vault.id, id, vault.keyVersion),
      keyVersion: vault.keyVersion,
    });
    await loadTree();
  }

  async function createBranchWithId(
    id: string,
    name: string,
    parentId: string | null,
    icon?: ObjectIcon,
  ): Promise<void> {
    const { vault, key } = needKey();
    await api('POST', `/vaults/${vault.id}/branches`, {
      id,
      parentId,
      nameCipher: await encryptBranchName(name.trim(), key, vault.id, id, vault.keyVersion),
      ...(icon
        ? {
            metaCipher: await encryptBranchMeta(
              JSON.stringify(icon),
              key,
              vault.id,
              id,
              vault.keyVersion,
            ),
          }
        : {}),
      keyVersion: vault.keyVersion,
    });
  }

  /** Событие, происходящее на клиенте (например, экспорт), для журнала действий. */
  async function audit(action: 'export', format: string, count: number): Promise<void> {
    await api('POST', '/audit/event', { action, format, count });
  }

  async function renameBranch(b: BranchItem, name: string): Promise<void> {
    const { vault, key } = needKey();
    await api('PATCH', `/vaults/${vault.id}/branches/${b.id}`, {
      nameCipher: await encryptBranchName(name.trim(), key, vault.id, b.id, vault.keyVersion),
      keyVersion: vault.keyVersion,
    });
    await loadTree();
  }

  /** Значок папки: шифруется ключом сейфа вместе с названием; undefined — значок по умолчанию. */
  async function setBranchIcon(b: BranchItem, icon: ObjectIcon | undefined): Promise<void> {
    const { vault, key } = needKey();
    await api('PATCH', `/vaults/${vault.id}/branches/${b.id}`, {
      nameCipher: await encryptBranchName(b.name, key, vault.id, b.id, vault.keyVersion),
      metaCipher: icon
        ? await encryptBranchMeta(JSON.stringify(icon), key, vault.id, b.id, vault.keyVersion)
        : null,
      keyVersion: vault.keyVersion,
    });
    await loadTree();
  }

  async function moveBranch(b: BranchItem, parentId: string | null): Promise<void> {
    await api('PATCH', `/vaults/${current.value!.id}/branches/${b.id}`, { parentId });
    await loadTree();
  }

  async function deleteBranch(b: BranchItem, purge = false): Promise<void> {
    await api('DELETE', `/vaults/${current.value!.id}/branches/${b.id}${purge ? '?purge=1' : ''}`);
    await loadTree();
  }

  async function restoreBranch(b: BranchItem): Promise<void> {
    await api('POST', `/vaults/${current.value!.id}/branches/${b.id}/restore`);
    await loadTree();
  }

  // ------------------------------------------------------------------ общие хранилища и участники

  async function createVault(name: string): Promise<string> {
    const auth = useAuthStore();
    const { publicKey, signPrivateKey } = auth.keys();
    const id = crypto.randomUUID();
    const key = createVaultKey();
    const sealedKey = await sealVaultKeyFor(key, publicKey, id, auth.user!.id, 1);
    await api('POST', '/vaults', {
      id,
      spaceId: currentSpaceId.value ?? undefined,
      name,
      sealedKey,
      signature: await signKeyGrant(signPrivateKey, id, auth.user!.id, 1, sealedKey),
    });
    key.fill(0);
    await loadVaults();
    await select(id);
    return id;
  }

  const members = async (vaultId: string) =>
    api<{
      keyVersion: number;
      members: MemberInfo[];
      circles: { id: string; name: string; role: string }[];
    }>('GET', `/vaults/${vaultId}/members`);

  /** Выдача ключа участнику: проверка пары ключей по журналу, запечатывание и подпись администратором. */
  async function keyGrantFor(
    vaultId: string,
    user: { userId: string; publicKey: string; signPublicKey: string },
    version: number,
    vaultKey: Uint8Array,
  ) {
    const auth = useAuthStore();
    const logged = keyLog.find((e) => e.userId === user.userId);
    if (
      !logged ||
      logged.encPublic !== user.publicKey ||
      logged.signPublic !== user.signPublicKey
    ) {
      throw new Error('public key does not match the key log');
    }
    const sealedKey = await sealVaultKeyFor(
      vaultKey,
      fromBase64Url(user.publicKey),
      vaultId,
      user.userId,
      version,
    );
    return {
      keyVersion: version,
      sealedKey,
      signature: await signKeyGrant(
        auth.keys().signPrivateKey,
        vaultId,
        user.userId,
        version,
        sealedKey,
      ),
    };
  }

  async function addMember(
    vaultId: string,
    user: { id: string; publicKey: string; signPublicKey: string },
    role: string | object,
  ): Promise<void> {
    const v = vaults.value.find((x) => x.id === vaultId)!;
    const key = keyOf(vaultId, v.keyVersion)!;
    if (!keyLog.length) await loadKeyLog();
    const grant = await keyGrantFor(
      vaultId,
      { userId: user.id, publicKey: user.publicKey, signPublicKey: user.signPublicKey },
      v.keyVersion,
      key,
    );
    const roleBody = typeof role === 'string' ? { role } : role;
    await api('PUT', `/vaults/${vaultId}/members/${user.id}`, { ...roleBody, key: grant });
  }

  /**
   * Выдача ключей ожидающим участникам выполняется клиентом администратора, у которого открыт ключ сейфа.
   * Сотрудникам ничего делать не нужно: после загрузки сейфов ключи выдаются сами, ошибки не мешают работе.
   */
  async function distributeAllPending(): Promise<void> {
    for (const v of vaults.value) {
      // право выдавать ключи определяет сервер (полномочие управлять участниками), а не название роли
      if (!v.unlocked || !v.canManageMembers) continue;
      try {
        await distributePending(v.id);
      } catch {
        /* повторится при следующей загрузке сейфов */
      }
    }
  }

  /** Выдать ключи тем, у кого есть доступ (через круг или грант), но нет ключа. */
  async function distributePending(vaultId: string): Promise<number> {
    const v = vaults.value.find((x) => x.id === vaultId)!;
    const key = keyOf(vaultId, v.keyVersion)!;
    if (!keyLog.length) await loadKeyLog();
    const pending = await api<{
      users: { userId: string; publicKey: string; signPublicKey: string }[];
    }>('GET', `/vaults/${vaultId}/pending-keys`);
    if (!pending.users.length) return 0;
    const keys = [];
    for (const u of pending.users)
      keys.push({ userId: u.userId, ...(await keyGrantFor(vaultId, u, v.keyVersion, key)) });
    await api('POST', `/vaults/${vaultId}/keys`, { keys });
    return keys.length;
  }

  /**
   * Ротация ключа хранилища: новый ключ, перешифрование ключей записей, ревизий и названий ветвей, выдача оставшимся.
   * После отзыва доступа это единственный способ закрыть дальнейший доступ по ранее полученному ключу.
   */
  async function rotateRaw(vaultId: string): Promise<void> {
    const rotationId = crypto.randomUUID();
    const v = vaults.value.find((x) => x.id === vaultId)!;
    const oldKey = keyOf(vaultId, v.keyVersion)!;
    const newVersion = v.keyVersion + 1;
    const newKey = createVaultKey();
    try {
      if (!keyLog.length) await loadKeyLog();
      if (!keyLogOk.value) throw new Error('key log verification failed');
      const recovery =
        v.kind === 'shared'
          ? await api<{ recipient: RecoveryRecipient | null; enrolled: boolean }>(
              'GET',
              `/vaults/${vaultId}/recovery`,
            )
          : null;
      if (recovery?.enrolled && !recovery.recipient)
        throw new Error('corporate recovery recipient is missing');
      const recoveryKey =
        recovery?.enrolled && recovery.recipient
          ? await recoveryGrant(vaultId, newVersion, newKey, recovery.recipient)
          : undefined;

      const [live, bin] = await Promise.all([
        api<{ branches: BranchRecord[]; entries: EntryRecord[] }>('GET', `/vaults/${vaultId}/tree`),
        api<{ branches: BranchRecord[]; entries: EntryRecord[] }>(
          'GET',
          `/vaults/${vaultId}/tree?trash=1`,
        ),
      ]);
      const allEntries = [...live.entries, ...bin.entries];
      const allBranches = [...live.branches, ...bin.branches];
      const entryOut = [];
      const revOut = [];
      for (const e of allEntries) {
        const re = await rewrapEntry(e, oldKey, newKey, vaultId, e.id, newVersion);
        entryOut.push({
          id: e.id,
          expectedVersion: e.version,
          wrappedEntryKey: re.wrappedEntryKey,
          ciphertext: re.ciphertext,
        });
        for (const r of await api<RevisionRecord[]>(
          'GET',
          `/vaults/${vaultId}/entries/${e.id}/revisions`,
        )) {
          const rr = await rewrapEntry(r, oldKey, newKey, vaultId, e.id, newVersion);
          revOut.push({ id: r.id, wrappedEntryKey: rr.wrappedEntryKey, ciphertext: rr.ciphertext });
        }
      }
      const branchOut = [];
      for (const b of allBranches) {
        branchOut.push({
          id: b.id,
          expectedVersion: b.version,
          nameCipher: await rewrapBranchName(
            b.nameCipher,
            oldKey,
            newKey,
            vaultId,
            b.id,
            b.keyVersion,
            newVersion,
          ),
          // оформление перешифровывается вместе с названием: иначе после ротации значок пропал бы
          metaCipher: b.metaCipher
            ? await rewrapBranchMeta(
                b.metaCipher,
                oldKey,
                newKey,
                vaultId,
                b.id,
                b.keyVersion,
                newVersion,
              )
            : null,
        });
      }
      // Вложения: файлы перешифровываются новыми ключами и загружаются заранее; метаданные уходят в запрос ротации
      const attOut = [];
      for (const att of await api<AttachmentRecord[]>('GET', `/vaults/${vaultId}/attachments`)) {
        // Файл перешифровывается потоком: старые кадры читаются порциями, новые уходят по мере готовности
        const oldAk = await openAttachmentKey(oldKey, vaultId, att);
        const meta = await openAttachmentMeta(oldKey, vaultId, att);
        const fresh = await beginAttachment(newKey, vaultId, newVersion, meta, att.id);
        try {
          const base = `/vaults/${vaultId}/attachments/${att.id}`;
          const re = new AttachmentReencryptor(oldAk, fresh.ak, att.id);
          const res = await apiStream(`${base}/content`);
          const reader = res.body!.getReader();
          let off = 0;
          const send = async (frames: Uint8Array[]) => {
            for (const f of frames)
              off = await putPart(
                `${base}/parts?rotation=1&rotationId=${rotationId}&offset=${off}`,
                f,
              );
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await send(await re.push(value));
          }
          await send(await re.finish());
          await api('POST', `${base}/complete?rotation=1&rotationId=${rotationId}`);
        } finally {
          oldAk.fill(0);
          fresh.ak.fill(0);
        }
        attOut.push({ id: att.id, wrappedKey: fresh.wrappedKey, metaCipher: fresh.metaCipher });
      }
      const m = await members(vaultId);
      const holders = m.members.filter((u) => u.spaceAllowed !== false);
      const keys = [];
      for (const u of holders)
        keys.push({ userId: u.userId, ...(await keyGrantFor(vaultId, u, newVersion, newKey)) });
      await api('POST', `/vaults/${vaultId}/rotate`, {
        newKeyVersion: newVersion,
        rotationId,
        keys: keys.map(({ userId, sealedKey, signature }) => ({ userId, sealedKey, signature })),
        entries: entryOut,
        revisions: revOut,
        branches: branchOut,
        attachments: attOut,
        ...(recoveryKey ? { recoveryKey } : {}),
      });
      await loadVaults();
      await loadTree();
    } finally {
      newKey.fill(0);
    }
  }

  // ------------------------------------------------------------------ вложения

  interface AttachmentItem {
    id: string;
    name: string;
    type: string;
    size: number;
    encryptedSize: number;
    createdAt: string;
    problem?: boolean;
  }

  /** Длинные операции с ключами не прерываются автоблокировкой (иначе ключи стёрлись бы посреди передачи или ротации). */
  async function held<T>(fn: () => Promise<T>): Promise<T> {
    const release = useAuthStore().hold();
    try {
      return await fn();
    } finally {
      release();
    }
  }
  const rotate = (...a: Parameters<typeof rotateRaw>) => held(() => rotateRaw(...a));
  const moveEntry = (...a: Parameters<typeof moveEntryRaw>) => held(() => moveEntryRaw(...a));
  const attachmentAdd = (...a: Parameters<typeof attachmentAdd_>) =>
    held(() => attachmentAdd_(...a));
  const attachmentDownload = (...a: Parameters<typeof attachmentDownload_>) =>
    held(() => attachmentDownload_(...a));

  async function attachmentList(item: EntryItem): Promise<AttachmentItem[]> {
    const key = keyOf(item.vaultId, item.keyVersion);
    if (!key) return [];
    const rows = await api<AttachmentRecord[]>(
      'GET',
      `/vaults/${item.vaultId}/entries/${item.id}/attachments`,
    );
    const out: AttachmentItem[] = [];
    for (const r of rows) {
      try {
        const m = await openAttachmentMeta(
          keyOf(item.vaultId, r.keyVersion) ?? key,
          item.vaultId,
          r,
        );
        out.push({ id: r.id, ...m, encryptedSize: r.size, createdAt: r.createdAt });
      } catch {
        out.push({
          id: r.id,
          name: '?',
          type: '',
          size: 0,
          encryptedSize: r.size,
          createdAt: r.createdAt,
          problem: true,
        });
      }
    }
    return out;
  }

  /** Отправка одной части; при сетевом сбое повтор с уточнением принятого смещения у сервера. */
  async function putPart(path: string, frame: Uint8Array): Promise<number> {
    const url = new URL(path, 'http://x');
    const base = url.pathname;
    const rotation =
      url.searchParams.get('rotation') === '1'
        ? `&rotation=1&rotationId=${encodeURIComponent(url.searchParams.get('rotationId') ?? '')}`
        : '';
    let offset = Number(url.searchParams.get('offset'));
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await apiBinary('PUT', `${base}?offset=${offset}${rotation}`, frame);
        return (JSON.parse(new TextDecoder().decode(out)) as { received: number }).received;
      } catch (e) {
        if (attempt >= 4 || !(e instanceof ApiError) || (e.status !== 0 && e.status < 500)) throw e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        const p = await api<{ received: number }>(
          'GET',
          `${base.replace('/parts', '/progress')}?${rotation.slice(1)}`,
        );
        if (p.received === offset + frame.length) return p.received; // часть успела дойти
        offset = p.received;
      }
    }
  }

  /**
   * Шифрует файл в браузере по кускам (по 1 МиБ) и загружает частями: в памяти одновременно только один кусок,
   * размер файла ограничен лишь квотой. Сервер получает только шифртекст.
   */
  async function attachmentAdd_(
    item: EntryItem,
    file: File,
    onProgress?: (done: number, total: number) => void,
  ): Promise<string> {
    const v = vaults.value.find((x) => x.id === item.vaultId)!;
    const key = keyOf(item.vaultId, v.keyVersion);
    if (!key) throw new Error('vault is locked');
    const head = await beginAttachment(key, item.vaultId, v.keyVersion, {
      name: file.name,
      type: file.type,
      size: file.size,
    });
    const total = encryptedSize(file.size);
    const base = `/vaults/${item.vaultId}/attachments/${head.id}`;
    try {
      await api('POST', `/vaults/${item.vaultId}/entries/${item.id}/attachments`, {
        id: head.id,
        wrappedKey: head.wrappedKey,
        metaCipher: head.metaCipher,
        keyVersion: v.keyVersion,
        size: total,
      });
      let off = 0;
      for await (const frame of encryptStream(
        head.ak,
        head.id,
        file.size,
        async (s, e) => new Uint8Array(await file.slice(s, e).arrayBuffer()),
      )) {
        off = await putPart(`${base}/parts?offset=${off}`, frame);
        onProgress?.(off, total);
      }
      await api('POST', `${base}/complete`);
      return head.id;
    } catch (e) {
      // незавершённая загрузка не оставляет ни записи, ни файла
      await api('DELETE', base).catch(() => undefined);
      throw e;
    } finally {
      head.ak.fill(0);
    }
  }

  /** Расшифровывает вложение потоком: каждый кусок сразу уходит в приёмник (файл на диске или потоковая загрузка). */
  async function attachmentDownload_(
    item: EntryItem,
    id: string,
    sink: { write: (chunk: Uint8Array) => Promise<void> },
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const rows = await api<AttachmentRecord[]>(
      'GET',
      `/vaults/${item.vaultId}/entries/${item.id}/attachments`,
    );
    const rec = rows.find((r) => r.id === id);
    const vk = rec && keyOf(item.vaultId, rec.keyVersion);
    if (!rec || !vk) throw new Error('attachment is not available');
    const ak = await openAttachmentKey(vk, item.vaultId, rec);
    try {
      const dec = new AttachmentDecryptor(ak, id);
      const res = await apiStream(`/vaults/${item.vaultId}/attachments/${id}/content`);
      const reader = res.body!.getReader();
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        for (const p of await dec.push(value)) await sink.write(p);
        onProgress?.(got, rec.size);
      }
      for (const p of await dec.finish()) await sink.write(p);
    } finally {
      ak.fill(0);
    }
  }

  async function attachmentRemove(item: EntryItem, id: string): Promise<void> {
    await api('DELETE', `/vaults/${item.vaultId}/attachments/${id}`);
  }

  // ------------------------------------------------------------------ ссылки передачи

  async function createLink(
    item: EntryItem,
    opts: {
      passphrase?: string;
      expiresInMinutes: number;
      maxViews: number;
      includeNotes: boolean;
    },
  ): Promise<string> {
    const id = crypto.randomUUID();
    const d = item.data;
    const payload = {
      title: d.title,
      username: d.username,
      password: d.password,
      url: d.url,
      notes: opts.includeNotes ? d.notes : '',
      fields: d.fields.filter((f) => f.value),
    };
    const pkg = await createHandoff(id, payload, opts.passphrase || undefined);
    await api('POST', '/handoffs', {
      id,
      label: d.title.slice(0, 100),
      ciphertext: pkg.ciphertext,
      hasPassphrase: !!opts.passphrase,
      expiresInMinutes: opts.expiresInMinutes,
      maxViews: opts.maxViews,
    });
    return `${location.origin}/h/${id}#${pkg.fragment}`;
  }

  async function recoveryGrant(
    vaultId: string,
    keyVersion: number,
    key: Uint8Array,
    recipient: RecoveryRecipient,
  ) {
    const sealedKey = await sealVaultKeyFor(
      key,
      fromBase64Url(recipient.publicKey),
      vaultId,
      recipient.id,
      keyVersion,
    );
    return {
      recipientId: recipient.id,
      keyVersion,
      sealedKey,
      signature: await signKeyGrant(
        useAuthStore().keys().signPrivateKey,
        vaultId,
        recipient.id,
        keyVersion,
        sealedKey,
      ),
    };
  }

  /** Закрытое уведомление не появляется снова ни после F5, ни на другом устройстве. */
  async function dismissNotice(id: string): Promise<void> {
    if (!dismissedNotices.value.includes(id))
      dismissedNotices.value = [...dismissedNotices.value, id];
    await api('POST', `/auth/notices/${id}/dismiss`).catch(() => undefined);
  }

  async function enrollCorporateRecovery(
    vaultId: string,
    recipient: RecoveryRecipient,
    pending = false,
  ): Promise<void> {
    return held(async () => {
      const vault = vaults.value.find((v) => v.id === vaultId);
      const key = vault && keyOf(vaultId, vault.keyVersion);
      if (!vault || vault.kind !== 'shared' || !vault.canManageMembers || !key)
        throw new Error('vault is not available for recovery enrollment');
      await loadKeyLog();
      if (!keyLogOk.value) throw new Error('key log verification failed');
      // получатель сверяется с тем, что сейчас отдаёт сервер: подмена получателя между показом отпечатка и подключением отвергается
      const configured = pending
        ? {
            recipient: (
              await api<{ pending: RecoveryRecipient | null }>('GET', `/vaults/${vaultId}/recovery`)
            ).pending,
          }
        : await api<{ recipient: RecoveryRecipient | null }>('GET', '/corporate-recovery');
      if (
        !configured.recipient ||
        configured.recipient.id !== recipient.id ||
        configured.recipient.publicKey !== recipient.publicKey ||
        configured.recipient.signPublicKey !== recipient.signPublicKey
      )
        throw new Error('corporate recovery recipient changed');
      await api(
        'POST',
        `/vaults/${vaultId}/recovery`,
        await recoveryGrant(vaultId, vault.keyVersion, key, recipient),
      );
    });
  }

  async function recoverCorporateVault(vaultId: string, recovery: RecoverySecrets): Promise<void> {
    return held(async () => {
      const auth = useAuthStore();
      const account = auth.keys();
      await loadKeyLog();
      if (!keyLogOk.value) throw new Error('key log verification failed');
      const challenge = await api<{
        challengeId: string;
        encryptedNonce: string;
        message: string;
        recipient: RecoveryRecipient;
        rescue: {
          keyVersion: number;
          recipientId: string;
          sealedKey: string;
          signature: string;
          grantedBy: string;
          grantedBySignKey: string;
        };
        target: { userId: string; publicKey: string; signPublicKey: string };
      }>('POST', `/admin/corporate-recovery/${vaultId}/challenge`, {});
      const { recipient, rescue, target } = challenge;
      if (
        recipient.id !== recovery.id ||
        recipient.publicKey !== recovery.publicKey ||
        recipient.signPublicKey !== recovery.signPublicKey ||
        rescue.recipientId !== recovery.id ||
        target.userId !== auth.user!.id ||
        target.publicKey !== toBase64Url(account.publicKey) ||
        target.signPublicKey !== toBase64Url(account.signPublicKey)
      )
        throw new Error('recovery identity mismatch');
      const signer = signerKey(rescue.grantedBy);
      if (
        !signer ||
        signer !== rescue.grantedBySignKey ||
        !(await verifyKeyGrant(
          fromBase64Url(signer),
          rescue.signature,
          vaultId,
          recipient.id,
          rescue.keyVersion,
          rescue.sealedKey,
        ))
      )
        throw new Error('recovery key grant signature is invalid');
      const key = await openVaultKey(
        rescue.sealedKey,
        recovery.privateKey,
        fromBase64Url(recovery.publicKey),
        vaultId,
        recovery.id,
        rescue.keyVersion,
      );
      let nonceBytes: Uint8Array | null = null;
      try {
        nonceBytes = await openVaultKey(
          challenge.encryptedNonce,
          recovery.privateKey,
          fromBase64Url(recovery.publicKey),
          vaultId,
          recovery.id,
          rescue.keyVersion,
        );
        if (key.length !== 32 || nonceBytes.length !== 32) throw new Error('invalid recovered key');
        const nonce = toBase64Url(nonceBytes);
        const sealedKey = await sealVaultKeyFor(
          key,
          account.publicKey,
          vaultId,
          auth.user!.id,
          rescue.keyVersion,
        );
        const signature = await signKeyGrant(
          account.signPrivateKey,
          vaultId,
          auth.user!.id,
          rescue.keyVersion,
          sealedKey,
        );
        const proof = toBase64Url(
          await sign(
            recovery.signPrivateKey,
            utf8(ctx('corporate-recovery-recover', challenge.message, nonce, sealedKey, signature)),
          ),
        );
        await api('POST', `/admin/corporate-recovery/${vaultId}/recover`, {
          challengeId: challenge.challengeId,
          nonce,
          sealedKey,
          signature,
          proof,
        });
      } finally {
        key.fill(0);
        nonceBytes?.fill(0);
      }
      await loadVaults();
      if (currentId.value === vaultId) await loadTree();
    });
  }

  return {
    vaults,
    spaces,
    currentSpaceId,
    spaceVaults,
    current,
    currentId,
    searchQuery,
    personalAllowed,
    personalDataRestricted,
    personalEntries,
    dismissedNotices,
    dismissNotice,
    locker,
    branches,
    entries,
    trash,
    loading,
    skipped,
    keyLogOk,
    clear,
    loadVaults,
    select,
    selectSpace,
    loadTree,
    searchEverywhere,
    saveEntry,
    trashEntry,
    restoreEntry,
    purgeEntry,
    bulk,
    setPinned,
    revisions,
    restoreRevision,
    createBranch,
    createBranchWithId,
    audit,
    renameBranch,
    breaches,
    setBranchIcon,
    moveBranch,
    moveEntry,
    deleteBranch,
    restoreBranch,
    createVault,
    members,
    addMember,
    distributePending,
    rotate,
    attachmentList,
    attachmentAdd,
    attachmentDownload,
    attachmentRemove,
    createLink,
    enrollCorporateRecovery,
    recoverCorporateVault,
    blankEntry,
  };
});
