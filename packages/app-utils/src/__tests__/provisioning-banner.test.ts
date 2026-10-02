/**
 * `useProvisioningBanners` source handling.
 *
 * A source that threw was mapped to `null` — the value a PASSING check
 * returns — so an expired token or a 403 made an unprovisioned workspace
 * look healthy and hid the very banner that would have said so. The hook
 * composes `collectProvisioningBanners`, which is tested here because
 * this package carries no DOM harness for hooks.
 */
import { describe, expect, it } from 'vitest';
import {
  collectProvisioningBanners,
  type ProvisioningBannerSource,
  type ProvisioningBannerSpec,
} from '../ProvisioningBanner.js';

const warning: ProvisioningBannerSpec = {
  id: 'searches', tone: 'warning', title: 'Scheduled searches missing', body: '3 to create',
};

describe('collectProvisioningBanners', () => {
  it('keeps banners and drops sources that report nothing to do', async () => {
    const banners = await collectProvisioningBanners([
      async () => warning,
      async () => null,
    ]);
    expect(banners).toEqual([warning]);
  });

  it('a failing check is reported, not treated as provisioned', async () => {
    const checkScheduledSearches: ProvisioningBannerSource = async () => {
      throw new Error('403 Forbidden');
    };
    const banners = await collectProvisioningBanners([checkScheduledSearches]);
    expect(banners).toEqual([{
      id: 'provisioning-check-failed:checkScheduledSearches',
      tone: 'info',
      title: "Couldn't check checkScheduledSearches",
      body: '403 Forbidden',
    }]);
  });

  it('names an anonymous source by position and keeps the other results', async () => {
    const banners = await collectProvisioningBanners([
      async () => warning,
      // Wrapped so the function carries no inferred name.
      [async () => { throw 'boom'; }][0]!,
    ]);
    expect(banners).toHaveLength(2);
    expect(banners[0]).toBe(warning);
    expect(banners[1]).toMatchObject({
      tone: 'info', title: "Couldn't check provisioning check 2", body: 'boom',
    });
  });

  it('a source that throws synchronously is caught too', async () => {
    const sync = (() => { throw new Error('not a promise'); }) as unknown as ProvisioningBannerSource;
    const banners = await collectProvisioningBanners([sync]);
    expect(banners[0]).toMatchObject({ tone: 'info', body: 'not a promise' });
  });
});
