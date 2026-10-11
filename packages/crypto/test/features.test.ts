import { describe, expect, it } from 'vitest';
import {
  CryptoAuthError,
  CryptoFormatError,
  base32Decode,
  base32Encode,
  concat,
  createHandoff,
  decryptAttachment,
  encryptAttachment,
  encryptedSize,
  estimateStrength,
  findInRange,
  fingerprint,
  generateKey,
  generatePassphrase,
  generatePassword,
  generateSigningKeyPair,
  generateTotpSecret,
  keyLogHash,
  openAttachmentFile,
  openAttachmentMeta,
  openHandoff,
  rewrapAttachment,
  sealAttachment,
  otpauthUri,
  parseTotpInput,
  passphraseEntropyBits,
  sha1Hex,
  signKeyGrant,
  totp,
  verifyKeyGrant,
  verifyKeyLog,
  verifyTotp,
  WORDLIST,
  generateAccountKeyPair,
} from '../src/index.js';

const ascii = (s: string) => new TextEncoder().encode(s);

describe('TOTP (RFC 6238 Appendix B vectors)', () => {
  const sha1 = base32Encode(ascii('12345678901234567890'));
  const sha256 = base32Encode(ascii('12345678901234567890123456789012'));
  const sha512 = base32Encode(
    ascii('1234567890123456789012345678901234567890123456789012345678901234'),
  );
  const cases: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1234567890, '89005924', '91819424', '93441116'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  it.each(cases)('time %i', async (t, a, b, c) => {
    expect(await totp({ secret: sha1, digits: 8, algorithm: 'SHA-1' }, t * 1000)).toBe(a);
    expect(await totp({ secret: sha256, digits: 8, algorithm: 'SHA-256' }, t * 1000)).toBe(b);
    expect(await totp({ secret: sha512, digits: 8, algorithm: 'SHA-512' }, t * 1000)).toBe(c);
  });

  it('verifies with a time window and rejects other codes', async () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = await totp({ secret }, now);
    expect(await verifyTotp({ secret }, code, 1, now + 30_000)).toBe(true);
    expect(await verifyTotp({ secret }, code, 1, now + 120_000)).toBe(false);
    expect(await verifyTotp({ secret }, '000000', 0, now)).toBe(code === '000000');
    expect(await verifyTotp({ secret }, 'abc', 1, now)).toBe(false);
  });

  it('parses otpauth URIs and bare secrets', () => {
    const p = parseTotpInput(
      'otpauth://totp/Acme:me@example.com?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60',
    );
    expect(p).toEqual({ secret: 'JBSWY3DPEHPK3PXP', digits: 8, period: 60, algorithm: 'SHA-256' });
    expect(parseTotpInput('jbsw y3dp ehpk 3pxp')).toEqual({ secret: 'JBSWY3DPEHPK3PXP' });
    expect(() => parseTotpInput('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP')).toThrow(
      CryptoFormatError,
    );
    expect(() => parseTotpInput('!!!')).toThrow(CryptoFormatError);
    expect(parseTotpInput(otpauthUri('Acme', 'me', { secret: 'JBSWY3DPEHPK3PXP' })).secret).toBe(
      'JBSWY3DPEHPK3PXP',
    );
  });

  it('base32 round-trips', () => {
    const raw = generateKey();
    expect(base32Decode(base32Encode(raw))).toEqual(raw);
  });
});

describe('signatures, fingerprints, key log', () => {
  it('a key grant verifies only for the exact vault, member, version and sealed value', async () => {
    const admin = await generateSigningKeyPair();
    const sealed = 'as1.AAAA.ak1.BBBB.CCCC';
    const sig = await signKeyGrant(admin.privateKey, 'v1', 'u1', 2, sealed);
    expect(await verifyKeyGrant(admin.publicKey, sig, 'v1', 'u1', 2, sealed)).toBe(true);
    expect(await verifyKeyGrant(admin.publicKey, sig, 'v2', 'u1', 2, sealed)).toBe(false);
    expect(await verifyKeyGrant(admin.publicKey, sig, 'v1', 'u2', 2, sealed)).toBe(false);
    expect(await verifyKeyGrant(admin.publicKey, sig, 'v1', 'u1', 3, sealed)).toBe(false);
    expect(await verifyKeyGrant(admin.publicKey, sig, 'v1', 'u1', 2, sealed + 'x')).toBe(false);
    const other = await generateSigningKeyPair();
    expect(await verifyKeyGrant(other.publicKey, sig, 'v1', 'u1', 2, sealed)).toBe(false);
  });

  it('fingerprints are stable and depend on both keys', async () => {
    const a = await generateAccountKeyPair();
    const s = await generateSigningKeyPair();
    const f1 = await fingerprint(a.publicKey, s.publicKey);
    expect(f1).toMatch(/^([0-9a-f]{4} ){11}[0-9a-f]{4}$/);
    expect(await fingerprint(a.publicKey, s.publicKey)).toBe(f1);
    expect(await fingerprint(a.publicKey, (await generateSigningKeyPair()).publicKey)).not.toBe(f1);
  });

  it('the key log detects tampering, reordering and truncation of the middle', async () => {
    const mk = async (prev: string, id: string) => ({
      userId: id,
      encPublic: `e${id}`,
      signPublic: `s${id}`,
      prevHash: prev,
      hash: await keyLogHash(prev, id, `e${id}`, `s${id}`),
    });
    const a = await mk('', 'a');
    const b = await mk(a.hash, 'b');
    const c = await mk(b.hash, 'c');
    expect(await verifyKeyLog([a, b, c])).toBe(true);
    expect(await verifyKeyLog([a, c])).toBe(false);
    expect(await verifyKeyLog([a, { ...b, encPublic: 'evil' }, c])).toBe(false);
    expect(await verifyKeyLog([b, a, c])).toBe(false);
  });
});

describe('attachments', () => {
  const id = 'att-1';
  const data = new Uint8Array(2500).map((_, i) => i % 251);

  it('round-trips across chunk boundaries and reports the exact encrypted size', async () => {
    const key = generateKey();
    const enc = await encryptAttachment(key, id, data, 1000);
    expect(enc.length).toBe(encryptedSize(data.length, 1000));
    expect(await decryptAttachment(key, id, enc)).toEqual(data);
    const empty = await encryptAttachment(key, id, new Uint8Array(0), 1000);
    expect((await decryptAttachment(key, id, empty)).length).toBe(0);
  });

  it('detects wrong key, wrong id and bit flips', async () => {
    const key = generateKey();
    const enc = await encryptAttachment(key, id, data, 1000);
    await expect(decryptAttachment(generateKey(), id, enc)).rejects.toBeInstanceOf(CryptoAuthError);
    await expect(decryptAttachment(key, 'other', enc)).rejects.toBeInstanceOf(CryptoAuthError);
    const flipped = enc.slice();
    flipped[100] ^= 1;
    await expect(decryptAttachment(key, id, flipped)).rejects.toBeInstanceOf(CryptoAuthError);
  });

  it('detects truncation, dropped, duplicated and reordered chunks', async () => {
    const key = generateKey();
    const enc = await encryptAttachment(key, id, data, 1000);
    const frame = 4 + 12 + 1000 + 16;
    const f = (i: number) => enc.slice(i * frame, Math.min((i + 1) * frame, enc.length));
    await expect(decryptAttachment(key, id, enc.slice(0, enc.length - 5))).rejects.toThrow();
    await expect(decryptAttachment(key, id, concat(f(0), f(1)))).rejects.toBeInstanceOf(
      CryptoAuthError,
    ); // отрезан хвост
    await expect(decryptAttachment(key, id, concat(f(0), f(2)))).rejects.toBeInstanceOf(
      CryptoAuthError,
    );
    await expect(decryptAttachment(key, id, concat(f(0), f(0), f(1), f(2)))).rejects.toBeInstanceOf(
      CryptoAuthError,
    );
    await expect(decryptAttachment(key, id, concat(f(1), f(0), f(2)))).rejects.toBeInstanceOf(
      CryptoAuthError,
    );
  });
});

describe('handoff', () => {
  it('opens only with the fragment (and passphrase when used)', async () => {
    const { fragment, ciphertext } = await createHandoff('h1', { password: 'p4ss' });
    expect(await openHandoff('h1', ciphertext, fragment)).toEqual({ password: 'p4ss' });
    await expect(openHandoff('h2', ciphertext, fragment)).rejects.toBeInstanceOf(CryptoAuthError);
    const other = await createHandoff('h1', { password: 'x' });
    await expect(openHandoff('h1', ciphertext, other.fragment)).rejects.toBeInstanceOf(
      CryptoAuthError,
    );
    expect(ciphertext).not.toContain('p4ss');
  });

  it('a passphrase is required when it was set', async () => {
    const { fragment, ciphertext } = await createHandoff('h3', { s: 1 }, 'correct horse');
    expect(await openHandoff('h3', ciphertext, fragment, 'correct horse')).toEqual({ s: 1 });
    await expect(openHandoff('h3', ciphertext, fragment)).rejects.toBeInstanceOf(CryptoAuthError);
    await expect(openHandoff('h3', ciphertext, fragment, 'wrong')).rejects.toBeInstanceOf(
      CryptoAuthError,
    );
  });
});

describe('password tools', () => {
  it('generates passwords of the requested length with every selected class', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword({ length: 16 });
      expect(p).toHaveLength(16);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/\d/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
    expect(generatePassword({ length: 30, symbols: false, upper: false })).toMatch(
      /^[a-z0-9]{30}$/,
    );
    expect(generatePassword({ length: 200 })).toHaveLength(128);
    expect(generatePassword({ length: 40, avoidAmbiguous: true })).not.toMatch(/[0O1lI|]/);
    expect(() =>
      generatePassword({ lower: false, upper: false, digits: false, symbols: false }),
    ).toThrow(RangeError);
  });

  it('generates passphrases from the word list', () => {
    expect(WORDLIST).toHaveLength(1296);
    const p = generatePassphrase({ words: 6, separator: '.' });
    const words = p.split('.');
    expect(words).toHaveLength(6);
    for (const w of words) expect(WORDLIST).toContain(w);
    expect(passphraseEntropyBits(6)).toBeCloseTo(62, 0);
    expect(generatePassphrase({ words: 3, capitalize: true, appendNumber: true })).toMatch(
      /^([A-Z][a-z-]+-){3}\d+$/,
    );
  });

  it('rates weak, common and strong passwords', () => {
    expect(estimateStrength('password').issues).toContain('common');
    expect(estimateStrength('password').score).toBe(0);
    expect(estimateStrength('aaaa1111').issues).toContain('repeat');
    expect(estimateStrength('abcd1234!').issues).toContain('sequence');
    expect(estimateStrength('Xk9#mP2$vL7@nQ4!wR8').score).toBeGreaterThanOrEqual(3);
    expect(estimateStrength('').score).toBe(0);
  });

  it('computes SHA-1 for range lookups and parses range responses', async () => {
    expect(await sha1Hex('password')).toBe('5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
    const body =
      '0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\nFFFF:0';
    expect(findInRange(body, '1E4C9B93F3F0682250B6CF8331B7EE68FD8')).toBe(9545824);
    expect(findInRange(body, 'ABCDEF')).toBe(0);
  });
});

describe('sealed attachments', () => {
  const vaultId = '11111111-1111-4111-8111-111111111111';

  it('seals a file, hides its name, opens with the vault key only', async () => {
    const vk = generateKey();
    const data = new TextEncoder().encode('contract text '.repeat(1000));
    const sealed = await sealAttachment(
      vk,
      vaultId,
      1,
      { name: 'contract.pdf', type: 'application/pdf', size: data.length },
      data,
    );
    expect(sealed.metaCipher).not.toContain('contract');
    expect(await openAttachmentMeta(vk, vaultId, sealed)).toMatchObject({ name: 'contract.pdf' });
    expect(await openAttachmentFile(vk, vaultId, sealed, sealed.file)).toEqual(data);
    await expect(
      openAttachmentFile(generateKey(), vaultId, sealed, sealed.file),
    ).rejects.toBeInstanceOf(CryptoAuthError);
    // чужой id (подмена записи вложения) и чужое хранилище не открываются
    await expect(
      openAttachmentMeta(vk, vaultId, { ...sealed, id: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(CryptoAuthError);
    await expect(
      openAttachmentMeta(vk, '22222222-2222-4222-8222-222222222222', sealed),
    ).rejects.toBeInstanceOf(CryptoAuthError);
  });

  it('rewrap moves the file to a new key and the old key no longer opens it', async () => {
    const oldKey = generateKey();
    const newKey = generateKey();
    const data = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => i % 251);
    const sealed = await sealAttachment(
      oldKey,
      vaultId,
      1,
      { name: 'big.bin', type: '', size: data.length },
      data,
    );
    const moved = await rewrapAttachment(oldKey, newKey, vaultId, sealed, sealed.file, 2);
    expect(moved.id).toBe(sealed.id);
    expect(moved.file.length).toBe(sealed.file.length);
    const opened = await openAttachmentFile(newKey, vaultId, moved, moved.file);
    expect(Buffer.from(opened).equals(Buffer.from(data))).toBe(true);
    await expect(openAttachmentFile(oldKey, vaultId, moved, moved.file)).rejects.toBeInstanceOf(
      CryptoAuthError,
    );
  });
});
