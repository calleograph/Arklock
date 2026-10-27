import { ref } from 'vue';

/** Примечания к выпускам собираются из CHANGELOG.md (scripts/release-notes.mjs) и подгружаются при первом открытии окна. */
export interface Release {
  version: string;
  date: string | null;
  sections: { id: string; items: string[] }[];
}

export const RELEASES_URL = 'https://github.com/calleograph/Arklock/releases';

export function cmpVersion(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x![i] ?? 0) !== (y![i] ?? 0)) return (x![i] ?? 0) - (y![i] ?? 0);
  return 0;
}

export async function loadReleases(): Promise<Release[]> {
  return (await import('../release-notes.json')).default.releases as Release[];
}

/** Выпуски новее просмотренного и не новее установленного, от новых к старым. */
export function between(all: Release[], seen: string | null, current: string): Release[] {
  return all.filter(
    (r) => (!seen || cmpVersion(r.version, seen) > 0) && cmpVersion(r.version, current) <= 0,
  );
}

/** Состояние окна «Что нового»: null — закрыто, from — версия, после которой показывать сводку (null — только текущая). */
export const whatsNew = ref<{ from: string | null } | null>(null);
export const openWhatsNew = (from: string | null = null): void => {
  whatsNew.value = { from };
};

/** Текст пункта: экранируется целиком, затем разрешаются только **жирный** и `код`. */
export function inline(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
