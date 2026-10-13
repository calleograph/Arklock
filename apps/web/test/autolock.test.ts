import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_LOCK_OPTIONS,
  DEFAULT_AUTO_LOCK_MINUTES,
  autoLockMinutes,
  idleExpired,
  isAutoLockMinutes,
  setAutoLockMinutes,
} from '../src/services/autolock';

// окружение node: подменяем localStorage простой памятью (модуль читает его при каждом вызове)
const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
  };
});

const MIN = 60_000;

describe('срок блокировки при бездействии', () => {
  it('по умолчанию 8 часов, а не короткий таймер', () => {
    expect(DEFAULT_AUTO_LOCK_MINUTES).toBe(480);
    expect(autoLockMinutes()).toBe(480);
  });

  it('сохраняет выбор и читает его обратно', () => {
    setAutoLockMinutes(60);
    expect(autoLockMinutes()).toBe(60);
  });

  it('неизвестное или испорченное значение откатывается к умолчанию', () => {
    memory.set('arklock.autoLock', '7');
    expect(autoLockMinutes()).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    memory.set('arklock.autoLock', 'abc');
    expect(autoLockMinutes()).toBe(DEFAULT_AUTO_LOCK_MINUTES);
  });

  it('допускает только предусмотренные варианты', () => {
    expect(AUTO_LOCK_OPTIONS).toEqual([30, 60, 240, 480, 1440]);
    expect(isAutoLockMinutes(5)).toBe(false);
    expect(isAutoLockMinutes(30)).toBe(true);
  });
});

describe('idleExpired', () => {
  const t0 = 1_000_000_000_000;

  it('не истекает во время активного чтения (активность обновляет lastActivity)', () => {
    // пользователь прокручивает запись каждые 2 минуты в течение часа при сроке 30 минут
    let last = t0;
    for (let m = 2; m <= 60; m += 2) {
      expect(idleExpired(last, t0 + m * MIN, 30, false)).toBe(false);
      last = t0 + m * MIN;
    }
  });

  it('истекает после выбранного срока без активности', () => {
    expect(idleExpired(t0, t0 + 29 * MIN, 30, false)).toBe(false);
    expect(idleExpired(t0, t0 + 30 * MIN, 30, false)).toBe(true);
  });

  it('по умолчанию 8 часов: 7 часов без активности ещё не блокируют', () => {
    expect(idleExpired(t0, t0 + 7 * 60 * MIN, 480, false)).toBe(false);
    expect(idleExpired(t0, t0 + 8 * 60 * MIN, 480, false)).toBe(true);
  });

  it('длительная операция с ключами откладывает блокировку', () => {
    expect(idleExpired(t0, t0 + 10 * 60 * MIN, 30, true)).toBe(false);
  });
});
