import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

function sandbox(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'arklock-scan-'));
  mkdirSync(path.join(dir, 'scripts'));
  for (const f of ['check-private-data.mjs', 'private-data.allow']) {
    copyFileSync(path.join(root, 'scripts', f), path.join(dir, 'scripts', f));
  }
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

const run = (dir: string) =>
  spawnSync('node', ['scripts/check-private-data.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PRIVATE_DENY_FILE: path.join(dir, 'none.txt') },
  });

describe('check-private-data', () => {
  it('passes a clean tree', () => {
    const r = run(sandbox({ 'a.md': 'see https://example.com and 127.0.0.1' }));
    expect(r.status).toBe(0);
  });

  it('flags private domains, e-mails, IPs, keys and env files', () => {
    const r = run(
      sandbox({
        'a.txt': 'host corp.acme.ru ip 10.1.2.3 mail ivan@acme.ru',
        'b.txt': '-----BEGIN PRIVATE KEY-----',
        '.env': 'X=1',
      }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('corp.acme.ru');
    expect(r.stderr).toContain('10.1.2.3');
    expect(r.stderr).toContain('acme.ru');
    expect(r.stderr).toContain('приватный ключ');
    expect(r.stderr).toContain('запрещённый файл');
  });

  it('applies the optional extra deny list', () => {
    const dir = sandbox({ 'a.txt': 'contains Secret-Codename here' });
    const deny = path.join(dir, '..', `deny-${path.basename(dir)}.txt`);
    writeFileSync(deny, 'secret-codename\n');
    const r = spawnSync('node', ['scripts/check-private-data.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PRIVATE_DENY_FILE: deny },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('дополнительного списка');
  });
});
