import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT_ACCOUNTS = 18181;
const PORT_UPDATES = 18182;
const UPDATER_DIR = path.resolve('test-results', 'updater-dir');
mkdirSync(UPDATER_DIR, { recursive: true });

const common = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  DATABASE_URL: 'pglite:memory',
  APP_SECRET: 'e2e-secret-e2e-secret-e2e-secret-12345',
  WEB_DIST: 'apps/web/dist',
  LOG_LEVEL: 'warn',
  TRUSTED_PROXY_HOPS: '0',
};

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
  projects: [
    {
      name: 'accounts',
      testMatch: 'accounts.spec.ts',
      use: { baseURL: `http://127.0.0.1:${PORT_ACCOUNTS}` },
    },
    {
      name: 'updates',
      testMatch: 'updates.spec.ts',
      use: { baseURL: `http://127.0.0.1:${PORT_UPDATES}` },
    },
  ],
  webServer: [
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
