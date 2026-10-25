/** Разбор строк журнала служб (JSON приложения, журнал базы данных, обычный текст) для фильтрации и подсветки. */
export type LogLevel = 'error' | 'warn' | 'info';
export interface LogLine {
  /** Время в миллисекундах, если оно есть в строке. */
  at: number | null;
  level: LogLevel;
  text: string;
  raw: string;
}

const ISO =
  /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2}| [A-Z]{2,5})?)\]?\s*/;

export function levelOfText(s: string): LogLevel {
  if (/\b(ERROR|FATAL|PANIC|CRITICAL)\b/i.test(s)) return 'error';
  if (/\bWARN(ING)?\b/i.test(s)) return 'warn';
  return 'info';
}

export function parseLogLine(raw: string): LogLine {
  const line = raw.replace(/\r$/, '');
  // журнал приложения: по объекту JSON на строку (уровни pino: 50+ ошибка, 40 предупреждение)
  const brace = line.indexOf('{');
  if (brace >= 0 && line.trimEnd().endsWith('}')) {
    try {
      const o = JSON.parse(line.slice(brace)) as Record<string, unknown>;
      const lv = typeof o.level === 'number' ? o.level : null;
      const level: LogLevel =
        lv !== null ? (lv >= 50 ? 'error' : lv >= 40 ? 'warn' : 'info') : levelOfText(line);
      const t =
        typeof o.time === 'number' ? o.time : typeof o.time === 'string' ? Date.parse(o.time) : NaN;
      const msg =
        typeof o.msg === 'string' ? o.msg : typeof o.message === 'string' ? o.message : '';
      const rest = Object.entries(o)
        .filter(([k]) => !['level', 'time', 'msg', 'message', 'pid', 'hostname'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(' ');
      return {
        at: Number.isNaN(t) ? null : t,
        level,
        text: [msg, rest].filter(Boolean).join(' · ') || line,
        raw: line,
      };
    } catch {
      /* не JSON: разбирается как текст */
    }
  }
  const m = ISO.exec(line.replace(/^\S+\s+\|\s+/, ''));
  const at = m ? Date.parse(m[1]!.replace(' ', 'T').replace(',', '.')) : NaN;
  return { at: Number.isNaN(at) ? null : at, level: levelOfText(line), text: line, raw: line };
}

export function parseLog(text: string): LogLine[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map(parseLogLine);
}
