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
 *   const banners = useProvisioningBanners(sources);
 *   if (banners.length === 0 || location.pathname === '/settings') {
 *     return null;
 *   }
 *   return (
 *     <div className={s.stack}>
 *       {banners.map((b) => (
 *         <Banner key={b.id} {...b}>
 *           <Link to="/settings" className={s.action}>Open settings</Link>
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
 * Runs each source once on mount and returns the non-null specs.
 * Source failures are swallowed (treated as "no banner") so a flaky
 * check can't crash the page header. Re-runs when `sources` changes
 * identity — keep the array stable (useMemo, module-level constant)
 * to avoid refetch loops.
 */
export function useProvisioningBanners(
  sources: ProvisioningBannerSource[],
): ProvisioningBannerSpec[] {
  const [banners, setBanners] = useState<ProvisioningBannerSpec[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      sources.map((src) =>
        src().catch(() => null as ProvisioningBannerSpec | null),
      ),
    ).then((results) => {
      if (cancelled) return;
      setBanners(
        results.filter((r): r is ProvisioningBannerSpec => r !== null),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [sources]);

  return banners;
}
