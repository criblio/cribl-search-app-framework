/**
 * Provisioning banner primitives.
 *
 * Apps that depend on provisioning state (scheduled searches,
 * accelerated fields, dataset rulesets, etc.) surface a persistent
 * banner above page content until the user resolves the gap from
 * the Settings page.
 *
 * The framework provides:
 *   - <Banner /> — the visual primitive (icon + title + body + slot
 *     for an action element provided by the caller).
 *   - useProvisioningBanners() — a hook that runs a list of async
 *     "sources" in parallel and exposes the resulting banner specs.
 *
 * The consumer composes these into their own stack and supplies
 * their own routing for the action slot, so this file stays
 * router-free (app-utils has no react-router dep).
 *
 * Example consumer:
 *
 *   // The route is `/configuration`, not `/settings`: the Cribl host shell
 *   // intercepts any app route containing "settings", so a link there
 *   // never reaches the app's own page.
 *   const banners = useProvisioningBanners(sources);
 *   if (banners.length === 0 || location.pathname === '/configuration') {
 *     return null;
 *   }
 *   return (
 *     <div className={s.stack}>
 *       {banners.map((b) => (
 *         <Banner key={b.id} {...b}>
 *           <Link to="/configuration" className={s.action}>Open configuration</Link>
 *         </Banner>
 *       ))}
 *     </div>
 *   );
 */
import { useEffect, useState, type ReactNode } from 'react';
import s from './ProvisioningBanner.module.css';

export interface ProvisioningBannerSpec {
  id: string;
  tone: 'warning' | 'info';
  title: string;
  body: ReactNode;
}

export type ProvisioningBannerSource =
  () => Promise<ProvisioningBannerSpec | null>;

interface BannerProps extends ProvisioningBannerSpec {
  children?: ReactNode;
}

export function Banner({ tone, title, body, children }: BannerProps) {
  return (
    <div className={`${s.banner} ${tone === 'warning' ? s.warning : s.info}`}>
      <div className={s.bannerIcon} aria-hidden>
        {tone === 'warning' ? '⚠' : 'ℹ'}
      </div>
      <div className={s.bannerMain}>
        <div className={s.bannerTitle}>{title}</div>
        <div className={s.bannerBody}>{body}</div>
      </div>
      {children}
    </div>
  );
}

/**
 * Run every source in parallel and collect the banners to show.
 *
 * A source that THROWS is not "provisioned": it is "unknown". This used to
 * map a rejection to `null` — the same value a passing check returns — so
 * a check that failed (expired token, 403, network) made an unprovisioned
 * workspace look healthy and hid the banner that would have said so. A
 * failure now becomes an `info` banner naming the check and the error, so
 * the page still renders and the user can see the check did not run.
 *
 * The name comes from the source function's `name` (a named function or a
 * `const checkSearches = async () => …` both carry one); an anonymous
 * source is reported by its position.
 */
export async function collectProvisioningBanners(
  sources: ProvisioningBannerSource[],
): Promise<ProvisioningBannerSpec[]> {
  const results = await Promise.all(
    sources.map(async (src, index): Promise<ProvisioningBannerSpec | null> => {
      try {
        return await src();
      } catch (err) {
        return checkFailedBanner(src, index, err);
      }
    }),
  );
  return results.filter((r): r is ProvisioningBannerSpec => r !== null);
}

function checkFailedBanner(
  src: ProvisioningBannerSource,
  index: number,
  err: unknown,
): ProvisioningBannerSpec {
  const name = src.name ? src.name : `provisioning check ${index + 1}`;
  const message = err instanceof Error ? err.message : String(err);
  return {
    id: `provisioning-check-failed:${src.name || index}`,
    tone: 'info',
    title: `Couldn't check ${name}`,
    body: message || 'The check failed without a message.',
  };
}

/**
 * Runs each source once on mount and returns the banners to show
 * (see {@link collectProvisioningBanners}). A source that throws yields
 * an informational "Couldn't check …" banner rather than crashing the
 * page header or silently passing. Re-runs when `sources` changes
 * identity — keep the array stable (useMemo, module-level constant)
 * to avoid refetch loops.
 */
export function useProvisioningBanners(
  sources: ProvisioningBannerSource[],
): ProvisioningBannerSpec[] {
  const [banners, setBanners] = useState<ProvisioningBannerSpec[]>([]);

  useEffect(() => {
    let cancelled = false;
    void collectProvisioningBanners(sources).then((results) => {
      if (!cancelled) setBanners(results);
    });
    return () => {
      cancelled = true;
    };
  }, [sources]);

  return banners;
}
