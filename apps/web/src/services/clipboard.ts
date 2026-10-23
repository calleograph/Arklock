import { api } from './api';
import type { EntryItem } from './model';

/** Копирование секрета: через 30 секунд буфер очищается, если в нём всё ещё это значение. */
export async function copyWithAutoClear(value: string, ms = 30_000): Promise<void> {
  await navigator.clipboard.writeText(value);
  setTimeout(async () => {
    try {
      if ((await navigator.clipboard.readText()) === value) await navigator.clipboard.writeText('');
    } catch {
      /* чтение буфера может быть запрещено */
    }
  }, ms);
}

/** Отметка для журнала записи: открытие карточки, показ или копирование значения (сообщает браузер). */
export async function reportEntryEvent(
  item: EntryItem,
  action: 'copy' | 'reveal' | 'open',
  field?: 'password' | 'username' | 'totp' | 'custom',
): Promise<void> {
  await api('POST', `/vaults/${item.vaultId}/entries/${item.id}/events`, { action, field });
}
