/** Тонкая обёртка над navigator.credentials: JSON-параметры сервера ↔ двоичные структуры браузера. */

const fromB64 = (s: string): ArrayBuffer => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};
const toB64 = (b: ArrayBuffer | null | undefined): string | undefined => {
  if (!b) return undefined;
  let s = '';
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const webauthnSupported = (): boolean =>
  typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

interface CredDescriptor {
  id: string;
  type?: string;
  transports?: string[];
}

export async function createCredential(options: Record<string, unknown>): Promise<unknown> {
  const o = options as {
    challenge: string;
    user: { id: string; name: string; displayName: string };
    excludeCredentials?: CredDescriptor[];
  } & Record<string, unknown>;
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...(o as object),
      challenge: fromB64(o.challenge),
      user: { ...o.user, id: fromB64(o.user.id) },
      excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({
        ...c,
        type: 'public-key' as const,
        id: fromB64(c.id),
      })) as PublicKeyCredentialDescriptor[],
    } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('cancelled');
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: toB64(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64(r.clientDataJSON),
      attestationObject: toB64(r.attestationObject),
      transports: r.getTransports?.() ?? [],
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

export async function getAssertion(options: Record<string, unknown>): Promise<unknown> {
  const o = options as { challenge: string; allowCredentials?: CredDescriptor[] } & Record<
    string,
    unknown
  >;
  const cred = (await navigator.credentials.get({
    publicKey: {
      ...(o as object),
      challenge: fromB64(o.challenge),
      allowCredentials: (o.allowCredentials ?? []).map((c) => ({
        ...c,
        type: 'public-key' as const,
        id: fromB64(c.id),
      })) as PublicKeyCredentialDescriptor[],
    } as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('cancelled');
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toB64(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64(r.clientDataJSON),
      authenticatorData: toB64(r.authenticatorData),
      signature: toB64(r.signature),
      userHandle: toB64(r.userHandle),
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}
