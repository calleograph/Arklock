import {
  encryptEntry,
  generatePassphrase,
  generatePassword,
  parseTotpInput,
  totp,
  totpRemaining,
} from '@arklock/crypto';
import type { KdfParams } from '@arklock/crypto';
import {
  CliError,
  loadEntries,
  openAccount,
  type Credentials,
  type Entry,
  type Opened,
} from './session.js';

export interface Config {
  server?: string;
  token?: string;
  /** Зафиксированное состояние журнала ключей (защита от подмены ключей сервером). */
  pin?: { seq: number; hash: string };
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  loadConfig: () => Config;
  saveConfig: (c: Config) => void;
  /** Запрос скрытого ввода (мастер-пароль); null, если ввод невозможен. */
  ask?: (prompt: string, hidden: boolean) => Promise<string | null>;
  fetchFn?: typeof fetch;
  kdfFloor?: KdfParams;
}

export const HELP = `Arklock — командная строка

Использование: arklock <команда> [параметры]

  config --server URL --token akt_…   сохранить адрес сервера и токен API
  login  --server URL --email EMAIL    войти по паролю (и коду второго фактора)
  logout                               забыть сохранённые данные
  whoami                               кто вошёл и что видно
  vaults                               список хранилищ
  list   [-q текст] [--vault имя] [--json]
  get    <запись> [--field поле] [--vault имя] [--json]
  totp   <запись> [--vault имя]        текущий код TOTP
  add    --title T [--username U] [--password P | --generate] [--url URL]
         [--notes N] [--vault имя] [--folder путь/к/папке]
  generate [--length N] [--phrase]     пароль или парольная фраза

Мастер-пароль берётся из переменной ARKLOCK_PASSWORD либо запрашивается; он не покидает этот компьютер.
Адрес и токен можно задать переменными ARKLOCK_SERVER и ARKLOCK_TOKEN.
`;

interface Parsed {
  cmd: string;
  pos: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN = new Set(['json', 'generate', 'phrase', 'help']);

export function parseArgs(argv: string[]): Parsed {
  const [cmd = 'help', ...rest] = argv;
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '-q') {
      flags.set('q', rest[++i] ?? '');
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) flags.set(name, a.slice(eq + 1));
      else if (BOOLEAN.has(name)) flags.set(name, true);
      else flags.set(name, rest[++i] ?? '');
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

const str = (p: Parsed, name: string): string | undefined => {
  const v = p.flags.get(name);
  return typeof v === 'string' ? v : undefined;
};

function credentials(io: Io): Credentials {
  const cfg = io.loadConfig();
  const server = io.env.ARKLOCK_SERVER ?? cfg.server;
  const token = io.env.ARKLOCK_TOKEN ?? cfg.token;
  if (!server || !token)
    throw new CliError('Not configured. Run: arklock config --server URL --token akt_…');
  return { server, token };
}

async function password(io: Io): Promise<string> {
  const fromEnv = io.env.ARKLOCK_PASSWORD;
  if (fromEnv) return fromEnv;
  const typed = await io.ask?.('Master password: ', true);
  if (!typed)
    throw new CliError('Master password required (set ARKLOCK_PASSWORD or run in a terminal)');
  return typed;
}

async function open(io: Io): Promise<Opened> {
  const cfg = io.loadConfig();
  const o = await openAccount(credentials(io), await password(io), {
    fetchFn: io.fetchFn,
    kdfFloor: io.kdfFloor,
    pin: cfg.pin ?? null,
  });
  // фиксируем состояние журнала ключей (только вперёд)
  if (o.keyLogTip && (!cfg.pin || o.keyLogTip.seq >= cfg.pin.seq)) {
    io.saveConfig({ ...cfg, pin: o.keyLogTip });
  }
  return o;
}

function pickVaults(o: Opened, name?: string) {
  const list = o.vaults.filter((v) => v.key && !v.problem);
  if (!name) return list;
  const hit = list.filter(
    (v) =>
      (v.info.kind === 'locker' ? 'locker' : (v.info.name ?? '')).toLowerCase() ===
      name.toLowerCase(),
  );
  if (!hit.length) throw new CliError(`Vault not found: ${name}`);
  return hit;
}

async function allEntries(o: Opened, vaultName?: string): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const v of pickVaults(o, vaultName)) out.push(...(await loadEntries(o, v)));
  return out;
}

function find(entries: Entry[], query: string): Entry {
  const exactId = entries.find((e) => e.id === query);
  if (exactId) return exactId;
  const q = query.toLowerCase();
  const exact = entries.filter((e) => e.title.toLowerCase() === q);
  const hits = exact.length ? exact : entries.filter((e) => e.title.toLowerCase().includes(q));
  if (!hits.length) throw new CliError(`Nothing found: ${query}`);
  if (hits.length > 1)
    throw new CliError(
      `Several entries match "${query}":\n${hits.map((e) => `  ${e.id}  ${e.vaultName}/${e.folder}  ${e.title}`).join('\n')}\nSpecify an id or --vault.`,
    );
  return hits[0]!;
}

function field(e: Entry, name: string): string {
  switch (name) {
    case 'password':
      return e.password;
    case 'username':
    case 'login':
      return e.username;
    case 'url':
      return e.url;
    case 'notes':
      return e.notes;
    case 'title':
      return e.title;
    case 'totp':
      return e.totp;
    default: {
      const f = e.fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!f) throw new CliError(`No such field: ${name}`);
      return f.value;
    }
  }
}

/** Точка входа: возвращает код выхода. Ошибки печатаются без трассировок и без секретов. */
export async function run(argv: string[], io: Io): Promise<number> {
  const p = parseArgs(argv);
  try {
    switch (p.cmd) {
      case 'help':
      case '--help':
      case '-h':
        io.out(HELP);
        return 0;

      case 'generate': {
        const length = Number(str(p, 'length') ?? 20);
        io.out(
          (p.flags.has('phrase')
            ? generatePassphrase({ words: Number(str(p, 'length') ?? 5) })
            : generatePassword({ length })) + '\n',
        );
        return 0;
      }

      case 'config': {
        const server = str(p, 'server');
        const token = str(p, 'token');
        if (!server || !token)
          throw new CliError('Usage: arklock config --server URL --token akt_…');
        if (!/^akt_[A-Za-z0-9_-]{43}$/.test(token))
          throw new CliError('That is not an Arklock API token');
        if (!/^https?:\/\//.test(server))
          throw new CliError(
            'The server address must start with https:// (or http:// for local tests)',
          );
        io.saveConfig({ ...io.loadConfig(), server, token });
        io.out('Saved.\n');
        return 0;
      }

      case 'login': {
        const server = str(p, 'server') ?? io.env.ARKLOCK_SERVER ?? io.loadConfig().server;
        const email = str(p, 'email');
        if (!server || !email)
          throw new CliError('Usage: arklock login --server URL --email EMAIL');
        const { deriveMasterKeys, fromBase64Url, toBase64Url, MIN_KDF } =
          await import('@arklock/crypto');
        const f = io.fetchFn ?? fetch;
        const base = `${server.replace(/\/$/, '')}/api/v1`;
        const params = (await (
          await f(`${base}/auth/params?email=${encodeURIComponent(email)}`)
        ).json()) as {
          salt: string;
          kdf: KdfParams;
          userId: string;
        };
        const keys = await deriveMasterKeys(
          await password(io),
          fromBase64Url(params.salt),
          params.userId,
          params.kdf,
          io.kdfFloor ?? MIN_KDF,
        );
        const post = async (path: string, body: unknown) => {
          const r = await f(`${base}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          return {
            status: r.status,
            json: (await r.json().catch(() => null)) as Record<string, unknown> | null,
          };
        };
        let res = await post('/auth/login', { email, authKey: toBase64Url(keys.authKey) });
        keys.authKey.fill(0);
        keys.wrapKey.fill(0);
        if (res.status !== 200) throw new CliError('Invalid email or password');
        if (res.json?.mfaRequired) {
          const code = io.env.ARKLOCK_MFA_CODE ?? (await io.ask?.('Two-factor code: ', false));
          if (!code) throw new CliError('Two-factor code required (ARKLOCK_MFA_CODE)');
          res = await post('/auth/mfa/verify', { challenge: res.json.challenge, code });
          if (res.status !== 200) throw new CliError('The code is invalid or already used');
        }
        io.saveConfig({ ...io.loadConfig(), server, token: String(res.json?.token) });
        io.out('Signed in. The session token was saved.\n');
        return 0;
      }

      case 'logout': {
        const cfg = io.loadConfig();
        io.saveConfig({ server: cfg.server });
        io.out('Credentials removed.\n');
        return 0;
      }

      case 'whoami': {
        const o = await open(io);
        io.out(`${o.user.displayName} <${o.user.email}>\n`);
        for (const v of o.vaults)
          io.out(
            `  ${v.info.kind === 'locker' ? 'locker' : v.info.name}  [${v.info.role}]${v.problem ? '  (' + v.problem + ')' : ''}\n`,
          );
        return 0;
      }

      case 'vaults': {
        const o = await open(io);
        for (const v of o.vaults)
          io.out(
            `${v.info.kind === 'locker' ? 'locker' : v.info.name}\t${v.info.role}\t${v.problem ?? 'ok'}\n`,
          );
        return 0;
      }

      case 'list': {
        const o = await open(io);
        const q = (str(p, 'q') ?? '').toLowerCase();
        const items = (await allEntries(o, str(p, 'vault')))
          .filter(
            (e) =>
              !q ||
              `${e.title} ${e.username} ${e.url} ${e.tags.join(' ')}`.toLowerCase().includes(q),
          )
          .sort((a, b) => a.title.localeCompare(b.title));
        if (p.flags.has('json'))
          io.out(
            JSON.stringify(
              items.map((e) => ({
                id: e.id,
                vault: e.vaultName,
                folder: e.folder,
                title: e.title,
                username: e.username,
                url: e.url,
                tags: e.tags,
              })),
              null,
              2,
            ) + '\n',
          );
        else
          for (const e of items)
            io.out(
              `${e.id}\t${e.vaultName}${e.folder ? '/' + e.folder : ''}\t${e.title}\t${e.username}\n`,
            );
        return 0;
      }

      case 'get': {
        if (!p.pos[0]) throw new CliError('Usage: arklock get <entry> [--field password]');
        const o = await open(io);
        const e = find(await allEntries(o, str(p, 'vault')), p.pos[0]);
        const f = str(p, 'field');
        if (p.flags.has('json')) io.out(JSON.stringify(e, null, 2) + '\n');
        else if (f) io.out(field(e, f) + '\n');
        else {
          io.out(
            `${e.title}\n  vault: ${e.vaultName}${e.folder ? '/' + e.folder : ''}\n  username: ${e.username}\n  url: ${e.url}\n`,
          );
          io.out('  password: (use --field password)\n');
          for (const x of e.fields) io.out(`  ${x.name}: ${x.secret ? '(secret)' : x.value}\n`);
        }
        return 0;
      }

      case 'totp': {
        if (!p.pos[0]) throw new CliError('Usage: arklock totp <entry>');
        const o = await open(io);
        const e = find(await allEntries(o, str(p, 'vault')), p.pos[0]);
        if (!e.totp) throw new CliError('This entry has no TOTP secret');
        const params = parseTotpInput(e.totp);
        io.out(`${await totp(params)}\n`);
        io.err(`valid for ${totpRemaining(params.period ?? 30)} s\n`);
        return 0;
      }

      case 'add': {
        const title = str(p, 'title');
        if (!title)
          throw new CliError(
            'Usage: arklock add --title T [--username U] [--password P | --generate]',
          );
        const o = await open(io);
        const targets = pickVaults(o, str(p, 'vault') ?? 'locker');
        const v = targets[0]!;
        if (!['owner', 'admin', 'editor'].includes(v.info.role))
          throw new CliError('You cannot add entries to this vault');
        let branchId: string | null = null;
        const folder = str(p, 'folder');
        if (folder) {
          const { decryptBranchName } = await import('@arklock/crypto');
          const tree = await o.api.call<{
            branches: {
              id: string;
              parentId: string | null;
              nameCipher: string;
              keyVersion: number;
            }[];
          }>('GET', `/vaults/${v.info.id}/tree`);
          let parent: string | null = null;
          for (const part of folder.split('/').filter(Boolean)) {
            let found: string | null = null;
            for (const b of tree.branches.filter((x) => x.parentId === parent)) {
              if (
                (await decryptBranchName(b.nameCipher, v.key!, v.info.id, b.id, b.keyVersion).catch(
                  () => '',
                )) === part
              )
                found = b.id;
            }
            if (!found) throw new CliError(`Folder not found: ${part}`);
            parent = found;
          }
          branchId = parent;
        }
        const pw = p.flags.has('generate')
          ? generatePassword({ length: Number(str(p, 'length') ?? 20) })
          : (str(p, 'password') ?? io.env.ARKLOCK_ENTRY_PASSWORD ?? '');
        const id = crypto.randomUUID();
        const payload = {
          kind: 'login',
          title,
          username: str(p, 'username') ?? '',
          password: pw,
          url: str(p, 'url') ?? '',
          notes: str(p, 'notes') ?? '',
          totp: '',
          fields: [],
          tags: [],
          passwordChangedAt: new Date().toISOString(),
        };
        const enc = await encryptEntry(payload, v.key!, v.info.id, id, v.info.keyVersion);
        await o.api.call('POST', `/vaults/${v.info.id}/entries`, { id, branchId, ...enc });
        io.out(`${id}\n`);
        if (p.flags.has('generate'))
          io.err('Password generated; read it with: arklock get <entry> --field password\n');
        return 0;
      }

      default:
        io.err(`Unknown command: ${p.cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    io.err(
      `${e instanceof CliError ? e.message : 'Error: ' + (e instanceof Error ? e.message : String(e))}\n`,
    );
    return e instanceof CliError ? e.exitCode : 1;
  }
}
