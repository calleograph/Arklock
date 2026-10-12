import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — учебный сервер без типов
import { startS3 } from './mock-s3.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'scripts', 'remote.sh');
const haveTools = ['bash', 'openssl', 'curl', 'base64', 'sha256sum'].every(
  (c) => spawnSync(c, ['--version'], { encoding: 'utf8' }).error === undefined,
);

const ACCESS = 'AKIATESTACCESSKEY1';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYsecretvalue';
const BUCKET = 'arklock-backups';
const REGION = 'eu-test-1';
const N = (d: string) => `arklock-${d}T010000Z-v0.1.0.bak.gpg`;

interface Mock {
  port: number;
  close: () => void;
  objects: Map<string, { body: Buffer; meta?: string }>;
  uploads: Map<string, unknown>;
  log: string[];
  state: { failNext: number; failWhen: ((line: string) => boolean) | null };
}
let s3: Mock;
let dir: string;
let conf: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Запуск сценария. Асинхронный: учебный S3-сервер живёт в этом же процессе, и блокирующий spawnSync
 * не давал бы ему отвечать.
 */
function run(
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [script, ...args], {
      env: {
        ...process.env,
        ARKLOCK_REMOTE_CONF: conf,
        ARKLOCK_REMOTE_PART_MIB: '1',
        ARKLOCK_REMOTE_SINGLE_MAX_MIB: '1',
        TMPDIR: dir,
        ...extra,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: stdout + stderr, stdout });
    });
  });
}

const configure = (over: Record<string, string> = {}) =>
  run(['configure', '--from-env'], {
    ARKLOCK_REMOTE_TYPE: 's3',
    ARKLOCK_REMOTE_S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
    ARKLOCK_REMOTE_S3_REGION: REGION,
    ARKLOCK_REMOTE_S3_BUCKET: BUCKET,
    ARKLOCK_REMOTE_PREFIX: 'srv1',
    ARKLOCK_REMOTE_S3_ACCESS_KEY: ACCESS,
    ARKLOCK_REMOTE_S3_SECRET_KEY: SECRET,
    ARKLOCK_REMOTE_ALLOW_HTTP: '1',
    ...over,
  });

function backupFile(name: string, size = 5000, fill = 7): string {
  const f = path.join(dir, name);
  const body = Buffer.alloc(size, fill);
  writeFileSync(f, body);
  writeFileSync(
    `${f}.json`,
    JSON.stringify({ file: name, size, sha256: sha(body), appVersion: '0.1.0' }, null, 2),
  );
  return f;
}

describe.skipIf(!haveTools)('remote backups: S3-compatible storage', () => {
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'arklock-remote-'));
    conf = path.join(dir, 'conf', 'remote.conf');
    mkdirSync(path.dirname(conf), { recursive: true });
    s3 = await startS3({
      bucket: BUCKET,
      accessKey: ACCESS,
      secretKey: SECRET,
      region: REGION,
      pageSize: 2,
    });
  });
  afterAll(() => s3.close());

  it('configuration is validated and the secret is never shown', async () => {
    expect((await configure({ ARKLOCK_REMOTE_PREFIX: '../etc' })).code).not.toBe(0);
    expect((await configure({ ARKLOCK_REMOTE_S3_BUCKET: 'Bad Bucket' })).code).not.toBe(0);
    expect((await configure({ ARKLOCK_REMOTE_ALLOW_HTTP: '0' })).code).not.toBe(0); // http без явного разрешения
    const ok = await configure();
    expect(ok.code, ok.out).toBe(0);
    const shown = await run(['show']);
    expect(shown.out).toContain('bucket=arklock-backups');
    expect(shown.out).toContain('секрет=задан');
    expect(shown.out).not.toContain(SECRET);
    expect(existsSync(conf)).toBe(true);
    expect(readFileSync(conf, 'utf8')).not.toContain(SECRET); // в файле только base64
    if (process.platform !== 'win32') expect(statSync(conf).mode & 0o777).toBe(0o600);
  });

  it('the connection test writes, reads back, compares and deletes a probe object', async () => {
    const r = await run(['test']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Соединение проверено');
    expect(s3.objects.size).toBe(0); // пробный объект удалён
    expect(s3.log.some((l) => l.startsWith('PUT '))).toBe(true);
    expect(s3.log.some((l) => l.startsWith('DELETE '))).toBe(true);
    expect(r.out).not.toContain(SECRET);
  });

  it('wrong credentials are reported without leaking them', async () => {
    await configure({ ARKLOCK_REMOTE_S3_SECRET_KEY: 'definitely-the-wrong-secret' });
    const r = await run(['test']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/SignatureDoesNotMatch|HTTP 403/);
    expect(r.out).not.toContain('definitely-the-wrong-secret');
    await configure();
  });

  it('push sends the copy and its description, then checks size and SHA-256 by reading it back', async () => {
    const f = backupFile(N('20261001'));
    const r = await run(['push', f]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('SHA-256 совпал');
    const obj = s3.objects.get(`srv1/${N('20261001')}`);
    expect(obj?.body.length).toBe(5000);
    expect(obj?.meta).toBe(sha(readFileSync(f)));
    expect(s3.objects.has(`srv1/${N('20261001')}.json`)).toBe(true);
    expect((await run(['verify', N('20261001')])).code).toBe(0);
  });

  it('a corrupted object on the storage is detected by verify and by pull', async () => {
    const name = N('20261001');
    const obj = s3.objects.get(`srv1/${name}`)!;
    const good = Buffer.from(obj.body);
    obj.body = Buffer.concat([good.subarray(0, 100), Buffer.from([1, 2, 3]), good.subarray(103)]);
    const v = await run(['verify', name]);
    expect(v.code).not.toBe(0);
    expect(v.out).toContain('SHA-256 не совпал');
    const dest = path.join(dir, 'pulled-bad');
    const p = await run(['pull', name, dest]);
    expect(p.code).not.toBe(0);
    expect(existsSync(path.join(dest, name))).toBe(false); // повреждённое не выдаётся за копию
    obj.body = good;
  });

  it('large copies are sent in parts and arrive identical', async () => {
    const big = path.join(dir, N('20261002'));
    const data = Buffer.alloc(3 * 1024 * 1024 + 120);
    for (let i = 0; i < data.length; i += 4) data.writeUInt32LE((i * 2654435761) >>> 0, i);
    writeFileSync(big, data);
    const before = s3.log.length;
    const r = await run(['push', big]);
    expect(r.code, r.out).toBe(0);
    const log = s3.log.slice(before);
    expect(log.some((l) => l.includes('uploads'))).toBe(true);
    expect(log.filter((l) => l.includes('partNumber=')).length).toBe(
      Math.ceil(data.length / (1024 * 1024)),
    );
    expect(sha(s3.objects.get(`srv1/${N('20261002')}`)!.body)).toBe(sha(data));
  });

  it('a failing part aborts the multipart upload and leaves no object behind', async () => {
    const bad = path.join(dir, N('20261003'));
    writeFileSync(bad, Buffer.alloc(2 * 1024 * 1024 + 5, 3));
    s3.state.failWhen = (l) => l.includes('partNumber=2');
    const r = await run(['push', bad]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/часть 2|HTTP 500|InternalError/);
    expect(s3.objects.has(`srv1/${N('20261003')}`)).toBe(false);
    expect(s3.uploads.size).toBe(0); // загрузка прервана, неполный объект не остался
  });

  it('list pages through the whole storage and prune keeps the newest copies of the project', async () => {
    for (const d of ['20261004', '20261005', '20261006']) {
      const r = await run(['push', backupFile(N(d), 2000, Number(d.slice(-1)))]);
      expect(r.code, r.out).toBe(0);
    }
    // чужая копия другого проекта не затрагивается
    s3.objects.set('srv1/other-20260101T000000Z-v0.1.0.bak.gpg', { body: Buffer.from('x') });
    const listed = (await run(['list'])).stdout
      .trim()
      .split('\n')
      .map((l) => l.split(' ')[0]);
    expect(listed.length).toBeGreaterThanOrEqual(6); // постраничный список: по 2 записи
    expect(listed).toContain(N('20261006'));
    expect(listed).toContain('other-20260101T000000Z-v0.1.0.bak.gpg');
    const r = await run(['prune', '2'], {
      COMPOSE_PROJECT_NAME: 'arklock',
      ARKLOCK_ENV: path.join(dir, 'none.env'),
    });
    expect(r.code, r.out).toBe(0);
    const left = [...s3.objects.keys()].filter((k) => k.endsWith('.bak.gpg')).sort();
    expect(left.filter((k) => k.includes('/arklock-'))).toEqual([
      `srv1/${N('20261005')}`,
      `srv1/${N('20261006')}`,
    ]);
    expect(left).toContain('srv1/other-20260101T000000Z-v0.1.0.bak.gpg');
    // описания удалённых копий тоже убраны
    expect([...s3.objects.keys()].filter((k) => k.includes('20261001'))).toEqual([]);
  });

  it('pull brings a copy to a fresh directory and checks it against the description', async () => {
    const dest = path.join(dir, 'new-server');
    const r = await run(['pull', N('20261006'), dest]);
    expect(r.code, r.out).toBe(0);
    const got = readFileSync(path.join(dest, N('20261006')));
    expect(sha(got)).toBe(sha(Buffer.alloc(2000, 6)));
    expect(existsSync(path.join(dest, `${N('20261006')}.json`))).toBe(true);
  });

  it('transient server errors fail the command instead of reporting success', async () => {
    s3.state.failNext = 1;
    const r = await run(['push', backupFile(N('20261007'))]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/HTTP 500|InternalError/);
  });

  it('delete removes a copy with its description; clear erases the configuration', async () => {
    const r = await run(['delete', N('20261006')]);
    expect(r.code, r.out).toBe(0);
    expect([...s3.objects.keys()].some((k) => k.includes('20261006'))).toBe(false);
    expect((await run(['clear'])).code).toBe(0);
    expect(existsSync(conf)).toBe(false);
    expect((await run(['list'])).code).not.toBe(0);
  });
});
