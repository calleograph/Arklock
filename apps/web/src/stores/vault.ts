import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { decryptEntry, encryptEntry, openVaultKey } from '@arklock/crypto';
import type { EntryRecord, VaultInfo } from '@arklock/contracts';
import { api } from '../services/api';
import { useAuthStore } from './auth';

/** Расшифрованное содержимое записи. Существует только в памяти. */
export interface EntryData {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
}

export interface EntryItem {
  id: string;
  version: number;
  data: EntryData;
}

/** Ключ хранилища — вне реактивного состояния и стирается при блокировке. */
let vaultKey: Uint8Array | null = null;

export const useVaultStore = defineStore('vault', () => {
  const locker = ref<VaultInfo | null>(null);
  const items = shallowRef<EntryItem[]>([]);
  const loading = ref(false);
  const skipped = ref(0);

  const sorted = computed(() =>
    [...items.value].sort((a, b) => a.data.title.localeCompare(b.data.title)),
  );

  function clear(): void {
    vaultKey?.fill(0);
    vaultKey = null;
    locker.value = null;
    items.value = [];
  }

  async function decryptRecord(rec: EntryRecord): Promise<EntryItem | null> {
    if (!vaultKey || !locker.value) return null;
    try {
      const data = await decryptEntry<EntryData>(rec, vaultKey, rec.vaultId, rec.id);
      return { id: rec.id, version: rec.version, data };
    } catch {
      return null; // запись повреждена или подменена — пропускаем и сообщаем счётчиком
    }
  }

  async function load(): Promise<void> {
    const auth = useAuthStore();
    loading.value = true;
    try {
      const vaults = await api<VaultInfo[]>('GET', '/vaults');
      const own = vaults.find((v) => v.kind === 'locker');
      if (!own) throw new Error('locker not found');
      const { privateKey, publicKey } = auth.keys();
      vaultKey?.fill(0);
      vaultKey = await openVaultKey(
        own.sealedKey,
        privateKey,
        publicKey,
        own.id,
        auth.user!.id,
        own.sealedKeyVersion,
      );
      locker.value = own;
      const records = await api<EntryRecord[]>('GET', `/vaults/${own.id}/entries`);
      const decrypted = await Promise.all(records.map(decryptRecord));
      items.value = decrypted.filter((x): x is EntryItem => x !== null);
      skipped.value = decrypted.length - items.value.length;
    } finally {
      loading.value = false;
    }
  }

  async function save(data: EntryData, existing?: EntryItem): Promise<void> {
    const v = locker.value;
    if (!v || !vaultKey) throw new Error('locked');
    const id = existing?.id ?? crypto.randomUUID();
    const enc = await encryptEntry(data, vaultKey, v.id, id, v.keyVersion);
    const rec = existing
      ? await api<EntryRecord>('PUT', `/vaults/${v.id}/entries/${id}`, {
          ...enc,
          expectedVersion: existing.version,
        })
      : await api<EntryRecord>('POST', `/vaults/${v.id}/entries`, { id, ...enc });
    const item: EntryItem = { id, version: rec.version, data };
    items.value = existing
      ? items.value.map((x) => (x.id === id ? item : x))
      : [...items.value, item];
  }

  async function remove(item: EntryItem): Promise<void> {
    const v = locker.value;
    if (!v) throw new Error('locked');
    await api('DELETE', `/vaults/${v.id}/entries/${item.id}?expectedVersion=${item.version}`);
    items.value = items.value.filter((x) => x.id !== item.id);
  }

  return { locker, items, sorted, loading, skipped, clear, load, save, remove };
});
