import { lookup } from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';

/**
 * Исходящие запросы к настраиваемым администратором адресам (проверка утечек, интеграции) защищены от SSRF:
 * только HTTPS, без учётных данных в адресе, имя разрешается в адреса, и ни один из них не может быть внутренним
 * (loopback, частные сети, link-local, CGNAT, metadata, multicast); соединение устанавливается по проверенному IP
 * (защита от подмены DNS между проверкой и соединением), перенаправления не выполняются, время и размер ответа ограничены.
 */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export function isForbiddenAddress(address: string): boolean {
  const v = net.isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || // 192.0.0.0/24, документационные
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast и зарезервированные
    );
  }
  if (v === 6) {
    const x = address.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isForbiddenAddress(mapped[1]!);
    return /^(fc|fd|fe[89ab]|ff)/.test(x) || x.startsWith('2001:db8') || x.startsWith('64:ff9b');
  }
  return true;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  /** POST с телом (вебхуки); по умолчанию GET. */
  method?: 'GET' | 'POST';
  body?: string;
  /** Только для тестов: разрешить http и внутренние адреса. */
  allowInsecureForTests?: boolean;
}

export function assertSafeUrl(raw: string, allowInsecure = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('invalid URL');
  }
  if (url.username || url.password)
    throw new UnsafeUrlError('credentials in the URL are not allowed');
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new UnsafeUrlError('only HTTPS is allowed');
  }
  if (!url.hostname) throw new UnsafeUrlError('host is required');
  return url;
}

export async function safeGet(
  raw: string,
  opts: SafeFetchOptions = {},
): Promise<{ status: number; body: string }> {
  const url = assertSafeUrl(raw, opts.allowInsecureForTests);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addrs.length) throw new UnsafeUrlError('host cannot be resolved');
  if (!opts.allowInsecureForTests && addrs.some((a) => isForbiddenAddress(a.address))) {
    throw new UnsafeUrlError('address is not allowed');
  }
  const target = addrs[0]!.address;
  const isHttps = url.protocol === 'https:';
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        host: target,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: opts.method ?? 'GET',
        headers: {
          Host: url.host,
          'User-Agent': 'arklock',
          ...(opts.body !== undefined
            ? { 'Content-Length': String(Buffer.byteLength(opts.body)) }
            : {}),
          ...opts.headers,
        },
        servername: isHttps ? host : undefined, // SNI и проверка сертификата — по имени, соединение — по проверенному IP
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(new UnsafeUrlError('redirects are not followed'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new UnsafeUrlError('response is too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new UnsafeUrlError('request timed out')));
    req.on('error', reject);
    req.end(opts.body);
  });
}
