/**
 * Цветовые темы. Выбор хранится в профиле пользователя на сервере (чтобы тема следовала за ним на другие устройства)
 * и дублируется в localStorage, чтобы страница входа и первая отрисовка сразу получали нужные цвета без вспышки.
 * Тема — не секрет и в зашифрованные данные не попадает.
 */
import { DEFAULT_THEME, normalizeTheme, THEME_IDS, type ThemeId } from '@arklock/contracts';

export const THEMES = THEME_IDS;
export type { ThemeId };
export { DEFAULT_THEME };

/** Тёмные схемы включают класс .dark на <html>: на нём построены пары «светлый/тёмный» в компонентах. */
export const DARK_THEMES: ThemeId[] = ['night', 'aurora'];

/** Цвета для предпросмотра: фон, карточка, акцент, текст. */
export const PREVIEW: Record<ThemeId, { bg: string; card: string; accent: string; text: string }> =
  {
    glass: { bg: '#e9f1fc', card: '#ffffff', accent: '#2563c9', text: '#142a49' },
    night: { bg: '#0e1024', card: '#232650', accent: '#9d8ff7', text: '#e9ebfb' },
    grove: { bg: '#f4f6f3', card: '#ffffff', accent: '#1f7a46', text: '#1f2a1f' },
    aurora: { bg: '#061326', card: '#0f2a4d', accent: '#2dd4ee', text: '#e1f4fb' },
  };

const KEY = 'arklock.theme';

export const isTheme = (v: unknown): v is ThemeId => THEMES.includes(v as ThemeId);

/** Любое сохранённое значение (в том числе прежняя схема) → одна из четырёх тем. */
export const toTheme = (v: unknown): ThemeId => normalizeTheme(v) ?? DEFAULT_THEME;

/** Прежние значения в браузере (corporate, dark…) приводятся к ближайшей из четырёх тем. */
export function storedTheme(): ThemeId | null {
  try {
    return normalizeTheme(localStorage.getItem(KEY));
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
