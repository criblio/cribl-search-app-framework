import { defineConfig, devices } from '@playwright/test';
import { loadTestEnv } from '@criblio/app-tooling/playwright';

// Live tests against a real Cribl Cloud workspace. `npm run test:e2e`.
loadTestEnv('.env');

const baseURL = (process.env.CRIBL_BASE_URL ?? '').replace(/\/$/, '');
if (!baseURL) throw new Error('CRIBL_BASE_URL is not set. Copy .env.example to .env.');

export const AUTH_FILE = 'playwright/.auth/cribl-cloud.json';

export default defineConfig({
  testDir: './tests',
  // Staging search pools cannot absorb parallel query load.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_FILE },
    },
  ],
});
