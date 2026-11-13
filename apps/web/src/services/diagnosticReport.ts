/** Отчёт диагностики: разбор ответа сервера в понятный текст и самодостаточный HTML-файл для выгрузки. */
type T = (key: string, params?: Record<string, unknown>) => string;
type Te = (key: string) => boolean;

export interface Finding {
  level: 'fail' | 'warn' | 'info';
  area: 'directory' | 'signin' | 'system';
  code: string;
  params?: Record<string, string | number | boolean>;
}
interface Stage {
  stage: string;
  ok: boolean;
  skipped?: boolean;
  warn?: boolean;
  code: string;
  params?: Record<string, string | number | boolean>;
  detail?: string;
  ms?: number;
}
export interface Report {
  at: string;
  app: {
    version: string;
    commit: string | null;
    builtAt: string | null;
    node: string;
    uptimeSec: number;
  };
  publicUrl: string | null;
  findings: Finding[];
  directories: {
    id: string;
    name: string;
    enabled: boolean;
    config: Record<string, string | number | boolean | string[]>;
    stages: Stage[] | null;
    stagesError: string | null;
  }[];
  accounts: { total: number; directory: number; waiting: number; blockedByDirectory: number };
  signin: {
    kind: 'directory' | 'local';
    login: string;
    reason: string;
    n: number;
    first: string;
    last: string;
  }[];
  events: { source: 'ledger' | 'security'; key: string; level: string; n: number; last: string }[];
  checks: { id: string; level: string; state: string; params?: Record<string, string | number> }[];
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const sysBase = (state: string) => `diag.${state.replace(/-/g, '_')}`;

/** Подпись недочёта и что делать; для проверок системы — тексты существующей диагностики. */
export function describeFinding(f: Finding, t: T, te: Te): { title: string; fix: string } {
  const p: Record<string, unknown> = { ...f.params };
  if (f.area === 'system') {
    const first = f.code.split('.')[0]!.replace(/-/g, '_');
    const base = sysBase(f.code);
    const part = (k: string) => (te(`${base}.${k}`) ? t(`${base}.${k}`, p) : '');
    return {
      title: [t(`diag.${first}.title`, p), part('detail')].filter(Boolean).join(': '),
      fix: part('fix'),
    };
  }
  if (typeof p.stage === 'string' && te(`dir.stage.${p.stage}`))
    p.stage = t(`dir.stage.${p.stage}`);
  p.detail = typeof p.detail === 'string' ? p.detail : '';
  const key = `diagrep.f.${f.code}`;
  return {
    title: te(`${key}.t`) ? t(`${key}.t`, p).trim() : f.code,
    fix: te(`${key}.f`) ? t(`${key}.f`, p) : '',
  };
}

export function stageText(s: Stage, t: T, te: Te): string {
  const key = `dir.result.${s.stage}.${s.code}`;
  const fallback = `dir.result.${s.stage}.ldap_error`;
  const params = { ...s.params };
  const text = te(key) ? t(key, params) : te(fallback) ? t(fallback, params) : s.code;
  return s.detail ? `${text} (${s.detail})` : text;
}

const CSS = `
:root{color-scheme:light dark;--bg:#f4f6fb;--card:#fff;--ink:#14213d;--mute:#5b6784;--line:#dfe4ee;--fail:#b42318;--failbg:#fef3f2;--warn:#a15c07;--warnbg:#fffaeb;--info:#175cd3;--infobg:#eff8ff;--ok:#067647}
@media (prefers-color-scheme:dark){:root{--bg:#0f1523;--card:#182034;--ink:#e6ebf7;--mute:#9aa6c3;--line:#2a3550;--fail:#fda29b;--failbg:#3b1a1a;--warn:#fec84b;--warnbg:#3a2e12;--info:#84caff;--infobg:#12304f;--ok:#75e0a7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 12px}
p.mute,.mute{color:var(--mute)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 12px}
.f{border-left:4px solid var(--info)}.f.fail{border-left-color:var(--fail);background:var(--failbg)}.f.warn{border-left-color:var(--warn);background:var(--warnbg)}.f.info{background:var(--infobg)}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid currentColor;margin-right:8px}
.fail .pill{color:var(--fail)}.warn .pill{color:var(--warn)}.info .pill{color:var(--info)}
.fix{margin:8px 0 0}.fix b{font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute)}tr:last-child td{border-bottom:0}
.ok{color:var(--ok)}.bad{color:var(--fail)}.wrn{color:var(--warn)}
code{font:13px ui-monospace,Menlo,Consolas,monospace}
@media (max-width:560px){main{padding:16px 16px 48px}}
`;

export function renderReportHtml(r: Report, t: T, te: Te, locale: string): string {
  const L = (k: string, p?: Record<string, unknown>) => t(`diagrep.html.${k}`, p);
  const when = (iso: string) => new Date(iso).toLocaleString(locale);
  const yn = (v: unknown) => (v ? L('yes') : L('no'));
  const counts = { fail: 0, warn: 0, info: 0 };
  for (const f of r.findings) counts[f.level] += 1;

  const findings = r.findings.length
    ? r.findings
        .map((f) => {
          const d = describeFinding(f, t, te);
          return `<div class="card f ${f.level}"><span class="pill">${esc(t(`diagrep.level.${f.level}`))}</span>${esc(d.title)}${
            d.fix ? `<p class="fix"><b>${esc(t('diagrep.fix'))}:</b> ${esc(d.fix)}</p>` : ''
          }</div>`;
        })
        .join('')
    : `<div class="card ok">${esc(L('nothing'))}</div>`;

  const cfgRows = (c: Report['directories'][number]['config']) =>
    Object.keys(c)
      .map((k) => {
        const v = c[k];
        const shown = Array.isArray(v)
          ? v.length
            ? v.map((x) => `<code>${esc(x)}</code>`).join('<br>')
            : L('none')
          : typeof v === 'boolean'
            ? yn(v)
            : k === 'access'
              ? esc(L(`accessValue.${v}`))
              : v === ''
                ? L('none')
                : `<code>${esc(v)}</code>`;
        return `<tr><td>${esc(L(`cfg.${k}`))}</td><td>${shown}</td></tr>`;
      })
      .join('');

  const dirs = r.directories.length
    ? r.directories
        .map((d) => {
          const stages = d.stages
            ? `<table><tr><th>${esc(L('col.stage'))}</th><th>${esc(L('col.result'))}</th></tr>${d.stages
                .map((s) => {
                  const cls = s.skipped ? 'mute' : s.ok ? (s.warn ? 'wrn' : 'ok') : 'bad';
                  return `<tr><td>${esc(te(`dir.stage.${s.stage}`) ? t(`dir.stage.${s.stage}`) : s.stage)}</td><td class="${cls}">${esc(stageText(s, t, te))}${
                    s.ms !== undefined ? ` <span class="mute">${s.ms} ms</span>` : ''
                  }</td></tr>`;
                })
                .join('')}</table>`
            : `<p class="mute">${esc(d.stagesError ?? L('stagesNone'))}</p>`;
          return `<h3>${esc(d.name)} <span class="mute">(${esc(d.id)})</span></h3><table><tr><th>${esc(L('col.param'))}</th><th>${esc(L('col.value'))}</th></tr>${cfgRows(d.config)}</table><h3>${esc(L('stages'))}</h3>${stages}`;
        })
        .join('')
    : `<p class="mute">${esc(L('stagesNone'))}</p>`;

  const reason = (x: string) => (te(`diagrep.reason.${x}`) ? t(`diagrep.reason.${x}`) : x);
  const signin = r.signin.length
    ? `<table><tr><th>${esc(L('col.login'))}</th><th>${esc(L('col.kind'))}</th><th>${esc(L('col.reason'))}</th><th>${esc(L('col.count'))}</th><th>${esc(L('col.last'))}</th></tr>${r.signin
        .map(
          (s) =>
            `<tr><td><code>${esc(s.login || '—')}</code></td><td>${esc(L(`kind.${s.kind}`))}</td><td>${esc(reason(s.reason))}</td><td>${s.n}</td><td>${esc(when(s.last))}</td></tr>`,
        )
        .join('')}</table>`
    : `<p class="mute">${esc(L('signinNone'))}</p>`;

  const events = r.events.length
    ? `<table><tr><th>${esc(L('col.event'))}</th><th>${esc(L('col.source'))}</th><th>${esc(L('col.level'))}</th><th>${esc(L('col.count'))}</th><th>${esc(L('col.last'))}</th></tr>${r.events
        .map(
          (e) =>
            `<tr><td><code>${esc(e.key)}</code></td><td>${esc(L(`source.${e.source}`))}</td><td>${esc(e.level)}</td><td>${e.n}</td><td>${esc(when(e.last))}</td></tr>`,
        )
        .join('')}</table>`
    : `<p class="mute">${esc(L('eventsNone'))}</p>`;

  const checks = `<table><tr><th>${esc(L('col.check'))}</th><th>${esc(L('col.result'))}</th></tr>${r.checks
    .map((c) => {
      const d = describeFinding(
        { level: 'info', area: 'system', code: c.state, params: { id: c.id, ...(c.params ?? {}) } },
        t,
        te,
      );
      const cls = c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'wrn' : 'bad';
      return `<tr><td>${esc(c.id)}</td><td class="${cls}">${esc(d.title)}</td></tr>`;
    })
    .join('')}</table>`;

  return `<!doctype html>
<html lang="${esc(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(L('title'))}</title><style>${CSS}</style></head><body><main>
<h1>${esc(L('title'))}</h1>
<p class="mute">${esc(L('made', { at: when(r.at), version: r.app.version }))}${r.publicUrl ? ` · <code>${esc(r.publicUrl)}</code>` : ''}</p>
<p><b>${esc(t('diagrep.found', counts))}</b></p>
<h2>${esc(L('summary'))}</h2>${findings}
<h2>${esc(L('signin'))}</h2>${signin}
<h2>${esc(L('directory'))}</h2>${dirs}
<h2>${esc(L('accounts'))}</h2><p>${esc(L('accountsLine', { total: r.accounts.total, directory: r.accounts.directory, waiting: r.accounts.waiting, blocked: r.accounts.blockedByDirectory }))}</p>
<h2>${esc(L('events'))}</h2>${events}
<h2>${esc(L('system'))}</h2>${checks}
<p class="mute" style="margin-top:32px">${esc(L('excluded'))}</p>
</main></body></html>`;
}
