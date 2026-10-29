import 'reflect-metadata';
import { createHmac, randomBytes, webcrypto } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import * as x509 from '@peculiar/x509';
import { md4, ntowfV2 } from '../src/mail/ntlm.js';

/** Управляемый тестовый SMTP-сервер: проверяет то, что делал бы настоящий, и записывает, что получил. Синтетические учётные данные. */
export interface FakeOptions {
  /** starttls — предлагает и принимает STARTTLS; tls — сразу TLS. */
  tls?: { mode: 'starttls' | 'tls'; key: string; cert: string };
  /** Способы входа до STARTTLS и после (по умолчанию одни и те же). */
  authBefore?: string[];
  auth?: string[];
  user?: string;
  password?: string;
  /** NTLM: ожидаемые учётные данные; withTimestamp — сервер присылает отметку времени (включается MIC). */
  ntlm?: { user: string; domain: string; password: string; withTimestamp: boolean };
  /** Ответ на RCPT TO: функция вызывается на каждой попытке, null — принять. */
  rcpt?: (n: number) => string | null;
  /** Ответ на MAIL FROM. */
  mailFrom?: () => string | null;
  /** Ответ в конце письма. */
  accept?: string;
  /** Задержка приветствия, мс. */
  greetingDelay?: number;
  /** Повторять пароль в ответе об ошибке входа. */
  echoPassword?: boolean;
}

export interface Received {
  from?: string;
  to?: string;
  data: string;
  auth?: string;
  tls: boolean;
  messageId?: string;
}

export async function fakeSmtp(opts: FakeOptions = {}) {
  const received: Received[] = [];
  const log: string[] = [];
  const stats = { connections: 0, rcpt: 0, authAttempts: 0, ntlmV2: 0, micChecked: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((raw) => {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    handle(raw);
  });
  const handle = (raw: net.Socket) => {
    stats.connections++;
    let sock: net.Socket | tls.TLSSocket = raw;
    let secure = false;
    let buf = '';
    let mode: 'cmd' | 'data' | 'login-user' | 'login-pass' | 'ntlm1' | 'ntlm3' = 'cmd';
    let cur: Received = { data: '', tls: false };
    let negotiate = Buffer.alloc(0);
    let challenge = Buffer.alloc(0);
    let serverChallenge = Buffer.alloc(0);
    let loginUser = '';
    const write = (s: string) => sock.write(s + '\r\n');
    const methods = () =>
      secure || !opts.authBefore ? (opts.auth ?? ['PLAIN', 'LOGIN']) : opts.authBefore;
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      for (;;) {
        if (mode === 'data') {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          cur.data = buf.slice(0, end);
          cur.messageId = /^Message-ID: <(.+)>$/im.exec(cur.data)?.[1];
          buf = buf.slice(end + 5);
          received.push(cur);
          cur = { data: '', tls: secure };
          mode = 'cmd';
          write(opts.accept ?? '250 2.0.0 OK queued as FAKE123');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        log.push(line.replace(/^(AUTH PLAIN )\S+/i, '$1***'));
        if (mode === 'login-user') {
          loginUser = Buffer.from(line, 'base64').toString();
          mode = 'login-pass';
          write('334 UGFzc3dvcmQ6');
          continue;
        }
        if (mode === 'login-pass') {
          mode = 'cmd';
          check(loginUser, Buffer.from(line, 'base64').toString());
          continue;
        }
        if (mode === 'ntlm1') {
          negotiate = Buffer.from(line, 'base64');
          serverChallenge = randomBytes(8);
          challenge = type2();
          mode = 'ntlm3';
          write(`334 ${challenge.toString('base64')}`);
          continue;
        }
        if (mode === 'ntlm3') {
          mode = 'cmd';
          stats.authAttempts++;
          const ok = verifyNtlm(Buffer.from(line, 'base64'));
          write(
            ok ? '235 2.7.0 Authentication successful' : '535 5.7.3 Authentication unsuccessful',
          );
          continue;
        }
        if (/^EHLO/i.test(line)) {
          const m = methods();
          write(
            [
              '250-fake.example',
              ...(opts.tls?.mode === 'starttls' && !secure ? ['250-STARTTLS'] : []),
              ...(m.length ? [`250-AUTH ${m.join(' ')}`] : []),
              '250 8BITMIME',
            ].join('\r\n'),
          );
        } else if (/^STARTTLS/i.test(line) && opts.tls?.mode === 'starttls' && !secure) {
          write('220 2.0.0 Ready to start TLS');
          const t = new tls.TLSSocket(sock as net.Socket, {
            isServer: true,
            key: opts.tls.key,
            cert: opts.tls.cert,
          });
          t.on('data', onData);
          t.on('error', () => undefined);
          sock = t;
          secure = true;
          cur.tls = true;
          buf = '';
          return;
        } else if (/^AUTH PLAIN/i.test(line)) {
          const [, u, p] = Buffer.from(line.split(' ')[2] ?? '', 'base64')
            .toString()
            .split('\0');
          cur.auth = `${u}:${p}`;
          check(u ?? '', p ?? '');
        } else if (/^AUTH LOGIN/i.test(line)) {
          mode = 'login-user';
          write('334 VXNlcm5hbWU6');
        } else if (/^AUTH NTLM/i.test(line) && opts.ntlm) {
          mode = 'ntlm1';
          write('334 NTLM supported');
        } else if (/^MAIL FROM:<([^>]*)>/i.test(line)) {
          cur.from = /^MAIL FROM:<([^>]*)>/i.exec(line)![1];
          write(opts.mailFrom?.() ?? '250 2.1.0 Sender OK');
        } else if (/^RCPT TO:<([^>]*)>/i.test(line)) {
          cur.to = /^RCPT TO:<([^>]*)>/i.exec(line)![1];
          stats.rcpt++;
          write(opts.rcpt?.(stats.rcpt) ?? '250 2.1.5 Recipient OK');
        } else if (/^DATA/i.test(line)) {
          mode = 'data';
          write('354 go ahead');
        } else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else write('500 5.5.1 Unrecognized command');
      }
    };
    const check = (u: string, p: string) => {
      stats.authAttempts++;
      const ok = u === opts.user && p === opts.password;
      write(
        ok
          ? '235 2.7.0 Authentication successful'
          : `535 5.7.8 Authentication failed${opts.echoPassword ? ` for ${p}` : ''}`,
      );
    };
    const type2 = () => {
      const pairs = (id: number, v: Buffer) => {
        const h = Buffer.alloc(4);
        h.writeUInt16LE(id, 0);
        h.writeUInt16LE(v.length, 2);
        return Buffer.concat([h, v]);
      };
      const ts = Buffer.alloc(8);
      ts.writeBigUInt64LE((BigInt(Date.now()) + 11644473600000n) * 10000n);
      const info = Buffer.concat([
        pairs(2, Buffer.from(opts.ntlm!.domain, 'utf16le')),
        pairs(1, Buffer.from('EXCH01', 'utf16le')),
        ...(opts.ntlm!.withTimestamp ? [pairs(7, ts)] : []),
        Buffer.alloc(4),
      ]);
      const h = Buffer.alloc(56);
      Buffer.from('NTLMSSP\0', 'latin1').copy(h, 0);
      h.writeUInt32LE(2, 8);
      h.writeUInt16LE(0, 12);
      h.writeUInt16LE(0, 14);
      h.writeUInt32LE(56, 16);
      h.writeUInt32LE(0xe2898215 >>> 0, 20);
      serverChallenge.copy(h, 24);
      h.writeUInt16LE(info.length, 40);
      h.writeUInt16LE(info.length, 42);
      h.writeUInt32LE(56, 44);
      return Buffer.concat([h, info]);
    };
    /** Независимая проверка ответа NTLMv2: пересчёт NTProofStr (и MIC) из полученного блока. */
    const verifyNtlm = (m: Buffer): boolean => {
      const n = opts.ntlm!;
      const sec = (at: number) =>
        m.subarray(m.readUInt32LE(at + 4), m.readUInt32LE(at + 4) + m.readUInt16LE(at));
      const nt = sec(20);
      if (nt.length <= 24 || nt[16] !== 1 || nt[17] !== 1) return false; // NTLMv1 не принимается
      stats.ntlmV2++;
      const user = sec(36).toString('utf16le');
      const domain = sec(28).toString('utf16le');
      const accountOk = domain === n.domain && user === n.user;
      const key = ntowfV2(user, domain, n.password);
      const expected = createHmac('md5', key)
        .update(Buffer.concat([serverChallenge, nt.subarray(16)]))
        .digest();
      if (!expected.equals(nt.subarray(0, 16))) return false;
      if (n.withTimestamp) {
        const mic = m.subarray(72, 88);
        const zeroed = Buffer.from(m);
        zeroed.fill(0, 72, 88);
        const sessionBaseKey = createHmac('md5', key).update(nt.subarray(0, 16)).digest();
        const calc = createHmac('md5', sessionBaseKey)
          .update(Buffer.concat([negotiate, challenge, zeroed]))
          .digest();
        stats.micChecked++;
        if (!calc.equals(mic)) return false;
      }
      return accountOk;
    };
    raw.on('error', () => undefined);
    const start = () => {
      if (opts.tls?.mode === 'tls') {
        const t = new tls.TLSSocket(raw, {
          isServer: true,
          key: opts.tls.key,
          cert: opts.tls.cert,
        });
        t.on('error', () => undefined);
        t.on('data', onData);
        sock = t;
        secure = true;
        cur.tls = true;
      } else raw.on('data', onData);
      setTimeout(() => write('220 fake.example ESMTP ready'), opts.greetingDelay ?? 0);
    };
    start();
  };
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    received,
    log,
    stats,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        for (const x of sockets) x.destroy();
      }),
  };
}

/** Собственный тестовый центр сертификации и серверный сертификат (для localhost и 127.0.0.1). */
export async function makePki(dnsName = 'localhost') {
  const subtle = webcrypto.subtle;
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
  const pem = (der: ArrayBuffer, label: string) =>
    `-----BEGIN ${label}-----\n${Buffer.from(der)
      .toString('base64')
      .match(/.{1,64}/g)!
      .join('\n')}\n-----END ${label}-----\n`;
  const now = Date.now();
  const caKeys = (await subtle.generateKey(alg, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Arklock Test CA,O=Example',
    notBefore: new Date(now - 86_400_000),
    notAfter: new Date(now + 365 * 86_400_000),
    signingAlgorithm: alg,
    keys: caKeys as CryptoKeyPair,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  const leafKeys = (await subtle.generateKey(alg, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: `CN=${dnsName}`,
    issuer: ca.subject,
    notBefore: new Date(now - 86_400_000),
    notAfter: new Date(now + 90 * 86_400_000),
    signingAlgorithm: alg,
    publicKey: leafKeys.publicKey as CryptoKey,
    signingKey: caKeys.privateKey as CryptoKey,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: dnsName },
        { type: 'ip', value: '127.0.0.1' },
      ]),
    ],
  });
  return {
    caPem: ca.toString('pem'),
    certPem: leaf.toString('pem'),
    keyPem: pem(await subtle.exportKey('pkcs8', leafKeys.privateKey), 'PRIVATE KEY'),
  };
}

export { md4 };
