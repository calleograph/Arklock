import { defineConfig } from '@playwright/test';

const PORT = 18181;

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
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.E2E_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node apps/api/dist/main.js',
    url: `http://127.0.0.1:${PORT}/api/v1/ready`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATABASE_URL: 'pglite:memory',
      APP_SECRET: 'e2e-secret-e2e-secret-e2e-secret-12345',
      WEB_DIST: 'apps/web/dist',
      LOG_LEVEL: 'warn',
      BOOTSTRAP_TOKEN: 'e2e-setup-code-e2e-setup-code-1',
      TRUSTED_PROXY_HOPS: '0',
    },
  },
});
