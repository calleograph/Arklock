// Проверка вёрстки экранов «каталог»: scripts/ui-audit-directory.mjs <каталог-результата> [--widths 320,390,...] [--shots]
// Поднимает сервер с базой в памяти и тестовый LDAP-каталог (вымышленные данные), настраивает подключение, создаёт подразделение
// и обходит экраны с заполненным состоянием: мастер шагов, подразделения со списком, поле выбора с результатом из каталога,
// группа с привязкой домена и предпросмотром. На каждой ширине запускает общий аудит сетки (~/.claude/design-standard/layout-audit.js).
// Итог пишет в <каталог>/report.json. Требуется собранный проект.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const OUT = path.resolve(
  argv[0] && !argv[0].startsWith('--') ? argv[0] : 'test-results/ui-audit-directory',
);
const WIDTHS = opt('widths', '320,390,768,1024,1280,1440,1920').split(',').map(Number);
const SHOTS = argv.includes('--shots');
const LAYOUT_JS = readFileSync(
  path.join(process.env.HOME ?? '', '.claude/design-standard/layout-audit.js'),
  'utf8',
);
const ALIGN_JS = readFileSync(new URL('./layout-alignment.js', import.meta.url), 'utf8');
const PORT = 18199;
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP = 'ui-audit-setup-code-ui-audit-code-2';
const ADMIN = { email: 'audit@example.com', name: 'Аудит', password: 'ui-audit-master-password-1' };
const BASE_DN = 'dc=example,dc=com';
const GROUP_DN = `cn=Support,ou=groups,${BASE_DN}`;
const PEOPLE = [
  ['alice', 'Alice Directory', 'a1'],
  ['boris', 'Boris Directory', 'b2'],
  ['clara', 'Clara Example', 'c3'],
].map(([uid, cn, n]) => ({
  dn: `uid=${uid},ou=people,${BASE_DN}`,
  uid,
  mail: `${uid}@example.com`,
  cn,
  uuid: `6f1c0f6e-00${n}-4a2b-9c10-aaaaaaaaaaaa`,
  password: `${uid}-ldap-audit-pass`,
}));
mkdirSync(OUT, { recursive: true });
mkdirSync('test-results', { recursive: true });
const BLOB_DIR = mkdtempSync(path.resolve('test-results/ui-audit-blobs-'));

// ---- тестовый каталог
const ldap = createRequire(import.meta.url)('ldapjs');
const dir = ldap.createServer();
dir.bind(`cn=svc,${BASE_DN}`, (req, res, next) => {
  if (req.credentials !== 'svc-audit') return next(new ldap.InvalidCredentialsError());
  res.end();
  return next();
});
dir.bind(`ou=people,${BASE_DN}`, (req, res, next) => {
  const p = PEOPLE.find((x) => x.dn === req.dn.toString().toLowerCase());
  if (!p || p.password !== req.credentials) return next(new ldap.InvalidCredentialsError());
  res.end();
  return next();
});
dir.search(BASE_DN, (req, res, next) => {
  const base = req.dn.toString().toLowerCase();
  const isBase = req.scope === 0 || req.scope === 'base';
  for (const p of PEOPLE) {
    const attrs = {
      objectClass: 'person',
      uid: p.uid,
      mail: p.mail,
      cn: p.cn,
      entryUUID: p.uuid,
      memberOf: GROUP_DN,
    };
    if (isBase ? base === p.dn && req.filter.matches(attrs) : req.filter.matches(attrs))
      res.send({ dn: p.dn, attributes: attrs });
  }
  for (const g of [
    { dn: GROUP_DN, cn: 'Support' },
    { dn: `cn=Helpdesk,ou=groups,${BASE_DN}`, cn: 'Helpdesk' },
  ]) {
    const group = { objectClass: 'groupOfNames', cn: g.cn };
    if (!isBase && req.filter.matches(group)) res.send({ dn: g.dn, attributes: group });
  }
  res.end();
  return next();
});
await new Promise((r) => dir.listen(0, '127.0.0.1', r));
const ldapPort = dir.address().port;

const server = spawn('node', ['apps/api/dist/main.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    DATABASE_URL: 'pglite:memory',
    BLOB_DIR,
    APP_SECRET: 'ui-audit-secret-ui-audit-secret-12346',
    WEB_DIST: 'apps/web/dist',
    LOG_LEVEL: 'error',
    TRUSTED_PROXY_HOPS: '0',
    BOOTSTRAP_TOKEN: SETUP,
    APP_PUBLIC_URL: BASE,
    APP_VERSION: readFileSync('VERSION', 'utf8').trim(),
  },
  stdio: 'ignore',
});
process.on('exit', () => {
  server.kill();
  dir.close();
});

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/v1/ready`)).ok) return;
    } catch {
      /* ещё не запущен */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

const report = [];
try {
  await waitReady();
  const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.split('\n')[0]}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource.*(401|403|404)/.test(m.text()))
      errors.push(`console: ${m.text().slice(0, 160)}`);
  });
  await page.goto(`${BASE}/`);
  await page.getByTestId('name').waitFor();
  await page.getByTestId('email').fill(ADMIN.email);
  await page.getByTestId('name').fill(ADMIN.name);
  await page.getByTestId('setup-token').fill(SETUP);
  await page.getByTestId('password').fill(ADMIN.password);
  await page.getByTestId('repeat').fill(ADMIN.password);
  await page.getByTestId('submit').click();
  await page.getByTestId('recovery-saved').check({ timeout: 90_000 });
  await page.getByTestId('recovery-continue').click();
  await page.getByTestId('add-entry').waitFor({ timeout: 90_000 });
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('menu-full').click();

  const token = await page.evaluate(() => globalThis.sessionStorage.getItem('arklock.token'));
  const headers = { authorization: `Bearer ${token}` };
  const call = async (method, url, data) => {
    const r = await page.request.fetch(`${BASE}/api/v1${url}`, { method, headers, data });
    if (r.status() >= 400) throw new Error(`${method} ${url}: ${r.status()} ${await r.text()}`);
    return r.json().catch(() => ({}));
  };
  await call('PUT', '/admin/ldap', {
    enabled: true,
    name: 'Каталог',
    url: `ldap://127.0.0.1:${ldapPort}`,
    allowPlaintext: true,
    confirmInsecure: true,
    bindDn: `cn=svc,${BASE_DN}`,
    bindPassword: 'svc-audit',
    baseDn: BASE_DN,
    directoryType: 'ldap',
    access: 'all',
  });
  await call('POST', '/admin/ldap/test?profileId=default');
  await call('POST', '/admin/ldap/login-test?profileId=default', {
    username: 'alice',
    password: PEOPLE[0].password,
  });
  await call('POST', '/admin/circles', {
    name: 'Support team',
    description: 'Группа для проверки',
  });

  // данные как в живой установке: группы с названиями разной длины и пользовательская роль (у групп появляется выбор роли)
  for (const name of ['ИБ', 'ИТ', 'ИТ дирекция общая'])
    await call('POST', '/admin/circles', { name, description: '' });
  await call('POST', '/admin/roles', {
    name: 'Оператор',
    scope: 'admin',
    allow: ['admin.users'],
    deny: [],
    parents: [],
  });

  const go = (route) =>
    page.evaluate((r) => {
      globalThis.history.pushState({}, '', `/${r}`);
      globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'));
    }, route);
  const pick = async (input, add) => {
    await page.getByTestId(input).fill('boris');
    await page.getByTestId(add).click();
  };
  // подразделение создаётся через интерфейс: список созданных подразделений должен быть заполнен
  await go('admin/departments');
  await pick('dept-head-input', 'dept-head-add-boris@example.com');
  await page.getByTestId('dept-name').fill('Поддержка');
  await page.getByTestId('dept-create').click({ timeout: 30_000 });
  await page
    .getByTestId('dept-state')
    .first()
    .getByText(/Готово|Done/)
    .waitFor({ timeout: 60_000 });

  const scenes = [
    { id: 'ldap', run: async () => go('admin/ldap'), ready: 'directory-guide' },
    { id: 'wizards', run: async () => go('admin/wizards'), ready: 'directory-guide' },
    {
      id: 'invitations',
      run: async () => {
        await go('admin/invitations');
        await page.getByTestId('dir-invite-group-input').fill('Help');
      },
      ready: 'dir-invite-group-directory-title',
    },
    {
      id: 'departments',
      run: async () => {
        await go('admin/departments');
        // карточка созданного подразделения остаётся открытой между экранами: закрываем её, чтобы увидеть список
        if (
          await page
            .getByTestId('dept-detail-close')
            .isVisible()
            .catch(() => false)
        )
          await page.getByTestId('dept-detail-close').click();
      },
      ready: 'dept-card',
    },
    {
      id: 'department-card',
      run: async () => {
        await go('admin/departments');
        if (
          !(await page
            .getByTestId('dept-detail')
            .isVisible()
            .catch(() => false))
        )
          await page.getByTestId('dept-manage-Поддержка').click();
      },
      ready: 'dept-detail',
    },
    {
      id: 'user-card',
      run: async () => {
        await go('admin/users');
        await page.getByTestId('admin-user-search').fill('boris');
        await page.getByTestId('profile-open-boris@example.com').click();
      },
      ready: 'user-memberships',
    },
    {
      id: 'departments-picker',
      run: async () => {
        await go('admin/departments');
        await page.getByTestId('dept-member-input').fill('clara');
      },
      ready: 'dept-member-directory-title',
    },
    ...(argv.includes('--tabs')
      ? [
          ['workspace', ''],
          ['profile-settings', 'settings'],
          ['help', 'help'],
          ['inspector', 'inspector'],
          ['notifications', 'notifications'],
        ].map(([id, route]) => ({ id: `page-${id}`, run: async () => go(route), ready: null }))
      : []),
    ...(argv.includes('--tabs')
      ? [
          {
            id: 'page-vault-settings',
            run: async () => {
              const list = await call('GET', '/vaults');
              const v = list.find((x) => x.name?.includes('Пароли')) ?? list[0];
              await go(`vault/${v.id}/settings`);
            },
            ready: null,
          },
        ]
      : []),
    ...(argv.includes('--tabs')
      ? [
          'overview',
          'organization',
          'wizards',
          'users',
          'invitations',
          'departments',
          'circles',
          'access',
          'vaults',
          'transfer',
          'roles',
          'settings',
          'ledger',
          'resources',
          'containers',
          'backups',
          'logs',
          'storage',
          'certificates',
          'smtp',
          'ldap',
          'sso',
          'saml',
          'syslog',
          'webhooks',
          'updates',
          'automation',
          'keys',
          'shield',
        ].map((tab) => ({ id: `tab-${tab}`, run: async () => go(`admin/${tab}`), ready: null }))
      : []),
    {
      id: 'diagnostics',
      run: async () => {
        await go('admin/diagnostics');
        await page.getByTestId('diag-run').click();
      },
      ready: 'diag-findings',
    },
    {
      id: 'access-user',
      run: async () => {
        await go('admin/access');
        await page.getByTestId('access-mode-user').click();
        await page.getByTestId('access-person-input').fill('boris');
        await page.getByTestId('access-person-result-boris@example.com').click();
      },
      ready: 'access-user',
    },
    {
      id: 'access-vault',
      run: async () => {
        await go('admin/access');
        await page.getByTestId('access-mode-vault').click();
        await page.getByTestId('access-vault-search').fill('Поддержка');
        await page.locator('[data-testid^="access-vault-open-Поддержка"]').first().click();
      },
      ready: 'access-vault',
    },
    {
      id: 'department-page',
      run: async () =>
        go(`department/${(await call('GET', '/admin/departments?limit=1')).items[0].spaceId}`),
      ready: 'department-page',
    },
    {
      id: 'circles-link',
      run: async () => {
        await go('admin/circles');
        // окно группы остаётся открытым между ширинами: повторный клик по группе не нужен
        if (
          !(await page
            .getByTestId('group-dialog')
            .isVisible()
            .catch(() => false))
        )
          await page.getByTestId('circle-Support team').click();
        await page.getByTestId('group-tab-domain').click();
        await page.getByTestId('domain-group-input').fill('Supp');
        if (
          !(await page
            .getByTestId('domain-preview')
            .isVisible()
            .catch(() => false))
        )
          await page.getByTestId('domain-link-Support').click();
      },
      ready: 'domain-preview',
    },
    {
      id: 'group-members',
      run: async () => {
        await go('admin/circles');
        if (
          !(await page
            .getByTestId('group-dialog')
            .isVisible()
            .catch(() => false))
        )
          await page.getByTestId('circle-Поддержка').click();
        await page.getByTestId('group-tab-members').click();
      },
      ready: 'group-members',
    },
    {
      id: 'group-vaults',
      run: async () => {
        await go('admin/circles');
        if (
          !(await page
            .getByTestId('group-dialog')
            .isVisible()
            .catch(() => false))
        )
          await page.getByTestId('circle-Поддержка').click();
        await page.getByTestId('group-tab-vaults').click();
      },
      ready: 'group-vaults',
    },
  ];
  for (const sc of scenes) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      errors.length = 0;
      await sc.run();
      if (sc.ready) await page.getByTestId(sc.ready).first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(sc.ready ? 400 : 1200);
      const name = `${sc.id}-${width}`;
      if (SHOTS) await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
      const raw = await page.evaluate(LAYOUT_JS);
      const layout = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const align = await page.evaluate(ALIGN_JS);
      layout.problems = [...layout.problems, ...align.problems.map((x) => `ровность: ${x}`)];
      const smallTargets =
        width <= 560
          ? await page.evaluate(() =>
              [
                ...document.querySelectorAll(
                  'main button, main a.btn, main a.btn-primary, main summary',
                ),
              ]
                .filter((e) => {
                  const r = e.getBoundingClientRect();
                  return r.width > 0 && r.height > 0 && r.height < 44;
                })
                .map(
                  (e) =>
                    `${e.tagName.toLowerCase()}:${(e.textContent ?? '').trim().slice(0, 24)}:${Math.round(e.getBoundingClientRect().height)}`,
                ),
            )
          : [];
      report.push({
        scene: sc.id,
        width,
        problems: layout.problems,
        smallTargets,
        errors: [...errors],
      });
    }
  }
  // выгруженный файл отчёта открывается как обычная страница: сетка и тап-цели те же, горизонтальной прокрутки нет
  await go('admin/diagnostics');
  await page.getByTestId('diag-run').click();
  await page.getByTestId('diag-findings').waitFor();
  const dl = page.waitForEvent('download');
  await page.getByTestId('diag-download').click();
  const reportFile = path.join(OUT, 'diagnostics-report.html');
  await (await dl).saveAs(reportFile);
  for (const width of [390, 1280]) {
    const view = await ctx.newPage();
    await view.setViewportSize({ width, height: 900 });
    await view.goto(`file://${reportFile}`);
    const overflow = await view.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (SHOTS)
      await view.screenshot({ path: path.join(OUT, `report-html-${width}.png`), fullPage: true });
    report.push({
      scene: 'report-html',
      width,
      problems: overflow > 0 ? ['горизонтальная прокрутка'] : [],
      smallTargets: [],
      errors: [],
    });
    await view.close();
  }
  await browser.close();
} finally {
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  server.kill();
  dir.close();
}
const bad = report.filter((r) => r.problems.length || r.errors.length || r.smallTargets.length);
console.log(`экранов: ${report.length}, с замечаниями: ${bad.length}`);
for (const r of bad)
  console.log(
    `${r.scene} @${r.width}: ${[...r.problems, ...r.errors, ...r.smallTargets.map((s) => `цель <44: ${s}`)].join(' | ')}`,
  );
process.exit(bad.length ? 1 : 0);
