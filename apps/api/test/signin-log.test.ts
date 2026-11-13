import { describe, expect, it } from 'vitest';
import { safeLogin } from '../src/signin-log.js';

describe('the typed login that reaches the ledger', () => {
  it('keeps login-like text and never a password pasted into the field', () => {
    expect(safeLogin('ivanov')).toBe('ivanov');
    expect(safeLogin('EXAMPLE\\ivanov')).toBe('EXAMPLE\\ivanov');
    expect(safeLogin('anna.petrova@example.com')).toBe('anna.petrova@example.com');
    expect(safeLogin('Иванов')).toBe('Иванов');
    // пробелы, символы пароля и слишком длинный текст не сохраняются
    expect(safeLogin('correct horse battery staple')).toBe('*** (28)');
    expect(safeLogin('P@ss!word#1')).toBe('*** (11)');
    expect(safeLogin('a'.repeat(65))).toBe('*** (65)');
    expect(safeLogin('')).toBe('');
    expect(safeLogin(undefined)).toBe('');
  });
});
