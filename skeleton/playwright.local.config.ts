import { defineConfig, devices } from '@playwright/test';

// Local resilience tests: the built app under `vite preview`, every API call
// answered by page.route(). No credentials. `npm run test:local`.
export const PREVIEW = 'http://localhost:4173';

export default defineConfig({
  testDir: './tests-local',
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: { baseURL: PREVIEW, trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: PREVIEW,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
