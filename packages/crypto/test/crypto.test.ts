import { argon2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CryptoAuthError,
  CryptoFormatError,
  DEFAULT_KDF,
  assertKdfParams,
  createVaultKey,
  ctx,
  generateRecoveryKey,
  parseRecoveryCode,
  rewrapAccountPrivateKey,
  unwrapPrivateKeyWithRecovery,
  wrapPrivateKeyForRecovery,
  decrypt,
  decryptEntry,
  deriveMasterKeys,
  encrypt,
  encryptEntry,
  generateAccountKeyPair,
  generateKey,
  generateSalt,
  openSealed,
  openVaultKey,
  rewrapEntry,
  sealTo,
  sealVaultKeyFor,
  timingSafeEqual,
  unwrapAccountPrivateKey,
  utf8,
  wrapAccountPrivateKey,
} from '../src/index.js';

// В тестах параметры занижены ради скорости; продукт снизить нижнюю границу не может.
const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 };
const LOW_FLOOR = { memoryKiB: 8, iterations: 1, parallelism: 1 };
const derive = (pw: string, salt: Uint8Array, id: string) =>
  deriveMasterKeys(pw, salt, id, FAST, LOW_FLOOR);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('aead', () => {
  it('round-trips and uses a fresh nonce each time', async () => {
    const key = generateKey();
    const a = await encrypt(key, utf8('secret'), 'ctx');
    const b = await encrypt(key, utf8('secret'), 'ctx');
    expect(a).not.toBe(b);
    expect(a.startsWith('ak1.')).toBe(true);
    expect(text(await decrypt(key, a, 'ctx'))).toBe('secret');
  });

  it('rejects wrong key, wrong aad and tampering with the same error', async () => {
    const key = generateKey();
    const sealed = await encrypt(key, utf8('secret'), 'ctx');
    await expect(decrypt(generateKey(), sealed, 'ctx')).rejects.toBeInstanceOf(CryptoAuthError);
    await expect(decrypt(key, sealed, 'other')).rejects.toBeInstanceOf(CryptoAuthError);
    const parts = sealed.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}AA`;
    await expect(decrypt(key, tampered, 'ctx')).rejects.toBeInstanceOf(CryptoAuthError);
  });

  it('rejects unknown format versions, short keys and empty aad', async () => {
    const key = generateKey();
    await expect(decrypt(key, 'ak9.AAAA.AAAA', 'ctx')).rejects.toBeInstanceOf(CryptoFormatError);
    await expect(encrypt(key, utf8('x'), '')).rejects.toBeInstanceOf(CryptoFormatError);
    await expect(encrypt(new Uint8Array(16), utf8('x'), 'ctx')).rejects.toBeInstanceOf(
      CryptoFormatError,
    );
  });
});

describe('kdf', () => {
  it('is deterministic and keeps wrap/auth keys independent', async () => {
    const salt = generateSalt();
    const a = await derive('correct horse', salt, 'user@example.com');
    const b = await derive('correct horse', salt, 'user@example.com');
    expect(timingSafeEqual(a.wrapKey, b.wrapKey)).toBe(true);
    expect(timingSafeEqual(a.authKey, b.authKey)).toBe(true);
    expect(timingSafeEqual(a.wrapKey, a.authKey)).toBe(false);
  });

  it('depends on password, salt and account id', async () => {
    const salt = generateSalt();
    const base = await derive('pw', salt, 'a@example.com');
    for (const other of [
      await derive('pw2', salt, 'a@example.com'),
      await derive('pw', generateSalt(), 'a@example.com'),
      await derive('pw', salt, 'b@example.com'),
    ]) {
      expect(timingSafeEqual(base.wrapKey, other.wrapKey)).toBe(false);
    }
  });

  it('refuses weakened parameters in product mode', async () => {
    expect(() => assertKdfParams({ memoryKiB: 1024, iterations: 1, parallelism: 1 })).toThrow(
      CryptoFormatError,
    );
    await expect(deriveMasterKeys('pw', generateSalt(), 'id', FAST)).rejects.toBeInstanceOf(
      CryptoFormatError,
    );
    expect(() => assertKdfParams(DEFAULT_KDF)).not.toThrow();
  });
});

describe('sealed box', () => {
  it('delivers to the recipient only and binds the context', async () => {
    const alice = await generateAccountKeyPair();
    const eve = await generateAccountKeyPair();
    const sealed = await sealTo(alice.publicKey, utf8('vault-key'), 'ctx');
    expect(text(await openSealed(alice.privateKey, alice.publicKey, sealed, 'ctx'))).toBe(
      'vault-key',
    );
    await expect(openSealed(eve.privateKey, eve.publicKey, sealed, 'ctx')).rejects.toBeInstanceOf(
      CryptoAuthError,
    );
    await expect(
      openSealed(alice.privateKey, alice.publicKey, sealed, 'other'),
    ).rejects.toBeInstanceOf(CryptoAuthError);
  });

  it('rejects malformed public keys', async () => {
    await expect(sealTo(new Uint8Array(10), utf8('x'), 'ctx')).rejects.toBeInstanceOf(
      CryptoFormatError,
    );
  });
});

describe('vault and entries', () => {
  it('full flow: password → account key → vault key → entry', async () => {
    const salt = generateSalt();
    const { wrapKey } = await derive('master', salt, 'u1');
    const kp = await generateAccountKeyPair();
    const wrapped = await wrapAccountPrivateKey(wrapKey, kp.privateKey, 'u1');
    const priv = await unwrapAccountPrivateKey(wrapKey, wrapped, 'u1');

    const vk = createVaultKey();
    const sealedVk = await sealVaultKeyFor(vk, kp.publicKey, 'v1', 'u1', 1);
    const vk2 = await openVaultKey(sealedVk, priv, kp.publicKey, 'v1', 'u1', 1);

    const enc = await encryptEntry({ title: 'mail', password: 'p@ss' }, vk2, 'v1', 'e1', 1);
    expect(JSON.stringify(enc)).not.toContain('p@ss');
    expect(await decryptEntry(enc, vk, 'v1', 'e1')).toEqual({ title: 'mail', password: 'p@ss' });
  });

  it('binds ciphertext to vault and entry ids (server cannot swap records)', async () => {
    const vk = createVaultKey();
    const enc = await encryptEntry({ a: 1 }, vk, 'v1', 'e1', 1);
    await expect(decryptEntry(enc, vk, 'v1', 'e2')).rejects.toBeInstanceOf(CryptoAuthError);
    await expect(decryptEntry(enc, vk, 'v2', 'e1')).rejects.toBeInstanceOf(CryptoAuthError);
  });

  it('rotation: the old vault key cannot open re-wrapped entries', async () => {
    const oldVk = createVaultKey();
    const newVk = createVaultKey();
    const enc = await encryptEntry({ secret: 's' }, oldVk, 'v1', 'e1', 1);
    const rotated = await rewrapEntry(enc, oldVk, newVk, 'v1', 'e1', 2);
    expect(rotated.keyVersion).toBe(2);
    expect(await decryptEntry(rotated, newVk, 'v1', 'e1')).toEqual({ secret: 's' });
    await expect(decryptEntry(rotated, oldVk, 'v1', 'e1')).rejects.toBeInstanceOf(CryptoAuthError);
  });
});

describe('context encoding', () => {
  it('does not let different id splits collide', async () => {
    const vk = createVaultKey();
    const enc = await encryptEntry({ a: 1 }, vk, 'a:b', 'c', 1);
    await expect(decryptEntry(enc, vk, 'a', 'b:c')).rejects.toBeInstanceOf(CryptoAuthError);
    expect(ctx('x', 'a:b', 'c')).not.toBe(ctx('x', 'a', 'b:c'));
  });

  it('reports non-JSON plaintext as a format error', async () => {
    const vk = createVaultKey();
    const entryKey = generateKey();
    const c = ctx('entry', 'v', 'e', 1);
    const bad = {
      keyVersion: 1,
      ciphertext: await encrypt(entryKey, utf8('not json'), c),
      wrappedEntryKey: await encrypt(vk, entryKey, ctx('entry-key', 'v', 'e', 1)),
    };
    await expect(decryptEntry(bad, vk, 'v', 'e')).rejects.toBeInstanceOf(CryptoFormatError);
  });
});

describe('argon2id implementation', () => {
  // hash-wasm не поддерживает associated data, поэтому вектор RFC 9106 §5.3 сверяется с эталоном OpenSSL
  // (Node), а hash-wasm — с тем же эталоном на одинаковых входных данных без AD.
  const rfc = {
    message: Buffer.alloc(32, 1),
    nonce: Buffer.alloc(16, 2),
    secret: Buffer.alloc(8, 3),
    parallelism: 4,
    tagLength: 32,
    memory: 32,
    passes: 3,
  };

  it('reference implementation reproduces the RFC 9106 test vector', () => {
    const tag = argon2Sync('argon2id', { ...rfc, associatedData: Buffer.alloc(12, 4) });
    expect(tag.toString('hex')).toBe(
      '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
    );
  });

  it('hash-wasm agrees with the reference implementation', async () => {
    const { argon2id } = await import('hash-wasm');
    for (const p of [
      { ...rfc },
      { ...rfc, memory: 64, passes: 2, parallelism: 1 },
      { ...rfc, memory: 19456, passes: 2, parallelism: 1 },
    ]) {
      const ours = await argon2id({
        password: p.message,
        salt: p.nonce,
        secret: p.secret,
        iterations: p.passes,
        memorySize: p.memory,
        parallelism: p.parallelism,
        hashLength: p.tagLength,
        outputType: 'hex',
      });
      expect(ours).toBe(argon2Sync('argon2id', p).toString('hex'));
    }
  });
});

describe('account recovery and password change', () => {
  it('password change keeps the same private key and invalidates the old wrap key', async () => {
    const kp = await generateAccountKeyPair();
    const oldK = await derive('old password', generateSalt(), 'u1');
    const newK = await derive('new password', generateSalt(), 'u1');
    const wrapped = await wrapAccountPrivateKey(oldK.wrapKey, kp.privateKey, 'u1');
    const rewrapped = await rewrapAccountPrivateKey(oldK.wrapKey, newK.wrapKey, wrapped, 'u1');
    expect(
      timingSafeEqual(await unwrapAccountPrivateKey(newK.wrapKey, rewrapped, 'u1'), kp.privateKey),
    ).toBe(true);
    await expect(unwrapAccountPrivateKey(oldK.wrapKey, rewrapped, 'u1')).rejects.toBeInstanceOf(
      CryptoAuthError,
    );
  });

  it('recovery code restores the private key without the master password', async () => {
    const kp = await generateAccountKeyPair();
    const { key, code } = await generateRecoveryKey();
    expect(code).toMatch(/^([0-9A-Z]{5}-){10}[0-9A-Z]{1,5}$/);
    const wrapped = await wrapPrivateKeyForRecovery(key, kp.privateKey, 'u1');
    const parsed = await parseRecoveryCode(code.toLowerCase().replace(/-/g, ' '));
    const priv = await unwrapPrivateKeyWithRecovery(parsed, wrapped, 'u1');
    expect(timingSafeEqual(priv, kp.privateKey)).toBe(true);
    await expect(unwrapPrivateKeyWithRecovery(parsed, wrapped, 'u2')).rejects.toBeInstanceOf(
      CryptoAuthError,
    );
  });

  it('detects mistyped recovery codes before contacting the server', async () => {
    const { code } = await generateRecoveryKey();
    const typo = (code[0] === 'A' ? 'B' : 'A') + code.slice(1);
    await expect(parseRecoveryCode(typo)).rejects.toBeInstanceOf(CryptoFormatError);
    await expect(parseRecoveryCode('!!!')).rejects.toBeInstanceOf(CryptoFormatError);
  });
});
