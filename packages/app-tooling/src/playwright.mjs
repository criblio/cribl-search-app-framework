/**
 * Playwright helpers for testing a deployed Cribl App against a live
 * workspace. Node-only. Optional peer `@playwright/test` (types only —
 * nothing here imports it at runtime). Imports `@criblio/app-utils` (auth +
 * search), which every app already depends on; it is deliberately not a
 * declared peer, because in this workspace a peer link pulls app-utils'
 * dev tree into app-tooling's strict `npm audit --audit-level=low` gate.
 *
 * Inside the Cribl Search shell the host gives the app iframe three things:
 * `window.CRIBL_BASE_PATH` (the router basename), `window.CRIBL_API_URL`,
 * and a fetch wrapper that attaches a Bearer token to API calls. Opening
 * `/app-ui/<app>/` directly from a test skips all three: the router renders
 * an empty #root and the session cookie 401s at /api/v1. The helpers here
 * put them back, find the app's iframe, and clear host modals that would
 * swallow the first click.
 */
import { existsSync, readFileSync } from 'node:fs';
import { getCachedBearerToken } from '@criblio/app-utils/auth';
import { createNodeHttpClient } from '@criblio/app-utils/provisioner';
import { runSearchJob } from '@criblio/app-utils/search-job';
import { parseDotEnv } from './dotenv.mjs';

const APP_ID = /^[A-Za-z0-9._-]+$/;

function assertAppId(appId) {
  if (typeof appId !== 'string' || !APP_ID.test(appId)) {
    throw new Error(`app id must match ${APP_ID} (got ${JSON.stringify(appId)})`);
  }
}

/** `/app-ui/<appId>/` — where the platform serves an installed app. */
export function appPathFor(appId) {
  assertAppId(appId);
  return `/app-ui/${appId}/`;
}

/**
 * Merge a `.env` file into `process.env` without overriding values already
 * set (CI secrets win). A missing file is not an error. Synchronous so a
 * `playwright.config.ts` can call it at the top level.
 */
export function loadTestEnv(path = '.env', env = process.env) {
  if (!existsSync(path)) return {};
  const parsed = parseDotEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return parsed;
}

/** Read CRIBL_BASE_URL / CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET, naming any that are missing. */
export function criblCredentialsFromEnv(env = process.env) {
  const missing = ['CRIBL_BASE_URL', 'CRIBL_CLIENT_ID', 'CRIBL_CLIENT_SECRET'].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} must be set (in .env or the environment) to mint a Cribl API token for tests.`,
    );
  }
  return {
    baseUrl: env.CRIBL_BASE_URL.replace(/\/$/, ''),
    clientId: env.CRIBL_CLIENT_ID,
    clientSecret: env.CRIBL_CLIENT_SECRET,
  };
}

function credentialsFrom(options) {
  const { baseUrl, clientId, clientSecret } = options ?? {};
  if (!baseUrl || !clientId || !clientSecret) {
    throw new Error('baseUrl, clientId and clientSecret are required (see criblCredentialsFromEnv)');
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), clientId, clientSecret };
}

/**
 * Body of the init script. Runs in the page, serialised by Playwright, so it
 * must not close over anything: every input arrives in `args`. Exported so
 * the fetch wrapper can be unit-tested against a fake window.
 */
export function hostGlobalsInitScript(args) {
  const [basePath, apiUrl, token] = args;
  const w = window;
  w.CRIBL_BASE_PATH = basePath;
  w.CRIBL_API_URL = apiUrl;
  const original = w.fetch.bind(w);
  w.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Only our API, like the host proxy: the token never goes to a third party.
    const isApi = url === apiUrl || url.startsWith(`${apiUrl}/`) || url.startsWith('/api/v1/');
    if (!isApi) return original(input, init);
    // A Request's own headers survive: fetch(request, { headers }) would replace them.
    const headers = new Headers(
      init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined),
    );
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    return original(input, { ...init, headers });
  };
}

/**
 * Install CRIBL_BASE_PATH, CRIBL_API_URL and a Bearer-injecting fetch wrapper
 * before any page script runs. Call once per page, before the first goto.
 * Pass `appId` or an explicit `appPath`.
 */
export async function installCriblHostGlobals(page, options) {
  const credentials = credentialsFrom(options);
  const appPath = options.appPath ?? (options.appId ? appPathFor(options.appId) : undefined);
  if (!appPath) throw new Error('installCriblHostGlobals needs appId or appPath');
  const token = await getCachedBearerToken(credentials);
  await page.addInitScript(hostGlobalsInitScript, [
    appPath.replace(/\/$/, ''),
    `${credentials.baseUrl}/api/v1`,
    token,
  ]);
}

/** CSS selector for the app's iframe; exact app id, so `apm` never matches `apm-lab`. */
export function appFrameSelector(appId) {
  assertAppId(appId);
  return `iframe[src*="/app-ui/${appId}/"], iframe[src$="/app-ui/${appId}"]`;
}

/**
 * FrameLocator rooted in the app's iframe. The top page is the workspace
 * shell; every in-app locator must go through this.
 */
export function appFrame(page, appId) {
  return page.frameLocator(appFrameSelector(appId)).first();
}

/**
 * Host-shell announcement modals (not the app's) that overlay the iframe and
 * eat pointer events. Matched by text so a modal the app raises is never
 * dismissed. Add new ones as they roll out.
 */
export const KNOWN_HOST_ANNOUNCEMENTS = [/Introducing AI-accelerated workflows/i];

/** Best-effort, idempotent: clicks the exact "Continue" on any known host announcement. */
export async function dismissHostAnnouncements(page, signatures = KNOWN_HOST_ANNOUNCEMENTS) {
  for (const signature of signatures) {
    const banner = page.locator('body').getByText(signature).first();
    try {
      if (!(await banner.isVisible({ timeout: 1_500 }).catch(() => false))) continue;
      await page.getByRole('button', { name: 'Continue', exact: true }).first().click({ timeout: 5_000 });
      await banner.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    } catch {
      /* a host modal we cannot dismiss should not crash the spec here */
    }
  }
}

/**
 * Open the app through the workspace shell and return its FrameLocator.
 *
 * The shell serves `/app-ui/<app>/*` as `/apps/a/<app>` with the app in an
 * iframe and ignores any deep path, so land on the app and then navigate
 * inside the frame. Waits for the iframe to attach (it is injected after
 * the shell's scripts run) and clears host announcements.
 */
export async function gotoApp(page, appId, options = {}) {
  const { appPath = appPathFor(appId), path = '/', timeoutMs = 30_000 } = options;
  const target = `${appPath.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.locator(appFrameSelector(appId)).first().waitFor({ state: 'attached', timeout: timeoutMs });
  await dismissHostAnnouncements(page);
  return appFrame(page, appId);
}

const LOGIN_URL = /login\.cribl(-staging)?\.cloud\/u\/login/;
const LOGIN_HOST = /login\.cribl(-staging)?\.cloud/;

/**
 * Log in to Cribl Cloud through the hosted Auth0 flow and, if
 * `storageStatePath` is given, save the session for later projects.
 *
 * - `waitUntil: 'commit'`: the redirect chain replaces the document, so the
 *   first page's load event never fires.
 * - Waits for the Auth0 form URL rather than reading `page.url()` once:
 *   the SPA bounces `/` → `/login` → Auth0, and an early check saw `/`,
 *   skipped the login and saved half-finished transaction cookies.
 * - Exact button names: "Continue with Google" / "Continue with <org>"
 *   social buttons also match /continue/.
 * - Handles a federated IdP (e.g. authentik) after "Next".
 */
export async function loginSetup(page, options) {
  const { email, password, storageStatePath, baseUrl = '/' } = options ?? {};
  if (!email || !password) throw new Error('loginSetup needs email and password (e.g. CRIBL_TEST_EMAIL / CRIBL_TEST_PASSWORD)');

  await page.goto(baseUrl, { waitUntil: 'commit' });
  const needsLogin = await page
    .waitForURL(LOGIN_URL, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);

  if (needsLogin) {
    const emailField = page.getByLabel(/email address/i);
    await emailField.waitFor({ state: 'visible', timeout: 30_000 });
    await emailField.fill(email);
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    const auth0Password = page.getByLabel(/password/i);
    const federatedUser = page.getByRole('textbox', { name: /email or username/i });
    const branch = await Promise.race([
      auth0Password.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'auth0'),
      federatedUser.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'federated'),
    ]);

    if (branch === 'federated') {
      await federatedUser.fill(email);
      await page.getByRole('button', { name: /log in/i }).click();
      const federatedPassword = page.getByRole('textbox', { name: /password/i });
      await federatedPassword.waitFor({ state: 'visible', timeout: 30_000 });
      await federatedPassword.fill(password);
      await page.getByRole('button', { name: /^(continue|log in|sign in)$/i }).click();
      // First-time consent screen; skipped once remembered.
      await Promise.race([
        page
          .getByRole('heading', { name: /redirecting to cribl/i })
          .waitFor({ state: 'visible', timeout: 30_000 })
          .then(() => page.getByRole('button', { name: /^continue$/i }).click()),
        page.waitForURL((url) => !LOGIN_HOST.test(url.toString()), { timeout: 30_000 }),
      ]).catch(() => {});
    } else {
      await auth0Password.fill(password);
      await page.getByRole('button', { name: /^(continue|log in|sign in)$/i }).click();
    }
  }

  // The SPA does a second /authorize round trip; snapshot only after it lands,
  // or silent auth fails on the next run.
  await page.waitForURL((url) => !LOGIN_HOST.test(url.toString()), { timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle').catch(() => {});
  if (storageStatePath) await page.context().storageState({ path: storageStatePath });
}

/**
 * Run a KQL query from Node and return its rows. Uses the same strict job
 * runner as the app (`runSearchJob`), with a 150 s default budget: a small
 * staging pool under scheduled-search load queued serial smoke queries past
 * 60 s while each ran in ~13 s.
 */
export async function runSearch(credentials, query, options = {}) {
  const http = await createNodeHttpClient(credentialsFrom(credentials));
  return runSearchJob(http, query, { pollIntervalMs: 500, timeoutMs: 150_000, ...options });
}
