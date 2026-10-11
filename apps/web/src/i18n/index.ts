import { createI18n } from 'vue-i18n';
import ru from './ru';
import en from './en';

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
  messages: { ru, en },
});
