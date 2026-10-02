import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { VerticalNavigation } from '@capra/core';
import { PATHS } from '../routes/paths';

interface NavItem {
  label: string;
  to: string;
  icon: ReactNode;
}

const ICON_PROPS = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const NAV: NavItem[] = [
  {
    label: 'Overview', to: PATHS.overview,
    icon: <svg {...ICON_PROPS}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>,
  },
];

const GEAR = <svg {...ICON_PROPS}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;

/** `/` matches exactly; every other item matches itself and its sub-paths. */
const active = (pathname: string, to: string) =>
  to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);

/**
 * Items navigate with `onClick` + `navigate()`, never `href`: a Capra item
 * given `href` is a plain `<a>` that reloads the iframe onto a path the host
 * does not serve. That works in local dev and breaks only when deployed.
 * One ItemList, and no app name or logo: the host shell shows those.
 */
export default function Sidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <VerticalNavigation>
      <VerticalNavigation.ItemList>
        {NAV.map((item) => (
          <VerticalNavigation.Item
            key={item.to}
            label={item.label}
            icon={item.icon}
            isActive={active(pathname, item.to)}
            onClick={() => navigate(item.to)}
          />
        ))}
      </VerticalNavigation.ItemList>
      <VerticalNavigation.Footer>
        <VerticalNavigation.Item
          label="Configuration"
          icon={GEAR}
          isActive={active(pathname, PATHS.configuration)}
          onClick={() => navigate(PATHS.configuration)}
        />
      </VerticalNavigation.Footer>
    </VerticalNavigation>
  );
}
