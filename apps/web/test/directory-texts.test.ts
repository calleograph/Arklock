import { describe, expect, it } from 'vitest';
import { DIRECTORY_REASONS, DIRECTORY_STAGES } from '@arklock/contracts';
import { i18n } from '../src/i18n';

// Каждая причина и этап, которые может вернуть сервер, имеют понятный текст на обоих языках.
// Без текста пользователь видит только общую фразу, поэтому тест падает раньше, чем это попадёт в релиз.
describe('directory reasons and stages have text in both languages', () => {
  for (const locale of ['ru', 'en'] as const) {
    it(`${locale}: every reason`, () => {
      const missing = DIRECTORY_REASONS.filter((r) => !i18n.global.te(`dir.reason.${r}`, locale));
      expect(missing).toEqual([]);
    });
    it(`${locale}: every stage`, () => {
      const missing = DIRECTORY_STAGES.filter((st) => !i18n.global.te(`dir.stage.${st}`, locale));
      expect(missing).toEqual([]);
    });
  }
});
