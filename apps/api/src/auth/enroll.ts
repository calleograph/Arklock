import { randomBytes } from 'node:crypto';

/** Внешняя идентичность (каталог, SSO), прошедшая проверку, но ещё не имеющая учётной записи Arklock. */
export interface ExternalIdentity {
  source: 'ldap' | 'oidc';
  /** DN в каталоге или «издатель|sub» в OIDC. */
  externalId: string;
  email: string;
  name: string;
  groups: string[];
}

/** Одноразовые токены создания учётной записи: 15 минут, в памяти процесса. */
export class EnrollStore {
  private readonly items = new Map<string, { id: ExternalIdentity; expiresAt: number }>();

  issue(id: ExternalIdentity, now = Date.now()): string {
    for (const [k, v] of this.items) if (v.expiresAt <= now) this.items.delete(k);
    const token = `ae_${randomBytes(24).toString('base64url')}`;
    this.items.set(token, { id, expiresAt: now + 15 * 60_000 });
    return token;
  }

  take(token: string, now = Date.now()): ExternalIdentity | null {
    const r = this.items.get(token);
    this.items.delete(token);
    return r && r.expiresAt > now ? r.id : null;
  }
}
