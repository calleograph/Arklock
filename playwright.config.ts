import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

const PORT_ACCOUNTS = 18181;
const PORT_UPDATES = 18182;
const PORT_WORKSPACE = 18183;
const PORT_ADMIN = 18184;
const PORT_EXTENSION = 18185;
const PORT_MOBILE = 18186;
const PORT_WEBAUTHN = 18187;
const PORT_FIREFOX = 18188;
const PORT_SESSION = 18189;
const PORT_ENTERPRISE = 18190;
const PORT_DAILY = 18191;
const PORT_UI = 18192;
/** Расширению нужен видимый браузер (в CI — xvfb), поэтому проект включается только по запросу. */
const WITH_EXTENSION = process.env.E2E_EXTENSION === '1';
/** Расширение в Firefox проверяется через geckodriver (Selenium) и требует установленного Firefox. */
const WITH_FIREFOX = process.env.E2E_FIREFOX === '1';
const BLOB_WORKSPACE = path.resolve('test-results', 'blobs-workspace');
const ADMIN_UPDATER_DIR = path.resolve('test-results', 'admin-updater');
const UPDATER_DIR = path.resolve('test-results', 'updater-dir');
mkdirSync(UPDATER_DIR, { recursive: true });
mkdirSync(ADMIN_UPDATER_DIR, { recursive: true });
mkdirSync(path.resolve('test-results', 'blobs-admin'), { recursive: true });
rmSync(BLOB_WORKSPACE, { recursive: true, force: true });
mkdirSync(BLOB_WORKSPACE, { recursive: true });

const common = {
  NODE_ENV: 'production',
  // версия сервера как в рабочем образе: интерфейс сверяет её со своей сборкой
  APP_VERSION: readFileSync('VERSION', 'utf8').trim(),
  HOST: '127.0.0.1',
  DATABASE_URL: 'pglite:memory',
  APP_SECRET: 'e2e-secret-e2e-secret-e2e-secret-12345',
  WEB_DIST: 'apps/web/dist',
  LOG_LEVEL: 'warn',
  TRUSTED_PROXY_HOPS: '0',
  // плановые проверки и установка в тестах браузера не нужны: они конкурировали бы с запросами из сценариев
  AUTO_UPDATE: 'off',
};

/**
 * Меню администрирования по умолчанию раскрывает только группу текущего раздела. Сценарии, которые переходят между разделами
 * кликами, начинают с раскрытым меню (как после «Развернуть всё»); проверки самого поведения меню сбрасывают это состояние.
 */
const NAV_GROUPS = [
  'overview',
  'people',
  'vaultsGroup',
  'security',
  'system',
  'storage',
  'integrations',
  'server',
];
function withOpenAdminMenu(projects: NonNullable<PlaywrightTestConfig['projects']>) {
  const open = JSON.stringify({ open: Object.fromEntries(NAV_GROUPS.map((g) => [g, true])) });
  for (const p of projects) {
    const base = p.use?.baseURL;
    if (!base) continue;
    p.use = {
      ...p.use,
      storageState: {
        cookies: [],
        origins: [
          {
            origin: new URL(base).origin,
            localStorage: [{ name: 'arklock.admin.nav', value: open }],
          },
        ],
      },
    };
  }
  return projects;
}

/**
 * E2E в настоящем браузере. На CI используется Chromium, установленный через `npx playwright install`;
 * локально можно указать установленный браузер: E2E_CHANNEL=msedge | chrome.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { channel: process.env.E2E_CHANNEL || undefined, trace: 'retain-on-failure' },
  projects: withOpenAdminMenu([
    {
      name: 'accounts',
      testMatch: 'accounts.spec.ts',
      use: { baseURL: `http://127.0.0.1:${PORT_ACCOUNTS}` },
    },
    {
      name: 'live',
      testMatch: 'live-update.spec.ts',
      use: { baseURL: process.env.LIVE_BASE_URL },
    },
    {
      name: 'workspace',
      testMatch: 'workspace.spec.ts',
      use: { baseURL: `http://127.0.0.1:${PORT_WORKSPACE}` },
    },
    {
      name: 'admin',
      testMatch: /admin-panel.*.spec.ts/,
      use: { baseURL: `http://127.0.0.1:${PORT_ADMIN}` },
    },
    ...(WITH_EXTENSION ? [{ name: 'extension', testMatch: 'extension.spec.ts' }] : []),
    ...(WITH_FIREFOX
      ? [
          {
            name: 'extension-firefox',
            testMatch: 'extension-firefox.spec.ts',
            use: { baseURL: `http://127.0.0.1:${PORT_FIREFOX}` },
          },
        ]
      : []),
    {
      name: 'enterprise',
      testMatch: 'enterprise.spec.ts',
      timeout: 600_000,
      use: { baseURL: `http://127.0.0.1:${PORT_ENTERPRISE}` },
    },
    {
      name: 'daily',
      testMatch: 'daily.spec.ts',
      timeout: 300_000,
      use: { baseURL: `http://127.0.0.1:${PORT_DAILY}` },
    },
    {
      name: 'ui',
      testMatch: 'unified-ui.spec.ts',
      timeout: 300_000,
      use: { baseURL: `http://127.0.0.1:${PORT_UI}` },
    },
    {
      name: 'mobile',
      testMatch: 'mobile.spec.ts',
      use: { baseURL: `http://127.0.0.1:${PORT_MOBILE}` },
    },
    {
      name: 'webauthn',
      testMatch: 'webauthn.spec.ts',
      // WebAuthn не допускает IP-адреса как идентификатор сайта: localhost
      use: { baseURL: `http://localhost:${PORT_WEBAUTHN}` },
    },
    {
      name: 'session',
      testMatch: 'session-lock.spec.ts',
      use: { baseURL: `http://127.0.0.1:${PORT_SESSION}` },
    },
    {
      name: 'updates',
      testMatch: 'updates.spec.ts',
      use: { baseURL: `http://127.0.0.1:${PORT_UPDATES}` },
    },
  ]),
  webServer: [
    {
      command: 'node apps/api/dist/main.js',
      url: `http://127.0.0.1:${PORT_WEBAUTHN}/api/v1/ready`,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORT_WEBAUTHN),
        BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-7',
        APP_PUBLIC_URL: `http://localhost:${PORT_WEBAUTHN}`,
      },
    },
    {
      command: 'node apps/api/dist/main.js',
      url: `http://127.0.0.1:${PORT_ENTERPRISE}/api/v1/ready`,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORT_ENTERPRISE),
        BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-8',
      },
    },
    {
      command: 'node apps/api/dist/main.js',
      url: `http://127.0.0.1:${PORT_DAILY}/api/v1/ready`,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORT_DAILY),
        BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-9',
      },
    },
    {
      command: 'node apps/api/dist/main.js',
      url: `http://127.0.0.1:${PORT_UI}/api/v1/ready`,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORT_UI),
        BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-u1',
        // тестовые приёмники почты слушают loopback
        SMTP_ALLOW_LOOPBACK: 'on',
      },
    },
    {
      command: 'node apps/api/dist/main.js',
      url: `http://127.0.0.1:${PORT_MOBILE}/api/v1/ready`,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORT_MOBILE),
        BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-6',
      },
    },
    {
      command: 'node apps/api/dist/main.js',
      url: `http://127.0.0.1:${PORT_SESSION}/api/v1/ready`,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORT_SESSION),
        BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-9',
      },
    },
    ...(WITH_FIREFOX
      ? [
          {
            command: 'node apps/api/dist/main.js',
            url: `http://127.0.0.1:${PORT_FIREFOX}/api/v1/ready`,
            timeout: 60_000,
            env: {
              ...common,
              PORT: String(PORT_FIREFOX),
              BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-8',
            },
          },
        ]
      : []),
    ...(WITH_EXTENSION
      ? [
          {
            command: 'node apps/api/dist/main.js',
            url: `http://127.0.0.1:${PORT_EXTENSION}/api/v1/ready`,
            timeout: 60_000,
            env: {
              ...common,
              PORT: String(PORT_EXTENSION),
              BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-5',
            },
          },
        ]
      : []),
    {
      command: 'node apps/api/dist/main.js',
      url: `http://127.0.0.1:${PORT_ADMIN}/api/v1/ready`,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORT_ADMIN),
        BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-4',
        UPDATER_DIR: ADMIN_UPDATER_DIR,
        APP_PUBLIC_URL: `http://127.0.0.1:${PORT_ADMIN}`,
        // тестовый приёмник почты слушает loopback
        SMTP_ALLOW_LOOPBACK: 'on',
        BLOB_DIR: path.resolve('test-results', 'blobs-admin'),
      },
    },
    {
      command: 'node apps/api/dist/main.js',
      url: `http://127.0.0.1:${PORT_WORKSPACE}/api/v1/ready`,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORT_WORKSPACE),
        BLOB_DIR: BLOB_WORKSPACE,
        BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-3',
      },
    },
    {
      command: 'node apps/api/dist/main.js',
      url: `http://127.0.0.1:${PORT_ACCOUNTS}/api/v1/ready`,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORT_ACCOUNTS),
        BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-1',
      },
    },
    {
      command: 'node apps/api/dist/main.js',
      url: `http://127.0.0.1:${PORT_UPDATES}/api/v1/ready`,
      timeout: 60_000,
      env: {
        ...common,
        PORT: String(PORT_UPDATES),
        BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-2',
        UPDATER_DIR,
      },
    },
  ],
});
