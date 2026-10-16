import { expect, it } from 'vitest';
import { ctx, fromBase64Url, toBase64Url, utf8, verify } from '@arklock/crypto';
import {
  createCorporateRecoveryPackage,
  readCorporateRecoveryPackage,
  wipeRecoverySecrets,
} from '../src/services/corporate-recovery';

it('keeps corporate private keys encrypted, restores matching keys, rejects wrong phrases and altered public headers', async () => {
  const phrase = 'six offline recovery words saved separately 932!';
  const pkg = await createCorporateRecoveryPackage(phrase);
  const keys = await readCorporateRecoveryPackage(pkg.text, phrase);
  try {
    expect(keys.id).toBe(pkg.recipient.id);
    expect(pkg.text).not.toContain(toBase64Url(keys.privateKey));
    expect(pkg.text).not.toContain(toBase64Url(keys.signPrivateKey));
    expect(
      await verify(
        fromBase64Url(keys.signPublicKey),
        fromBase64Url(pkg.proof),
        utf8(ctx('corporate-recovery-activate', keys.id, keys.publicKey, keys.signPublicKey)),
      ),
    ).toBe(true);
    await expect(
      readCorporateRecoveryPackage(pkg.text, 'a different recovery passphrase'),
    ).rejects.toThrow();
    const altered = { ...JSON.parse(pkg.text), id: crypto.randomUUID() };
    await expect(readCorporateRecoveryPackage(JSON.stringify(altered), phrase)).rejects.toThrow();
    altered.kdf.memoryKiB = 1_000_000;
    await expect(readCorporateRecoveryPackage(JSON.stringify(altered), phrase)).rejects.toThrow(
      'unsupported recovery package',
    );
  } finally {
    wipeRecoverySecrets(keys);
  }
  expect(keys.privateKey.every((byte) => byte === 0)).toBe(true);
  expect(keys.signPrivateKey.every((byte) => byte === 0)).toBe(true);
}, 60_000);
