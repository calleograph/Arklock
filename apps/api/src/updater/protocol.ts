import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateStatus, UpdatesOverview } from '@arklock/contracts';

/** Ошибка приёма загруженной копии; code — причина для ответа API. */
export class BackupUploadError extends Error {
  constructor(readonly code: 'too_large' | 'empty' | 'write_failed') {
    super(code);
  }
}

/**
 * Обмен с помощником обновлений через каталог. Веб-приложение:
 *   • пишет ТОЛЬКО request.txt (простые строки key=value, значения проверены схемой);
 *   • читает status.json, remote.json, helper.json, history.jsonl, написанные помощником.
 * Docker, shell и привилегии хоста приложению не нужны. Файлы, не являющиеся обычными (ссылки и т.п.), игнорируются.
 */
const MAX_FILE = 400 * 1024;
const HEARTBEAT_MAX_AGE_MS = 40_000;

export type HelperAction =
  | 'check'
  | 'update'
  | 'rollback'
  | 'backup'
  | 'backup_verify'
  | 'backup_delete'
  | 'backup_export'
  | 'backup_import'
  | 'restore'
  | 'logs'
  | 'schedule'
  | 'offsite_import'
  | 'offsite_test'
  | 'offsite_push'
  | 'offsite_pull'
  | 'offsite_verify'
  | 'offsite_delete'
  | 'offsite_refresh'
  | 'offsite_clear';

export interface UpdaterRequest {
  action: HelperAction;
  version?: string;
  withRestore?: boolean;
  file?: string;
  label?: string;
  service?: 'app' | 'db';
  lines?: number;
  schedule?: { enabled: boolean; hour: number; keep: number };
  by: string;
}

export interface ContainerSnapshot {
  at: string | null;
  items: {
    service: string;
    image: string;
    state: string;
    health: string;
    startedAt: string;
    restarts: number;
    cpu: string;
    memory: string;
  }[];
}

export interface BackupSnapshot {
  dir: string;
  freeGiB: number;
  items: {
    name: string;
    size: number;
    createdAt: string;
    sha256: string;
    version: string;
    migrations: number;
  }[];
}

/** Удалённое хранилище копий (S3 / SMB): настройка без секретов, итог последней отправки и список копий на хранилище. */
export interface OffsiteSnapshot {
  configured: boolean;
  type: '' | 's3' | 'smb';
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  host: string;
  share: string;
  user: string;
  auto: boolean;
  keep: number;
  lastAt: string;
  lastResult: string;
  lastFile: string;
  lastError: string;
  listedAt: string;
  listError: string;
  items: { name: string; size: number }[];
}

export interface ScheduleSnapshot {
  enabled: boolean;
  hour: number;
  keep: number;
  lastAt: string;
  lastResult: string;
}

export const BACKUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.bak\.gpg$/;

const IDLE: UpdateStatus = {
  state: 'idle',
  action: null,
  requestId: null,
  stepNo: 0,
  stepTotal: 0,
  stepName: '',
  startedAt: null,
  finishedAt: null,
  result: null,
  message: null,
  versionFrom: null,
  versionTo: null,
};

async function readSafe(file: string): Promise<string | null> {
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  const text = await readSafe(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, 2000) : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class RequestPendingError extends Error {
  constructor() {
    super('another request is pending');
  }
}

export class UpdaterChannel {
  private lastBeat = 0;

  constructor(private readonly dir: string) {}

  get configured(): boolean {
    return this.dir !== '';
  }

  private p(name: string): string {
    return path.join(this.dir, name);
  }

  async status(): Promise<UpdateStatus> {
    const raw = await readJson<Record<string, unknown>>(this.p('status.json'));
    if (!raw) return IDLE;
    const state = raw.state;
    return {
      state: state === 'running' || state === 'success' || state === 'failed' ? state : 'idle',
      action: str(raw.action),
      requestId: str(raw.request_id),
      stepNo: num(raw.step_no),
      stepTotal: num(raw.step_total),
      stepName: str(raw.step_name) ?? '',
      startedAt: str(raw.started_at),
      finishedAt: str(raw.finished_at),
      result: str(raw.result),
      message: str(raw.message),
      versionFrom: str(raw.version_from),
      versionTo: str(raw.version_to),
    };
  }

  async pending(): Promise<boolean> {
    try {
      await lstat(this.p('request.txt'));
      return true;
    } catch {
      return false;
    }
  }

  async overview(installed: UpdatesOverview['installed']): Promise<UpdatesOverview> {
    const [status, pending, hb, remote, historyText] = await Promise.all([
      this.status(),
      this.pending(),
      readJson<Record<string, unknown>>(this.p('helper.json')),
      readJson<Record<string, unknown>>(this.p('remote.json')),
      readSafe(this.p('history.jsonl')),
    ]);
    // Журнал этапов обновления (вывод update.sh): последние строки, без служебных отметок ARKLOCK_STEP
    const updateLog = ((await readSafe(this.p('update.log'))) ?? '')
      .split('\n')
      .filter((l) => !l.startsWith('ARKLOCK_STEP '))
      .slice(-400)
      .join('\n');
    // Пульс пишется помощником атомарно, но чтение может совпасть с заменой файла: берём последнее прочитанное значение
    if (hb && typeof hb.ts === 'number') this.lastBeat = hb.ts * 1000;
    else if (
      !(await lstat(this.p('helper.json')).then(
        () => true,
        () => false,
      ))
    )
      this.lastBeat = 0;
    const ts = this.lastBeat;
    const alive = ts > 0 && Date.now() - ts < HEARTBEAT_MAX_AGE_MS;
    const history = (historyText ?? '')
      .split('\n')
      .filter(Boolean)
      .slice(-50)
      .reverse()
      .flatMap((line) => {
        try {
          const h = JSON.parse(line) as Record<string, unknown>;
          return [
            {
              at: str(h.at) ?? '',
              action: str(h.action) ?? '',
              result: str(h.result) ?? '',
              versionFrom: str(h.version_from),
              versionTo: str(h.version_to),
              message: str(h.message),
            },
          ];
        } catch {
          return [];
        }
      });
    const rs = remote?.status;
    return {
      installed,
      helper: {
        configured: this.configured,
        alive,
        lastSeenAt: ts ? new Date(ts).toISOString() : null,
      },
      remote: remote
        ? {
            checkedAt: str(remote.checked_at),
            status:
              rs === 'available' || rs === 'up_to_date' || rs === 'unreachable' ? rs : 'unknown',
            latest: str(remote.latest),
            changelog: str(remote.changelog) ?? '',
            migrations: typeof remote.migrations === 'number' ? remote.migrations : null,
          }
        : null,
      status,
      history,
      updateLog,
      pending,
    };
  }

  /** Снимки состояния, публикуемые помощником (только для чтения). */
  async containers(): Promise<ContainerSnapshot> {
    const raw = await readJson<Record<string, unknown>>(this.p('containers.json'));
    const items = Array.isArray(raw?.items) ? (raw.items as Record<string, unknown>[]) : [];
    return {
      at: str(raw?.at),
      items: items.map((i) => ({
        service: str(i.service) ?? '',
        image: str(i.image) ?? '',
        state: str(i.state) ?? '',
        health: str(i.health) ?? '',
        startedAt: str(i.started_at) ?? '',
        restarts: num(i.restarts),
        cpu: str(i.cpu) ?? '',
        memory: str(i.memory) ?? '',
      })),
    };
  }

  async backups(): Promise<BackupSnapshot | null> {
    const raw = await readJson<Record<string, unknown>>(this.p('backups.json'));
    if (!raw) return null;
    const items = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
    return {
      dir: str(raw.dir) ?? '',
      freeGiB: num(raw.free_gib),
      items: items
        .map((i) => ({
          name: str(i.name) ?? '',
          size: num(i.size),
          createdAt: str(i.created_at) ?? '',
          sha256: str(i.sha256) ?? '',
          version: str(i.version) ?? '',
          migrations: num(i.migrations),
        }))
        .filter((i) => BACKUP_NAME_RE.test(i.name) && !i.name.includes('..')),
    };
  }

  async offsite(): Promise<OffsiteSnapshot | null> {
    const raw = await readJson<Record<string, unknown>>(this.p('offsite.json'));
    if (!raw) return null;
    const items = Array.isArray(raw.items) ? (raw.items as Record<string, unknown>[]) : [];
    const type = raw.type === 's3' || raw.type === 'smb' ? raw.type : '';
    return {
      configured: raw.configured === true,
      type,
      endpoint: str(raw.endpoint) ?? '',
      region: str(raw.region) ?? '',
      bucket: str(raw.bucket) ?? '',
      prefix: str(raw.prefix) ?? '',
      host: str(raw.host) ?? '',
      share: str(raw.share) ?? '',
      user: str(raw.user) ?? '',
      auto: raw.auto === true,
      keep: num(raw.keep) || 14,
      lastAt: str(raw.last_at) ?? '',
      lastResult: str(raw.last_result) ?? '',
      lastFile: str(raw.last_file) ?? '',
      lastError: str(raw.last_error) ?? '',
      listedAt: str(raw.listed_at) ?? '',
      listError: str(raw.list_error) ?? '',
      items: items
        .map((i) => ({ name: str(i.name) ?? '', size: num(i.size) }))
        .filter((i) => BACKUP_NAME_RE.test(i.name) && !i.name.includes('..')),
    };
  }

  /**
   * Передаёт помощнику настройку удалённого хранилища. Файл создаётся с правами 600 и содержит значения в base64;
   * помощник переносит его в свой закрытый каталог и стирает. В базе данных Arklock секреты не хранятся.
   */
  async writeOffsiteConfig(values: Record<string, string>): Promise<void> {
    const lines = Object.entries(values).map(
      ([k, v]) => `${k}=${Buffer.from(v, 'utf8').toString('base64')}`,
    );
    const tmp = this.p(`.offsite.${randomUUID()}`);
    await writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    await rename(tmp, this.p('offsite-config.in'));
  }

  /**
   * Принимает загруженную резервную копию в каталог обмена потоком: в памяти файл не держится, размер ограничен.
   * Помощник переносит файл в каталог копий и проверяет его ключом этого сервера. Возвращает имя файла.
   */
  async acceptBackupUpload(input: Readable, maxBytes: number): Promise<string> {
    if (!this.configured) throw new Error('updater channel is not configured');
    const inbox = this.p('inbox');
    await mkdir(inbox, { recursive: true, mode: 0o770 });
    const name = `upload-${randomUUID()}.bak.gpg`;
    const dest = path.join(inbox, name);
    let total = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        if (total > maxBytes) cb(new BackupUploadError('too_large'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(input, limit, createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
    } catch (e) {
      await unlink(dest).catch(() => undefined);
      throw e instanceof BackupUploadError ? e : new BackupUploadError('write_failed');
    }
    if (total === 0) {
      await unlink(dest).catch(() => undefined);
      throw new BackupUploadError('empty');
    }
    return name;
  }

  /** Удаляет принятый, но не переданный помощнику файл (например, если операция не запущена). */
  async discardBackupUpload(name: string): Promise<void> {
    await unlink(path.join(this.p('inbox'), name)).catch(() => undefined);
  }

  async removeOffsiteConfig(): Promise<void> {
    await unlink(this.p('offsite-config.in')).catch(() => undefined);
  }

  async schedule(): Promise<ScheduleSnapshot> {
    const raw = await readJson<Record<string, unknown>>(this.p('schedule.json'));
    return {
      enabled: raw?.enabled === true,
      hour: num(raw?.hour),
      keep: num(raw?.keep) || 14,
      lastAt: str(raw?.last_at) ?? '',
      lastResult: str(raw?.last_result) ?? '',
    };
  }

  async logs(): Promise<{ service: string; text: string; at: string | null } | null> {
    const file = this.p('logs.txt');
    const text = await readSafe(file);
    if (text === null) return null;
    const svc = ((await readSafe(this.p('logs.service'))) ?? '').trim();
    const st = await lstat(file);
    return { service: svc === 'db' ? 'db' : 'app', text, at: st.mtime.toISOString() };
  }

  /** Путь подготовленной к скачиванию копии (имя проверено шаблоном; обычный файл, не ссылка). */
  async exportedBackup(name: string): Promise<{ path: string; size: number } | null> {
    if (!BACKUP_NAME_RE.test(name) || name.includes('..')) return null;
    const file = path.join(this.dir, 'export', name);
    try {
      const st = await lstat(file);
      return st.isFile() ? { path: file, size: st.size } : null;
    } catch {
      return null;
    }
  }

  /** Постановка запроса. Возвращает идентификатор запроса. Одновременно допускается один запрос. */
  async submit(req: UpdaterRequest): Promise<string> {
    const requestId = randomUUID();
    const lines = [
      `request_id=${requestId}`,
      `action=${req.action}`,
      `by=${req.by}`,
      `at=${new Date().toISOString()}`,
    ];
    if (req.version) lines.push(`version=${req.version}`);
    if (req.file) lines.push(`file=${req.file}`);
    if (req.label) lines.push(`label=${req.label}`);
    if (req.service) lines.push(`service=${req.service}`);
    if (req.lines) lines.push(`lines=${req.lines}`);
    if (req.schedule) {
      lines.push(`schedule_enabled=${req.schedule.enabled ? 1 : 0}`);
      lines.push(`schedule_hour=${req.schedule.hour}`);
      lines.push(`schedule_keep=${req.schedule.keep}`);
    }
    if (req.action === 'rollback') lines.push(`with_restore=${req.withRestore ? 1 : 0}`);
    const tmp = this.p(`.req.${requestId}`);
    await writeFile(tmp, lines.join('\n') + '\n', { mode: 0o644, flag: 'wx' });
    try {
      // link() атомарно создаёт request.txt и не перезаписывает уже существующий запрос.
      await link(tmp, this.p('request.txt'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new RequestPendingError();
      throw err;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
    return requestId;
  }
}
