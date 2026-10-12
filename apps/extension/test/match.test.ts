import { describe, expect, it } from 'vitest';
import { isDowngrade, matchUrl } from '../src/match';

describe('matching an entry to the open page', () => {
  it('matches the same host, ignoring www, scheme and path', () => {
    expect(matchUrl('https://example.test/login', 'https://example.test/account')).toBe('exact');
    expect(matchUrl('example.test', 'https://www.example.test/')).toBe('exact');
    expect(matchUrl('https://www.example.test', 'http://example.test:8080/x')).toBe('exact');
  });

  it('accepts a subdomain of the entry host, never the reverse or a lookalike', () => {
    expect(matchUrl('example.test', 'https://login.example.test')).toBe('subdomain');
    expect(matchUrl('login.example.test', 'https://example.test')).toBe('none');
    expect(matchUrl('example.test', 'https://evil-example.test')).toBe('none');
    expect(matchUrl('example.test', 'https://example.test.evil.test')).toBe('none');
    expect(matchUrl('example.test', 'https://notexample.test')).toBe('none');
  });

  it('rejects empty or unparsable addresses', () => {
    expect(matchUrl('', 'https://example.test')).toBe('none');
    expect(matchUrl('example.test', '')).toBe('none');
    expect(matchUrl('http://', 'https://example.test')).toBe('none');
  });

  it('does not treat a bare top-level domain as a parent', () => {
    expect(matchUrl('com', 'https://example.test')).toBe('none');
  });

  it('detects a downgrade from https to http', () => {
    expect(isDowngrade('https://example.test', 'http://example.test')).toBe(true);
    expect(isDowngrade('example.test', 'http://example.test')).toBe(true);
    expect(isDowngrade('https://example.test', 'https://example.test')).toBe(false);
    expect(isDowngrade('http://intranet.local', 'http://intranet.local')).toBe(false);
  });
});
