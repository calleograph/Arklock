import { createI18n } from 'vue-i18n';
import ru from './ru';
import en from './en';
import ruExtra from './ru.extra';
import enExtra from './en.extra';
import { ruCorporate, enCorporate } from './corporate';
import { ruHelp, enHelp } from './help';
import { ruGuides, enGuides } from './guides';

type Tree = { [k: string]: string | Tree };
/** Глубокое слияние словарей: дополнительные разделы переопределяют и расширяют базовые. */
function merge(a: Tree, b: Tree): Tree {
  const out: Tree = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = typeof v === 'object' && typeof cur === 'object' ? merge(cur, v) : v;
  }
  return out;
}

export type Locale = 'ru' | 'en';

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem('arklock.locale');
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {
    /* хранилище недоступно — берём язык браузера */
  }
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: 'en',
  messages: {
    ru: merge(merge(merge(merge(ru as Tree, ruExtra as Tree), ruCorporate), ruHelp), ruGuides),
    en: merge(merge(merge(merge(en as Tree, enExtra as Tree), enCorporate), enHelp), enGuides),
  },
});
