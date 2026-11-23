import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end journeys (Constitution XI) against a running programme layer in front of the REAL local
 * ELEVATE. Base URL from IPC_BASE_URL (default: the dockerised stack behind Caddy). Accessibility
 * checks use @axe-core/playwright inside the specs. Specs skip with a reason when the stack is down.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.IPC_BASE_URL ?? 'https://ipc.localhost',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-IN',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
