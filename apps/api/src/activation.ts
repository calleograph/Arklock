import { randomBytes } from 'node:crypto';
import { sha256Hex } from './security.js';

/**
 * Одноразовый код активации учётной записи: 120 бит случайности, без неоднозначных символов (0/O, 1/I),
 * записывается группами по шесть знаков: ABCDEF-GHJKLM-NPQRST-UVWXYZ (показывается администратору один раз).
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUP = 6;
const CODE_LENGTH = 24;

/** Новый код активации. */
export function newActivationCode(): string {
  const bytes = randomBytes(15);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  const chars = out.slice(0, CODE_LENGTH);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += GROUP) groups.push(chars.slice(i, i + GROUP));
  return groups.join('-');
}

/**
 * Приводит введённый код к каноническому виду: пробелы и дефисы игнорируются, регистр не важен.
 * Ссылки старого формата (inv_…) не меняются: они чувствительны к регистру.
 */
export function normalizeInvitationToken(raw: string): string {
  const token = raw.trim();
  if (token.startsWith('inv_')) return token;
  return token.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Хэш токена приглашения для хранения (сам токен в базе не хранится). */
export const invitationTokenHash = (raw: string): string =>
  sha256Hex(normalizeInvitationToken(raw));
