import { expect, test } from '@playwright/test';
import { hostGlobalsInitScript } from '@criblio/app-tooling/playwright';

const PREVIEW = 'http://localhost:4173'; // playwright.local.config.ts

// A KV store that cannot be reached must read as a failure, never as
// defaults: the page says so and refuses to save over the stored settings.
test('a failed settings load disables Save', async ({ page }) => {
  await page.addInitScript(hostGlobalsInitScript, ['', `${PREVIEW}/api/v1`, 'test'] as [string, string, string]);
  await page.route('**/api/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/kvstore/')) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' });
    if (url.includes('/search/datasets')) return route.fulfill({ json: { items: [{ id: 'otel' }] } });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto(`${PREVIEW}/configuration`);
  await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible();
  await expect(page.getByText('Settings could not be loaded')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});
