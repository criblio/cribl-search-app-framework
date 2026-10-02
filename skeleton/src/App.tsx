import type { ReactNode } from 'react';
import { BrowserRouter, Route, Routes, useHref, useNavigate } from 'react-router-dom';
import { RouterProvider } from '@capra/core';
import { ResilienceBoundary } from '@criblio/app-utils/resilience-boundary';
import AppShell from './components/AppShell';
import { PATHS } from './routes/paths';
import OverviewPage from './routes/OverviewPage';
import ConfigurationPage from './routes/ConfigurationPage';
import NotFoundPage from './routes/NotFoundPage';

/**
 * Routes React Router's navigate/useHref into Capra (react-aria) so Capra
 * `Link`/`ButtonLink` navigate client-side instead of reloading the iframe.
 * Must sit inside BrowserRouter.
 */
function CapraRouterBridge({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <RouterProvider navigate={navigate} useHref={useHref}>
      {children}
    </RouterProvider>
  );
}

/** One page's render exception blanks that page, not the app. */
function contained(name: string, page: ReactNode): ReactNode {
  return <ResilienceBoundary title={`${name} is temporarily unavailable`}>{page}</ResilienceBoundary>;
}

export default function App() {
  return (
    <BrowserRouter basename={window.CRIBL_BASE_PATH ?? '/'}>
      <CapraRouterBridge>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={contained('Overview', <OverviewPage />)} />
            <Route path={PATHS.configuration} element={contained('Configuration', <ConfigurationPage />)} />
            {/* A renamed path redirects with replace: <Route path="/old" element={<Navigate to="/new" replace />} /> */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </CapraRouterBridge>
    </BrowserRouter>
  );
}
