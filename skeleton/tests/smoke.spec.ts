import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { criblCredentialsFromEnv, gotoApp, installCriblHostGlobals } from '@criblio/app-tooling/playwright';

// The deployed app inside a real workspace. Deploy first (`npm run deploy`).
const APP_ID = (JSON.parse(readFileSync('package.json', 'utf8')) as { name: string }).name;
const creds = criblCredentialsFromEnv();

test('the app loads and reaches its configuration page', async ({ page }) => {
  await installCriblHostGlobals(page, { ...creds, appId: APP_ID });
  const app = await gotoApp(page, APP_ID);
  await expect(app.getByRole('heading', { name: 'Overview' })).toBeVisible();
  // The shell ignores deep paths: land, then navigate in-app.
  await app.getByRole('button', { name: 'Configuration' }).click();
  await expect(app.getByRole('heading', { name: 'Setup status' })).toBeVisible();
  await expect(app.getByText(/Could not check/)).toHaveCount(0);
});
