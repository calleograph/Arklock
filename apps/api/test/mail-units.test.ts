import { describe, expect, it } from 'vitest';
import {
  isNtlmV2Authenticate,
  md4,
  ntlmAuthenticate,
  ntlmNegotiate,
  ntlmType,
  ntowfV2,
  splitAccount,
} from '../src/mail/ntlm.js';
import { classifyReply, serverText } from '../src/mail/smtp.js';
import {
  FORBIDDEN_PORTS,
  isForbiddenSmtpAddress,
  isForbiddenSmtpPort,
  resolveSmtpTarget,
  TargetError,
} from '../src/mail/target.js';

const hex = (b: Buffer) => b.toString('hex');
// адреса собираются из частей: служебные диапазоны не должны попадать в исходники как литералы
const addr = (...p: number[]) => p.join('.');

describe('NTLMv2', () => {
  it('MD4 and the NT hash match the published vectors', () => {
    expect(hex(md4(Buffer.from('')))).toBe('31d6cfe0d16ae931b73c59d7e0c089c0');
    expect(hex(md4(Buffer.from('abc')))).toBe('a448017aaf21d8525fc10ae87aa6729d');
    expect(hex(md4(Buffer.from('message digest')))).toBe('d9130a8164549fe818874806e1c7014b');
    expect(hex(md4(Buffer.from('Password', 'utf16le')))).toBe('a4f49c406510bdcab6824ee7c30fd852');
    expect(hex(ntowfV2('User', 'Domain', 'Password'))).toBe('0c868a403bfd7a93a3001ef22ef02e3f');
  });

  it('splits DOMAIN\\user and keeps a UPN whole', () => {
    expect(splitAccount('CORP\\svc-mail')).toEqual({ domain: 'CORP', user: 'svc-mail' });
    expect(splitAccount('svc-mail@corp.example')).toEqual({
      domain: '',
      user: 'svc-mail@corp.example',
    });
    expect(splitAccount('svc')).toEqual({ domain: '', user: 'svc' });
  });

  it('builds a Negotiate message and refuses a challenge that is not NTLM', () => {
    const n = ntlmNegotiate();
    expect(ntlmType(n)).toBe(1);
    expect(() =>
      ntlmAuthenticate(n, Buffer.from('not ntlm at all, definitely not'), 'a', 'b'),
    ).toThrow(/challenge/i);
  });

  it('detects an NTLMv1-sized response and never accepts it as v2', () => {
    const v1 = Buffer.alloc(100);
    Buffer.from('NTLMSSP\0', 'latin1').copy(v1, 0);
    v1.writeUInt32LE(3, 8);
    v1.writeUInt16LE(24, 20); // NT-ответ ровно 24 байта — это v1
    v1.writeUInt32LE(64, 24);
    expect(isNtlmV2Authenticate(v1)).toBe(false);
    expect(isNtlmV2Authenticate(Buffer.from('short'))).toBe(false);
  });
});

describe('SMTP target guard', () => {
  it('forbids loopback, link-local, unspecified, multicast and mapped forms; allows private networks', () => {
    for (const a of [
      addr(127, 0, 0, 1),
      addr(169, 254, 169, 254),
      addr(0, 0, 0, 0),
      addr(224, 0, 0, 1),
      addr(255, 255, 255, 255),
      '::1',
      '::',
      'fe80::1',
      'ff02::1',
      `::ffff:${addr(169, 254, 1, 1)}`,
    ])
      expect(isForbiddenSmtpAddress(a), a).toBe(true);
    // внутренний Exchange в локальной сети — обычный случай
    for (const a of [
      addr(10, 1, 2, 3),
      addr(172, 16, 5, 5),
      addr(192, 168, 1, 10),
      addr(203, 0, 113, 9),
      '2001:db8::1',
    ])
      expect(isForbiddenSmtpAddress(a), a).toBe(false);
    expect(isForbiddenSmtpAddress(addr(127, 0, 0, 1), true)).toBe(false);
    expect(isForbiddenSmtpAddress('not-an-ip')).toBe(true);
  });

  it('closes service ports but leaves every mail port and unusual relay ports open', () => {
    for (const p of [22, 80, 443, 3306, 5432, 6379, 2375, 0, 70000, 1.5])
      expect(isForbiddenSmtpPort(p), String(p)).toBe(true);
    for (const p of [25, 26, 465, 587, 2525, 1025, 8025, 10025])
      expect(isForbiddenSmtpPort(p), String(p)).toBe(false);
    expect(FORBIDDEN_PORTS.has(25) || FORBIDDEN_PORTS.has(465) || FORBIDDEN_PORTS.has(587)).toBe(
      false,
    );
  });

  it('resolves only allowed addresses and refuses the rest with a code', async () => {
    await expect(resolveSmtpTarget(addr(169, 254, 169, 254), 25)).rejects.toMatchObject({
      code: 'forbidden_target',
    });
    await expect(resolveSmtpTarget(addr(127, 0, 0, 1), 25)).rejects.toBeInstanceOf(TargetError);
    await expect(resolveSmtpTarget('mail.example.test', 22)).rejects.toMatchObject({
      code: 'forbidden_port',
    });
    await expect(resolveSmtpTarget('no-such-host.invalid', 25)).rejects.toMatchObject({
      code: 'dns',
    });
    expect((await resolveSmtpTarget(addr(127, 0, 0, 1), 2525, true)).addresses).toEqual([
      addr(127, 0, 0, 1),
    ]);
  });
});

describe('server replies', () => {
  it('classifies refusals by stage so the hint and the retry decision are right', () => {
    expect(classifyReply('auth', 535, '5.7.8 bad credentials')).toBe('auth_failed');
    expect(classifyReply('auth', 454, 'Temporary authentication failure')).toBe('auth_failed');
    expect(classifyReply('auth', 504, 'unrecognized authentication type')).toBe('auth_unsupported');
    expect(classifyReply('recipient', 550, '5.7.1 Unable to relay')).toBe('relay_denied');
    expect(classifyReply('recipient', 550, '5.1.1 User unknown')).toBe('recipient_rejected');
    expect(
      classifyReply(
        'sender',
        550,
        '5.7.60 SMTP; Client does not have permissions to send as this sender',
      ),
    ).toBe('sender_rejected');
    expect(classifyReply('recipient', 451, '4.7.1 Try again later')).toBe('temporary');
    expect(classifyReply('recipient', 450, '4.7.1 Too many messages, rate limit exceeded')).toBe(
      'limit',
    );
    expect(classifyReply('recipient', 452, '4.5.3 Too many recipients')).toBe('limit');
    expect(classifyReply('greeting', 421, 'Service not available')).toBe('temporary');
    expect(classifyReply('tls', 502, 'not implemented')).toBe('starttls');
    expect(classifyReply('data', 554, 'message rejected as spam')).toBe('data');
  });

  it('cleans the server text: control characters, the password and base64 blobs never reach the log', () => {
    expect(serverText('535 bad\r\nlogin\x00 for hunter2-secret', 'hunter2-secret')).toBe(
      '535 bad login for ***',
    );
    expect(serverText(`334 ${Buffer.alloc(60, 7).toString('base64')}`)).toBe('334 ***');
    expect(serverText('relay denied '.repeat(100)).length).toBe(300);
    expect(serverText(undefined)).toBe('');
  });
});
