import { BlockList, isIP } from 'node:net';

/** Единый вид адреса: IPv4-in-IPv6 приводится к IPv4, IPv6 — к нижнему регистру. */
export function normalizeIp(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  const v = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  return mapped ? mapped[1]! : v;
}

/** Разбор записи «адрес» или «адрес/длина»; null, если запись некорректна. */
export function parseCidr(
  input: string,
): { cidr: string; family: 'ipv4' | 'ipv6'; address: string; prefix: number } | null {
  const [addr, len, extra] = input.trim().split('/');
  if (extra !== undefined || !addr) return null;
  const address = normalizeIp(addr);
  const kind = isIP(address);
  if (!kind) return null;
  const max = kind === 4 ? 32 : 128;
  const prefix = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : -1;
  if (prefix < 0 || prefix > max) return null;
  return {
    cidr: `${address}/${prefix}`,
    family: kind === 4 ? 'ipv4' : 'ipv6',
    address,
    prefix,
  };
}

/** Набор подсетей для быстрой проверки (IPv4 и IPv6). */
export class CidrSet {
  private readonly list = new BlockList();
  readonly size: number;

  constructor(cidrs: string[]) {
    let n = 0;
    for (const c of cidrs) {
      const p = parseCidr(c);
      if (!p) continue;
      this.list.addSubnet(p.address, p.prefix, p.family);
      n++;
    }
    this.size = n;
  }

  has(ip: string): boolean {
    const a = normalizeIp(ip);
    const kind = isIP(a);
    return kind !== 0 && this.list.check(a, kind === 4 ? 'ipv4' : 'ipv6');
  }
}
