import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * Куда администратор может направить почту и проверку соединения. Внутренние почтовые серверы (Exchange в локальной
 * сети) — обычный случай, поэтому частные сети разрешены; закрыто то, что почтой быть не может и годится для SSRF:
 * loopback, адрес «все интерфейсы», link-local (в том числе служба метаданных облака), multicast и
 * широковещательные адреса, а также порты служб, которые SMTP-диалогом не пощупать безнаказанно (SSH, базы,
 * Docker, HTTP и т. п.). Соединение устанавливается по проверенному IP: подмена DNS между проверкой и подключением
 * не работает.
 */
export class TargetError extends Error {
  constructor(
    message: string,
    readonly code: 'dns' | 'forbidden_target' | 'forbidden_port',
  ) {
    super(message);
  }
}

/** Порты, на которые SMTP-клиент Arklock не подключается (не почтовые и чувствительные службы). */
export const FORBIDDEN_PORTS = new Set([
  21, 22, 23, 53, 80, 110, 111, 135, 139, 143, 389, 443, 445, 512, 513, 514, 636, 873, 993, 995,
  1433, 1521, 2375, 2376, 3306, 3389, 5432, 5984, 6379, 8080, 9200, 11211, 27017,
]);

export function isForbiddenSmtpPort(port: number): boolean {
  return !Number.isInteger(port) || port < 1 || port > 65535 || FORBIDDEN_PORTS.has(port);
}

/** Адрес, на который почта не уходит никогда; loopback допускается только явно (тестовый стенд). */
export function isForbiddenSmtpAddress(address: string, allowLoopback = false): boolean {
  const v = net.isIP(address);
  if (v === 4) {
    const [a, b, c, d] = address.split('.').map(Number) as [number, number, number, number];
    if (a === 127) return !allowLoopback;
    return (
      a === 0 ||
      (a === 169 && b === 254) || // link-local, метаданные облака
      a >= 224 || // multicast, зарезервированные, 255.255.255.255
      (a === 192 && b === 0 && c === 0 && d === 0)
    );
  }
  if (v === 6) {
    const x = address.toLowerCase();
    if (x === '::1') return !allowLoopback;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isForbiddenSmtpAddress(mapped[1]!, allowLoopback);
    return x === '::' || /^(fe[89ab]|ff)/.test(x) || x.startsWith('64:ff9b');
  }
  return true;
}

export interface Resolved {
  /** Проверенные адреса в порядке предпочтения. */
  addresses: string[];
}

/** Имя → проверенные адреса. Ошибка, если имя не найдено или все адреса запрещены. */
export async function resolveSmtpTarget(
  host: string,
  port: number,
  allowLoopback = false,
): Promise<Resolved> {
  if (isForbiddenSmtpPort(port))
    throw new TargetError(`Port ${port} is not available for outgoing mail`, 'forbidden_port');
  let found: string[];
  if (net.isIP(host)) found = [host];
  else {
    try {
      found = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new TargetError(`The name "${host}" is not found in DNS`, 'dns');
    }
  }
  const allowed = found.filter((a) => !isForbiddenSmtpAddress(a, allowLoopback));
  if (!allowed.length)
    throw new TargetError(
      'The server address is not allowed for outgoing mail (loopback, link-local or reserved)',
      'forbidden_target',
    );
  return { addresses: allowed.slice(0, 3) };
}
