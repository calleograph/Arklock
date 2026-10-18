#!/usr/bin/env node
/**
 * Проверка репозитория на секреты, случайно добавленные файлы и посторонние адреса.
 *
 * Проект универсален и не содержит данных конкретных серверов, поэтому проверка строится по списку РАЗРЕШЁННОГО:
 *   1. каждый домен и e-mail в файлах должен оканчиваться на запись из scripts/private-data.allow;
 *   2. IP-адреса — только из разрешённых диапазонов (строки "ip: <regex>" в том же файле);
 *   3. запрещённые файлы (.env, ключи, дампы) и характерные формы секретов (приватные ключи, токены);
 *   4. необязательный локальный список дополнительных запрещённых шаблонов: файл из PRIVATE_DENY_FILE
 *      или .local/private-deny.txt (по одному регулярному выражению в строке, без учёта регистра).
 *
 * Запуск:  node scripts/check-private-data.mjs            — рабочее дерево (отслеживаемые и новые файлы)
 *          node scripts/check-private-data.mjs --history  — дополнительно все добавленные строки истории git
 * Код возврата: 0 — чисто, 1 — найдено.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW_FILE = path.join(ROOT, 'scripts', 'private-data.allow');
const SELF = new Set([
  'scripts/check-private-data.mjs',
  'scripts/private-data.allow',
  'LICENSE', // стандартный текст лицензии без изменений
  'apps/api/test/security.test.ts', // тестовые адреса для проверки защиты от SSRF
  'tests/scripts/private-data.test.ts', // содержит заведомо «плохие» примеры для проверки самого сканера
]);
const SKIP_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.pdf',
  '.zip',
  '.gz',
  '.wasm',
]);
const SKIP_NAMES = new Set(['package-lock.json']);

const TLDS =
  'com|org|net|ru|su|io|ai|dev|app|cloud|local|lan|corp|internal|intranet|home|test|invalid|example|pro|me|info';
const DOMAIN = new RegExp(
  `(?<![\\w@.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS}))(?![\\w-]|\\.[a-z])`,
  'gi',
);
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
const IPV4 = /(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/g;
const CODE_LIKE =
  /^(?:[a-z]|ws|self|this|app|window|document|os|sys|req|res|reply|settings|config|cfg|state|ctx|request|response|result|data|obj|item|row|process|crypto|globalThis|navigator|localStorage|boot|created|import|node|vue|module|exports)\./i;
const SECRET_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/, 'приватный ключ'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'токен GitHub'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'ключ AWS'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'токен Slack'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/, 'токен npm'],
];
const FORBIDDEN_FILE = [
  [/(^|\/)\.env(\.[^/]*)?$/, (p) => !/\.env\.example$/.test(p), 'файл окружения'],
  [/\.(pem|key|p12|pfx|jks)$/i, () => true, 'файл ключа/сертификата'],
  [/\.(sql|dump|bak)$/i, (p) => !p.startsWith('apps/api/drizzle/'), 'дамп/резервная копия'],
  [/(^|\/)\.local\//, () => true, 'локальный служебный каталог (должен быть в .gitignore)'],
];

function loadAllow() {
  const domains = [];
  const ips = [];
  for (const raw of readFileSync(ALLOW_FILE, 'utf8').split('\n')) {
    const line = raw.split('#', 1)[0].trim();
    if (!line) continue;
    if (line.startsWith('ip:')) ips.push(new RegExp(line.slice(3).trim()));
    else domains.push(line.toLowerCase().replace(/^\*\./, ''));
  }
  return { domains, ips };
}

function loadDeny() {
  const file = process.env.PRIVATE_DENY_FILE || path.join(ROOT, '.local', 'private-deny.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => new RegExp(l, 'i'));
}

const { domains: ALLOWED, ips: ALLOWED_IPS } = loadAllow();
const DENY = loadDeny();
const domainOk = (d) =>
  ALLOWED.some((a) => d.toLowerCase() === a || d.toLowerCase().endsWith(`.${a}`));

/** Возвращает список проблем в одной строке текста. */
function scanLine(line) {
  // выражения GitHub Actions (${{ env.X }}) — не адреса и не домены
  line = line.replace(/\$\{\{[^}]*\}\}/g, ' ');
  const out = [];
  for (const re of DENY)
    if (re.test(line)) out.push('запрещённый шаблон из дополнительного списка');
  for (const [re, what] of SECRET_PATTERNS) if (re.test(line)) out.push(what);
  for (const m of line.matchAll(EMAIL))
    if (!domainOk(m[1])) out.push(`e-mail с неразрешённым доменом: ${m[1]}`);
  for (const m of line.matchAll(DOMAIN)) {
    const d = m[1];
    if (CODE_LIKE.test(d) || domainOk(d)) continue;
    out.push(`неразрешённый домен: ${d}`);
  }
  for (const m of line.matchAll(IPV4)) {
    const ip = m[1];
    const parts = ip.split('.').map(Number);
    if (parts.some((n) => n > 255)) continue; // похоже на версию, а не адрес
    if (!ALLOWED_IPS.some((re) => re.test(ip))) out.push(`неразрешённый IP: ${ip}`);
  }
  return out;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
}

const problems = [];
const report = (where, what) => problems.push(`${where}: ${what}`);

let files;
try {
  files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
} catch {
  console.error('Не git-репозиторий — проверка невозможна.');
  process.exit(2);
}

for (const rel of files) {
  const p = rel.replaceAll('\\', '/');
  for (const [re, bad, what] of FORBIDDEN_FILE)
    if (re.test(p) && bad(p)) report(p, `запрещённый файл (${what})`);
  if (
    SELF.has(p) ||
    SKIP_NAMES.has(path.basename(p)) ||
    SKIP_EXT.has(path.extname(p).toLowerCase())
  )
    continue;
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs) || statSync(abs).size > 2_000_000) continue;
  const text = readFileSync(abs, 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const w of scanLine(line)) report(`${p}:${i + 1}`, w);
  });
}

if (process.argv.includes('--history')) {
  let log = '';
  try {
    log = git([
      'log',
      '--all',
      '-p',
      '--no-color',
      '--format=commit %H%nauthor %an <%ae>%nmessage %s',
    ]);
  } catch {
    /* пустая история */
  }
  let commit = '';
  let skipFile = false;
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7, 14);
    const diff = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diff) {
      const p = diff[2];
      skipFile =
        SELF.has(p) ||
        SKIP_NAMES.has(path.basename(p)) ||
        SKIP_EXT.has(path.extname(p).toLowerCase());
    }
    if (
      line.startsWith('author ') ||
      line.startsWith('message ') ||
      (!skipFile && line.startsWith('+') && !line.startsWith('+++'))
    ) {
      for (const w of scanLine(line)) report(`история ${commit}`, w);
    }
  }
}

if (problems.length) {
  const uniq = [...new Set(problems)];
  console.error(`Найдено проблем: ${uniq.length}`);
  for (const p of uniq.slice(0, 200)) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `Чисто: проверено файлов — ${files.length}${process.argv.includes('--history') ? ', история git просмотрена' : ''}.`,
);
