import {
  CryptoFormatError,
  ctx,
  decrypt,
  encrypt,
  fingerprint,
  fromBase64Url,
  fromUtf8,
  generateAccountKeyPair,
  generateSalt,
  generateSigningKeyPair,
  openSealed,
  randomBytes,
  sealTo,
  sign,
  timingSafeEqual,
  toBase64Url,
  utf8,
  verify,
} from '@arklock/crypto';
import { uuid } from '@arklock/contracts';
import { deriveKeys } from './kdf';

export interface RecoveryRecipient {
  id: string;
  publicKey: string;
  signPublicKey: string;
  enabled?: boolean;
}
export interface RecoverySecrets extends RecoveryRecipient {
  privateKey: Uint8Array;
  signPrivateKey: Uint8Array;
}
interface RecoveryPackage extends RecoveryRecipient {
  format: 'arklock-corporate-recovery';
  version: 1;
  salt: string;
  kdf: typeof PACKAGE_KDF;
  ciphertext: string;
}
export const MIN_RECOVERY_PASSPHRASE = 20;
// These parameters belong to file format v1 and must survive changes to account KDF defaults.
const PACKAGE_KDF = { memoryKiB: 65536, iterations: 3, parallelism: 1 } as const;
function context(pkg: Omit<RecoveryPackage, 'ciphertext'>): string {
  return ctx(
    'corporate-recovery-package',
    pkg.version,
    pkg.id,
    pkg.publicKey,
    pkg.signPublicKey,
    pkg.salt,
    pkg.kdf.memoryKiB,
    pkg.kdf.iterations,
    pkg.kdf.parallelism,
  );
}
export function wipeRecoverySecrets(keys: RecoverySecrets | null): void {
  keys?.privateKey.fill(0);
  keys?.signPrivateKey.fill(0);
}
export async function createCorporateRecoveryPackage(
  passphrase: string,
): Promise<{ text: string; recipient: RecoveryRecipient; proof: string }> {
  if (passphrase.length < MIN_RECOVERY_PASSPHRASE || passphrase.length > 512)
    throw new CryptoFormatError('invalid recovery passphrase length');
  const enc = await generateAccountKeyPair();
  const signing = await generateSigningKeyPair().catch((e) => {
    enc.privateKey.fill(0);
    throw e;
  });
  const id = crypto.randomUUID();
  const recipient = {
    id,
    publicKey: toBase64Url(enc.publicKey),
    signPublicKey: toBase64Url(signing.publicKey),
  };
  const pkg = {
    ...recipient,
    format: 'arklock-corporate-recovery' as const,
    version: 1 as const,
    salt: toBase64Url(generateSalt()),
    kdf: { ...PACKAGE_KDF },
  };
  let plain: Uint8Array | null = null;
  try {
    const keys = await deriveKeys(
      passphrase,
      fromBase64Url(pkg.salt),
      `corporate-recovery:${id}`,
      pkg.kdf,
    );
    try {
      plain = utf8(
        JSON.stringify({
          privateKey: toBase64Url(enc.privateKey),
          signPrivateKey: toBase64Url(signing.privateKey),
        }),
      );
      const ciphertext = await encrypt(keys.wrapKey, plain, context(pkg));
      const proof = toBase64Url(
        await sign(
          signing.privateKey,
          utf8(
            ctx('corporate-recovery-activate', id, recipient.publicKey, recipient.signPublicKey),
          ),
        ),
      );
      return { text: JSON.stringify({ ...pkg, ciphertext }, null, 2), recipient, proof };
    } finally {
      keys.wrapKey.fill(0);
      keys.authKey.fill(0);
    }
  } finally {
    enc.privateKey.fill(0);
    signing.privateKey.fill(0);
    plain?.fill(0);
  }
}

export async function readCorporateRecoveryPackage(
  text: string,
  passphrase: string,
): Promise<RecoverySecrets> {
  if (text.length > 65536 || passphrase.length > 512)
    throw new CryptoFormatError('recovery package is too large');
  const raw = JSON.parse(text) as RecoveryPackage;
  if (
    !raw ||
    raw.format !== 'arklock-corporate-recovery' ||
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.publicKey !== 'string' ||
    typeof raw.signPublicKey !== 'string' ||
    typeof raw.salt !== 'string' ||
    typeof raw.ciphertext !== 'string' ||
    raw.ciphertext.length > 16384 ||
    !raw.kdf ||
    raw.kdf.memoryKiB !== PACKAGE_KDF.memoryKiB ||
    raw.kdf.iterations !== PACKAGE_KDF.iterations ||
    raw.kdf.parallelism !== PACKAGE_KDF.parallelism
  )
    throw new CryptoFormatError('unsupported recovery package');
  uuid.parse(raw.id);
  if (raw.publicKey.length > 100 || raw.signPublicKey.length > 100 || raw.salt.length > 40)
    throw new CryptoFormatError('invalid recovery package header');
  const publicKey = fromBase64Url(raw.publicKey);
  const signPublicKey = fromBase64Url(raw.signPublicKey);
  const salt = fromBase64Url(raw.salt);
  if (publicKey.length !== 65 || signPublicKey.length !== 65 || salt.length !== 16)
    throw new CryptoFormatError('invalid recovery package header');
  const keys = await deriveKeys(passphrase, salt, `corporate-recovery:${raw.id}`, raw.kdf);
  let plain: Uint8Array | null = null;
  let secrets: RecoverySecrets | null = null;
  try {
    plain = await decrypt(keys.wrapKey, raw.ciphertext, context(raw));
    const inner = JSON.parse(fromUtf8(plain)) as { privateKey: string; signPrivateKey: string };
    if (
      typeof inner?.privateKey !== 'string' ||
      typeof inner.signPrivateKey !== 'string' ||
      inner.privateKey.length > 700 ||
      inner.signPrivateKey.length > 700
    )
      throw new CryptoFormatError('invalid recovery private keys');
    const privateKey = fromBase64Url(inner.privateKey);
    try {
      secrets = {
        id: raw.id,
        publicKey: raw.publicKey,
        signPublicKey: raw.signPublicKey,
        privateKey,
        signPrivateKey: fromBase64Url(inner.signPrivateKey),
      };
    } catch (e) {
      privateKey.fill(0);
      throw e;
    }
    const probe = randomBytes(32);
    let opened: Uint8Array | null = null;
    try {
      const sealed = await sealTo(publicKey, probe, ctx('corporate-recovery-check', raw.id));
      opened = await openSealed(
        secrets.privateKey,
        publicKey,
        sealed,
        ctx('corporate-recovery-check', raw.id),
      );
      if (
        !timingSafeEqual(probe, opened) ||
        !(await verify(signPublicKey, await sign(secrets.signPrivateKey, probe), probe))
      )
        throw new CryptoFormatError('recovery key pair mismatch');
    } finally {
      probe.fill(0);
      opened?.fill(0);
    }
    return secrets;
  } catch (e) {
    wipeRecoverySecrets(secrets);
    throw e;
  } finally {
    plain?.fill(0);
    keys.wrapKey.fill(0);
    keys.authKey.fill(0);
  }
}
export function recoveryFingerprint(recipient: RecoveryRecipient): Promise<string> {
  return fingerprint(fromBase64Url(recipient.publicKey), fromBase64Url(recipient.signPublicKey));
}
