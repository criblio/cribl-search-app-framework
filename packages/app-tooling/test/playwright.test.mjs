import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clearBearerTokenCache } from '@criblio/app-utils/auth';
import {
  appFrame,
  appFrameSelector,
  appIdFromPath,
  appPathFor,
  criblCredentialsFromEnv,
  dismissHostAnnouncements,
  gotoApp,
  hostGlobalsInitScript,
  installCriblHostGlobals,
  loadTestEnv,
  loginSetup,
  runSearch,
} from '../src/playwright.mjs';

const CREDS = { baseUrl: 'https://main-x.cribl.cloud/', clientId: 'id', clientSecret: 'secret' };

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function withFetch(handler, body) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  clearBearerTokenCache();
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
    clearBearerTokenCache();
  }
}

test('app paths and iframe selectors match the exact app id', () => {
  assert.equal(appPathFor('apm'), '/app-ui/apm/');
  assert.equal(appFrameSelector('apm'), 'iframe[src*="/app-ui/apm/"], iframe[src$="/app-ui/apm"]');
  assert.throws(() => appPathFor('a"]b'), /app id must match/);
  assert.throws(() => appFrameSelector(''), /app id must match/);
});

test('the init script sets host globals and injects the bearer only on API calls', async () => {
  const seen = [];
  const original = globalThis.window;
  globalThis.window = {
    fetch(input, init) {
      seen.push({ input, init });
      return Promise.resolve(new Response('{}'));
    },
  };
  try {
    hostGlobalsInitScript(['/app-ui/apm', 'https://w.cribl.cloud/api/v1', 'tok']);
    assert.equal(window.CRIBL_BASE_PATH, '/app-ui/apm');
    assert.equal(window.CRIBL_API_URL, 'https://w.cribl.cloud/api/v1');

    await window.fetch('https://w.cribl.cloud/api/v1/m/default_search/search/jobs');
    await window.fetch('/api/v1/system/info', { headers: { accept: 'application/json' } });
    await window.fetch('https://w.cribl.cloud/api/v1/x', { headers: { authorization: 'Bearer mine' } });
    await window.fetch(new Request('https://w.cribl.cloud/api/v1/kv', { headers: { 'x-keep': '1' } }));
    await window.fetch('https://third.party/api/v1/steal');
    await window.fetch('https://w.cribl.cloud/api/v1evil/x');

    const auth = (i) => new Headers(seen[i].init?.headers).get('authorization');
    assert.equal(auth(0), 'Bearer tok');
    assert.equal(auth(1), 'Bearer tok');
    assert.equal(new Headers(seen[1].init.headers).get('accept'), 'application/json');
    assert.equal(auth(2), 'Bearer mine', 'an explicit authorization header is left alone');
    assert.equal(auth(3), 'Bearer tok');
    assert.equal(new Headers(seen[3].init.headers).get('x-keep'), '1', "a Request's own headers survive");
    assert.equal(seen[4].init, undefined, 'third-party calls pass through untouched');
    assert.equal(seen[5].init, undefined, 'a lookalike prefix is not the API');
  } finally {
    globalThis.window = original;
  }
});

test('installCriblHostGlobals mints one cached token and passes serialisable args', async () => {
  let tokenCalls = 0;
  await withFetch(
    async (url) => {
      assert.equal(String(url), 'https://login.cribl.cloud/oauth/token');
      tokenCalls += 1;
      return json({ access_token: `t${tokenCalls}`, expires_in: 3600 });
    },
    async () => {
      const scripts = [];
      const page = { addInitScript: async (fn, arg) => scripts.push({ fn, arg }) };
      await installCriblHostGlobals(page, { ...CREDS, appId: 'apm' });
      await installCriblHostGlobals(page, { ...CREDS, appPath: '/app-ui/other/' });
      assert.equal(tokenCalls, 1);
      assert.equal(scripts[0].fn, hostGlobalsInitScript);
      assert.deepEqual(scripts[0].arg, ['/app-ui/apm', 'https://main-x.cribl.cloud/api/v1', 't1']);
      assert.deepEqual(scripts[1].arg[0], '/app-ui/other');
      await assert.rejects(installCriblHostGlobals(page, CREDS), /appId or appPath/);
      await assert.rejects(installCriblHostGlobals(page, { appId: 'apm' }), /baseUrl, clientId and clientSecret/);
    },
  );
});

function fakeLocator(log, name, { visible = false } = {}) {
  return {
    first: () => fakeLocator(log, name, { visible }),
    getByText: (sig) => fakeLocator(log, `text:${sig}`, { visible }),
    isVisible: async () => visible,
    waitFor: async (opts) => log.push(['waitFor', name, opts.state]),
    click: async () => log.push(['click', name]),
    fill: async (value) => log.push(['fill', name, value]),
  };
}

test('gotoApp lands on the app path, waits for its iframe, and returns the frame', async () => {
  const log = [];
  const page = {
    goto: async (url, opts) => log.push(['goto', url, opts.waitUntil]),
    locator: (sel) => fakeLocator(log, sel),
    frameLocator: (sel) => ({ first: () => ({ frameFor: sel }) }),
    getByRole: (role, opts) => fakeLocator(log, `${role}:${opts.name}`),
  };
  const frame = await gotoApp(page, 'apm', { path: '/traces' });
  assert.deepEqual(log[0], ['goto', '/app-ui/apm/traces', 'domcontentloaded']);
  assert.deepEqual(log[1], ['waitFor', appFrameSelector('apm'), 'attached']);
  assert.deepEqual(frame, { frameFor: appFrameSelector('apm') });
  assert.deepEqual(appFrame(page, 'apm'), frame);
});

test('appIdFromPath parses /app-ui/<id>/ and rejects anything else clearly', () => {
  assert.equal(appIdFromPath('/app-ui/apm/'), 'apm');
  assert.equal(appIdFromPath('/app-ui/apm'), 'apm');
  assert.equal(appIdFromPath('/app-ui/apm-lab/traces?x=1'), 'apm-lab');
  assert.equal(appIdFromPath('https://main-x.cribl.cloud/app-ui/apm/'), 'apm');
  for (const bad of ['/apps/a/apm', 'apm', '/app-ui/', '/app-ui//', '', undefined, '/app-ui/a"]b/']) {
    assert.throws(() => appIdFromPath(bad), /app path must look like \/app-ui\/<app-id>\/|app id must match/, String(bad));
  }
});

test('gotoApp and appFrame accept { appPath } without a separate app id', async () => {
  const log = [];
  const page = {
    goto: async (url, opts) => log.push(['goto', url, opts.waitUntil]),
    locator: (sel) => fakeLocator(log, sel),
    frameLocator: (sel) => ({ first: () => ({ frameFor: sel }) }),
    getByRole: (role, opts) => fakeLocator(log, `${role}:${opts.name}`),
  };
  const frame = await gotoApp(page, { appPath: '/app-ui/apm-staging/', path: '/traces' });
  assert.deepEqual(log[0], ['goto', '/app-ui/apm-staging/traces', 'domcontentloaded']);
  assert.deepEqual(log[1], ['waitFor', appFrameSelector('apm-staging'), 'attached']);
  assert.deepEqual(frame, { frameFor: appFrameSelector('apm-staging') });
  assert.deepEqual(appFrame(page, { appPath: '/app-ui/apm-staging/' }), frame);
  // The original positional forms are unchanged.
  assert.deepEqual(appFrame(page, 'apm-staging'), frame);
  await assert.rejects(gotoApp(page, {}), /pass an app id, or \{ appPath \}/);
  await assert.rejects(gotoApp(page, { appPath: '/apps/a/apm' }), /app path must look like/);
});

test('dismissHostAnnouncements clicks the exact Continue only for a known, visible announcement', async () => {
  const log = [];
  const roles = [];
  const page = {
    locator: () => fakeLocator(log, 'body', { visible: true }),
    getByRole: (role, opts) => {
      roles.push(opts);
      return fakeLocator(log, `${role}:${opts.name}`);
    },
  };
  await dismissHostAnnouncements(page);
  assert.deepEqual(roles, [{ name: 'Continue', exact: true }]);
  assert.ok(log.some((entry) => entry[0] === 'click' && entry[1] === 'button:Continue'));

  const quiet = { locator: () => fakeLocator([], 'body'), getByRole: () => assert.fail('nothing to dismiss') };
  await dismissHostAnnouncements(quiet);
});

test('loginSetup waits for the Auth0 form and uses exact button names', async () => {
  const log = [];
  const roles = [];
  const page = {
    goto: async (url, opts) => log.push(['goto', url, opts.waitUntil]),
    waitForURL: async (matcher) => {
      if (matcher instanceof RegExp) return; // the Auth0 form appeared
    },
    getByLabel: (label) => fakeLocator(log, `label:${label}`),
    getByRole: (role, opts) => {
      roles.push(opts.name);
      // Only the Auth0 password field becomes visible; the federated branch never does.
      return { ...fakeLocator(log, `${role}:${opts.name}`), waitFor: () => new Promise(() => {}) };
    },
    waitForLoadState: async () => {},
    context: () => ({ storageState: async (opts) => log.push(['storageState', opts.path]) }),
  };
  await loginSetup(page, { email: 'a@b.c', password: 'pw', storageStatePath: 'auth.json' });
  assert.deepEqual(log[0], ['goto', '/', 'commit']);
  assert.ok(log.some((e) => e[0] === 'fill' && e[2] === 'a@b.c'));
  assert.ok(log.some((e) => e[0] === 'fill' && e[2] === 'pw'));
  assert.equal(roles[0], 'Next');
  const submit = roles.find((name) => name instanceof RegExp && name.test('Continue'));
  assert.ok(submit, 'a submit button matcher was used');
  assert.equal(submit.test('Continue with Google'), false, 'social-login buttons must not match');
  assert.deepEqual(log.at(-1), ['storageState', 'auth.json']);
  await assert.rejects(loginSetup(page, { email: 'a@b.c' }), /email and password/);
});

test('loadTestEnv fills only unset variables and tolerates a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-tooling-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, '# comment\nCRIBL_BASE_URL="https://x.cribl.cloud"\nCRIBL_CLIENT_ID=from-file\n');
  const env = { CRIBL_CLIENT_ID: 'from-ci' };
  loadTestEnv(path, env);
  assert.deepEqual(env, { CRIBL_CLIENT_ID: 'from-ci', CRIBL_BASE_URL: 'https://x.cribl.cloud' });
  assert.deepEqual(loadTestEnv(join(dir, 'missing'), env), {});
});

test('criblCredentialsFromEnv names every missing variable', () => {
  assert.throws(() => criblCredentialsFromEnv({ CRIBL_BASE_URL: 'x' }), /CRIBL_CLIENT_ID, CRIBL_CLIENT_SECRET must be set/);
  assert.deepEqual(
    criblCredentialsFromEnv({ CRIBL_BASE_URL: 'https://x/', CRIBL_CLIENT_ID: 'i', CRIBL_CLIENT_SECRET: 's' }),
    { baseUrl: 'https://x', clientId: 'i', clientSecret: 's' },
  );
});

test('runSearch runs a job through createNodeHttpClient with the bearer and parses NDJSON', async () => {
  const requests = [];
  let polls = 0;
  await withFetch(
    async (url, init = {}) => {
      const u = String(url);
      requests.push({ url: u, method: init.method, auth: init.headers?.authorization });
      if (u.includes('/oauth/token')) return json({ access_token: 'tok', expires_in: 3600 });
      if (u.endsWith('/search/jobs')) return json({ items: [{ id: 'j1', status: 'queued' }] });
      if (u.endsWith('/search/jobs/j1')) {
        polls += 1;
        return json({ items: [{ id: 'j1', status: polls < 2 ? 'running' : 'completed' }] });
      }
      if (u.includes('/jobs/j1/results')) return new Response('{"meta":1}\n{"a":1}\n{"a":2}\n');
      throw new Error(`unexpected ${u}`);
    },
    async () => {
      const rows = await runSearch(CREDS, 'dataset="x" | limit 2', { pollIntervalMs: 1, limit: 2 });
      assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
      const create = requests.find((r) => r.url.endsWith('/search/jobs'));
      assert.equal(create.url, 'https://main-x.cribl.cloud/api/v1/m/default_search/search/jobs');
      assert.equal(create.auth, 'Bearer tok');
      assert.equal(polls, 2);
    },
  );
});

test('runSearch surfaces a timeout as a SearchJobError instead of hanging', async () => {
  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('/oauth/token')) return json({ access_token: 'tok', expires_in: 3600 });
      if (u.endsWith('/search/jobs')) return json({ items: [{ id: 'j2', status: 'queued' }] });
      return json({ items: [{ id: 'j2', status: 'running' }] });
    },
    async () => {
      await assert.rejects(
        runSearch(CREDS, 'x', { pollIntervalMs: 1, timeoutMs: 20 }),
        (error) => error.name === 'SearchJobError' && error.kind === 'timeout',
      );
    },
  );
});
