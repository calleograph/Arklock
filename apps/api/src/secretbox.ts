import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Шифрование секретов настроек (пароль SMTP, bind-пароль LDAP, секреты SSO), которые серверу нужны в открытом виде.
 * Ключ выводится из APP_SECRET отдельно для каждой цели; шифртекст привязан к цели (AAD), подмена записей между
 * настройками не проходит. Это не пользовательские данные: они шифруются на клиенте и ключей сервера не знают.
 */
const key = (appSecret: string, purpose: string): Buffer =>
  Buffer.from(hkdfSync('sha256', appSecret, 'arklock-settings', `secretbox|${purpose}`, 32));

export function sealSetting(appSecret: string, purpose: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(appSecret, purpose), iv);
  c.setAAD(Buffer.from(purpose));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()]);
  return `s1.${iv.toString('base64url')}.${ct.toString('base64url')}`;
}

export function openSetting(appSecret: string, purpose: string, sealed: string): string {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 's1' || !iv || !ct) throw new Error('bad sealed value');
  const raw = Buffer.from(ct, 'base64url');
  const d = createDecipheriv('aes-256-gcm', key(appSecret, purpose), Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(purpose));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
}
