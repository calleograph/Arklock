import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import {
  createHandoff,
  createVaultKey,
  decryptBranchName,
  decryptEntry,
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
  rewrapBranchName,
  rewrapEntry,
  sealVaultKeyFor,
  signKeyGrant,
  verifyKeyGrant,
  verifyKeyLog,
} from '@arklock/crypto';
import type {
  AttachmentRecord,
  BranchRecord,
  EntryRecord,
  RevisionRecord,
  VaultInfo,
} from '@arklock/contracts';
import { api, ApiError, apiBinary, apiStream } from '../services/api';
import {
  blankEntry,
  normalizeEntry,
  type BranchItem,
  type EntryData,
  type EntryItem,
} from '../services/model';
import { useAuthStore } from './auth';

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
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const vaults = ref<VaultView[]>([]);
  const currentId = ref<string | null>(null);
  const branches = shallowRef<BranchItem[]>([]);
  const entries = shallowRef<EntryItem[]>([]);
  const trash = shallowRef<{ branches: BranchItem[]; entries: EntryItem[] }>({
    branches: [],
    entries: [],
  });
  const loading = ref(false);
  const skipped = ref(0);
  const keyLogOk = ref(true);
  let keyLog: KeyLogEntry[] = [];

  const current = computed(() => vaults.value.find((v) => v.id === currentId.value) ?? null);
  const locker = computed(() => vaults.value.find((v) => v.kind === 'locker') ?? null);

  function clear(): void {
    for (const k of vaultKeys.values()) k.fill(0);
    vaultKeys.clear();
    vaults.value = [];
    currentId.value = null;
    branches.value = [];
    entries.value = [];
    trash.value = { branches: [], entries: [] };
    keyLog = [];
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
    await loadKeyLog();
    const infos = await api<VaultInfo[]>('GET', '/vaults');
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
    if (!currentId.value || !out.some((v) => v.id === currentId.value)) {
      currentId.value = (out.find((v) => v.kind === 'locker') ?? out[0])?.id ?? null;
    }
  }

  async function select(id: string): Promise<void> {
    currentId.value = id;
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
      branches.value = live.branches;
      entries.value = live.entries;
      trash.value = { branches: bin.branches, entries: bin.entries };
      skipped.value = live.skipped + bin.skipped;
    } finally {
      loading.value = false;
    }
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
  ): Promise<void> {
    const { vault, key } = needKey();
    await api('POST', `/vaults/${vault.id}/branches`, {
      id,
      parentId,
      nameCipher: await encryptBranchName(name.trim(), key, vault.id, id, vault.keyVersion),
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
  async function rotate(vaultId: string): Promise<void> {
    const v = vaults.value.find((x) => x.id === vaultId)!;
    const oldKey = keyOf(vaultId, v.keyVersion)!;
    const newVersion = v.keyVersion + 1;
    const newKey = createVaultKey();
    if (!keyLog.length) await loadKeyLog();

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
      entryOut.push({ id: e.id, wrappedEntryKey: re.wrappedEntryKey, ciphertext: re.ciphertext });
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
        nameCipher: await rewrapBranchName(
          b.nameCipher,
          oldKey,
          newKey,
          vaultId,
          b.id,
          b.keyVersion,
          newVersion,
        ),
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
          for (const f of frames) off = await putPart(`${base}/parts?rotation=1&offset=${off}`, f);
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await send(await re.push(value));
        }
        await send(await re.finish());
        await api('POST', `${base}/complete?rotation=1`);
      } finally {
        oldAk.fill(0);
        fresh.ak.fill(0);
      }
      attOut.push({ id: att.id, wrappedKey: fresh.wrappedKey, metaCipher: fresh.metaCipher });
    }
    const m = await members(vaultId);
    const holders = m.members;
    const keys = [];
    for (const u of holders)
      keys.push({ userId: u.userId, ...(await keyGrantFor(vaultId, u, newVersion, newKey)) });
    await api('POST', `/vaults/${vaultId}/rotate`, {
      newKeyVersion: newVersion,
      keys: keys.map(({ userId, sealedKey, signature }) => ({ userId, sealedKey, signature })),
      entries: entryOut,
      revisions: revOut,
      branches: branchOut,
      attachments: attOut,
    });
    await loadVaults();
    await loadTree();
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
    const rotation = url.searchParams.get('rotation') === '1' ? '&rotation=1' : '';
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
  async function attachmentAdd(
    item: EntryItem,
    file: File,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
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
    } catch (e) {
      // незавершённая загрузка не оставляет ни записи, ни файла
      await api('DELETE', base).catch(() => undefined);
      throw e;
    } finally {
      head.ak.fill(0);
    }
  }

  /** Расшифровывает вложение потоком: каждый кусок сразу уходит в приёмник (файл на диске или потоковая загрузка). */
  async function attachmentDownload(
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

  return {
    vaults,
    current,
    currentId,
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
    loadTree,
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
    moveBranch,
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
    blankEntry,
  };
});
