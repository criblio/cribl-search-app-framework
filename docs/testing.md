# Testing a Cribl App

Two layers, both runnable from a fresh app:

- **Unit tests (Vitest)** — pure logic and render-without-effects checks,
  no network. `npm test`.
- **Live tests (Playwright)** — the deployed app inside a real Cribl Cloud
  workspace, plus server-side KQL assertions. `npm run test:e2e`.

The live helpers come from `@criblio/app-tooling/playwright` (Node-only;
needs `@playwright/test` and `@criblio/app-utils` ≥ 0.12 installed, both of
which an app already has).

## Why the helpers exist

Opening `/app-ui/<app>/` from a test is not what a user gets. The workspace
shell normally gives the app's iframe `window.CRIBL_BASE_PATH`,
`window.CRIBL_API_URL`, and a fetch wrapper that adds a Bearer token. Without
them React Router renders an empty `#root` and every API call 401s — the
session cookie is not accepted at `/api/v1`. The shell also serves the app
inside an iframe, ignores deep paths, and periodically rolls host
announcement modals over everything that swallow the first click.

| Helper | What it does |
| --- | --- |
| `loadTestEnv(path?, env?)` | Merge `.env` into `process.env` without overriding CI secrets. Sync, for config files. |
| `criblCredentialsFromEnv(env?)` | `{ baseUrl, clientId, clientSecret }` from `CRIBL_BASE_URL` / `CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET`, naming any missing. |
| `installCriblHostGlobals(page, { appId? , appPath?, baseUrl, clientId, clientSecret })` | `addInitScript` that sets the host globals and a fetch wrapper adding the Bearer token to API calls only. Token from `getCachedBearerToken` (one exchange per process, refreshed 60 s before expiry). |
| `gotoApp(page, appId, { path?, appPath?, timeoutMs? })` → `FrameLocator` | Navigate, wait for the app iframe to attach, dismiss host announcements. |
| `appFrame(page, appId)` → `FrameLocator` | The app's iframe (`iframe[src*="/app-ui/<app>/"]`). Every in-app locator goes through it. |
| `dismissHostAnnouncements(page, signatures?)` | Best-effort exact-"Continue" click on known host modals (`KNOWN_HOST_ANNOUNCEMENTS`). |
| `loginSetup(page, { email, password, storageStatePath? })` | Auth0 two-step login (and a federated IdP branch) that saves storage state. |
| `runSearch(credentials, kql, options?)` → rows | `createNodeHttpClient` + `runSearchJob` with a 150 s budget for queued staging pools. |

## `playwright.config.ts`

```ts
import { defineConfig, devices } from '@playwright/test';
import { loadTestEnv } from '@criblio/app-tooling/playwright';

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
```

Add `playwright/.auth/` to `.gitignore` — it holds a live session.

## `tests/auth.setup.ts`

```ts
import { test as setup } from '@playwright/test';
import { loginSetup } from '@criblio/app-tooling/playwright';

// Redirect chain → Auth0 → workspace hydration; 30 s is too tight.
setup.setTimeout(120_000);

setup('authenticate to Cribl Cloud', async ({ page }) => {
  await loginSetup(page, {
    email: process.env.CRIBL_TEST_EMAIL ?? '',
    password: process.env.CRIBL_TEST_PASSWORD ?? '',
    storageStatePath: 'playwright/.auth/cribl-cloud.json',
  });
});
```

## A spec

```ts
import { expect, test } from '@playwright/test';
import {
  criblCredentialsFromEnv,
  gotoApp,
  installCriblHostGlobals,
  runSearch,
} from '@criblio/app-tooling/playwright';

const APP_ID = 'my-app'; // package.json "name"
const creds = criblCredentialsFromEnv();

test('home renders live data', async ({ page }) => {
  await installCriblHostGlobals(page, { ...creds, appId: APP_ID });
  const app = await gotoApp(page, APP_ID);
  await expect(app.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('the dataset has recent events', async () => {
  const rows = await runSearch(creds, 'dataset="my_dataset" | limit 5', { earliest: '-1h' });
  expect(rows.length).toBeGreaterThan(0);
});
```

## `vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    // Playwright specs live in tests/ and must never run under Vitest.
    exclude: ['tests/**', 'node_modules/**', 'dist/**'],
    server: {
      deps: {
        // Let Vite transform app-utils: its React surfaces import their
        // stylesheets, and Node's own loader throws "Unknown file extension
        // .css" on an externalised dependency.
        inline: [/@criblio\/app-utils/],
      },
    },
  },
});
```

Test React components with `renderToString` from `react-dom/server` in the
default Node environment: it runs render but not effects, which is exactly
the first-paint window most defaults bugs live in. Keep layout maths in pure
functions (as `stackColumns` and `buildTimeline` are) so it is testable
without a DOM.
