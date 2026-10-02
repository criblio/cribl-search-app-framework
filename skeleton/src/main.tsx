import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ResilienceBoundary } from '@criblio/app-utils/resilience-boundary';
import { DatasetProvider } from '@criblio/app-utils/dataset-provider';
// Capra styles, in this order: theme tokens, icons, components. The app's
// own stylesheet comes last so its rules win.
import '@capra/theme/base.css';
import '@capra/icons/styles.css';
import '@capra/core/styles.css';
import './styles/global.css';
import App from './App';
import { DEFAULT_SETTINGS } from './settings';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ResilienceBoundary title="APPNAME could not start">
      {/* Sets the default dataset before any child renders, then applies the saved one. */}
      <DatasetProvider defaultDataset={DEFAULT_SETTINGS.dataset}>
        <App />
      </DatasetProvider>
    </ResilienceBoundary>
  </StrictMode>,
);
