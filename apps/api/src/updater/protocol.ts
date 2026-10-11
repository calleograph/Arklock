import { randomUUID } from 'node:crypto';
import { link, lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { UpdateStatus, UpdatesOverview } from '@arklock/contracts';

/**
 * Обмен с помощником обновлений через каталог. Веб-приложение:
 *   • пишет ТОЛЬКО request.txt (простые строки key=value, значения проверены схемой);
 *   • читает status.json, remote.json, helper.json, history.jsonl, написанные помощником.
 * Docker, shell и привилегии хоста приложению не нужны. Файлы, не являющиеся обычными (ссылки и т.п.), игнорируются.
 */
const MAX_FILE = 256 * 1024;
const HEARTBEAT_MAX_AGE_MS = 40_000;

export interface UpdaterRequest {
  action: 'check' | 'update' | 'rollback';
  version?: string;
  withRestore?: boolean;
  by: string;
}

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
    const ts = hb && typeof hb.ts === 'number' ? hb.ts * 1000 : 0;
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
      pending,
    };
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
