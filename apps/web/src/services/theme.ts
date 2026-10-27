/**
 * Цветовые темы. Выбор хранится в профиле пользователя на сервере (чтобы тема следовала за ним на другие устройства)
 * и дублируется в localStorage, чтобы страница входа и первая отрисовка сразу получали нужные цвета без вспышки.
 * Тема — не секрет и в зашифрованные данные не попадает.
 */
import { THEME_IDS, type ThemeId } from '@arklock/contracts';

export const THEMES = THEME_IDS;
export type { ThemeId };
/** Оформления со стеклянными панелями и фоновой графикой (public/bg). */
export const GLASS_THEMES: ThemeId[] = ['glass', 'night', 'grove', 'aurora'];
/** Прежние схемы без стеклянного слоя. */
export const CLASSIC_THEMES: ThemeId[] = THEMES.filter((x) => !GLASS_THEMES.includes(x));
export const DEFAULT_THEME: ThemeId = 'corporate';

/** Тёмные схемы включают класс .dark: на нём построены пары «светлый/тёмный» в компонентах. */
export const DARK_THEMES: ThemeId[] = ['dark', 'forest', 'night', 'aurora'];

/** Цвета для предпросмотра: фон, карточка, акцент, текст. */
export const PREVIEW: Record<ThemeId, { bg: string; card: string; accent: string; text: string }> =
  {
    glass: { bg: '#e9f1fc', card: '#ffffff', accent: '#2563c9', text: '#142a49' },
    night: { bg: '#0e1024', card: '#232650', accent: '#9d8ff7', text: '#e9ebfb' },
    grove: { bg: '#f4f6f3', card: '#ffffff', accent: '#1f7a46', text: '#1f2a1f' },
    aurora: { bg: '#061326', card: '#0f2a4d', accent: '#2dd4ee', text: '#e1f4fb' },
    corporate: { bg: '#f3f8fd', card: '#ffffff', accent: '#1676c5', text: '#173c60' },
    light: { bg: '#f8f8f6', card: '#ffffff', accent: '#414752', text: '#30343b' },
    dark: { bg: '#1a1d24', card: '#2a2f39', accent: '#8fa0d0', text: '#e8ecf5' },
    forest: { bg: '#132b25', card: '#1d3b32', accent: '#91b99c', text: '#e3f0e6' },
    emerald: { bg: '#e8f7f2', card: '#ffffff', accent: '#00806a', text: '#145b50' },
    sunset: { bg: '#fff0e7', card: '#fff9f4', accent: '#ad523b', text: '#754434' },
  };

const KEY = 'arklock.theme';

export const isTheme = (v: unknown): v is ThemeId => THEMES.includes(v as ThemeId);

/** Старые значения «light»/«dark» остаются допустимыми темами. */
export function storedTheme(): ThemeId | null {
  try {
    const v = localStorage.getItem(KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

export function applyTheme(id: ThemeId, remember = true): void {
  const root = document.documentElement;
  root.dataset.theme = id;
  root.classList.toggle('dark', DARK_THEMES.includes(id));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', PREVIEW[id].bg);
  if (remember) {
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* без хранилища тема действует до закрытия вкладки */
    }
  }
}
