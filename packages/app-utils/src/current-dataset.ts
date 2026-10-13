/**
 * The React-free store behind `useDataset()` / `getCurrentDataset()`.
 *
 * Kept apart from `./dataset.ts` (which imports `react`) so the metrics
 * client, which also runs in Node, can recognise the app's Search dataset
 * without pulling React into a server bundle. Not a public subpath: apps
 * use `@criblio/app-utils/dataset`.
 */

import { createStore } from './create-store.js';

/** The app's current Search dataset. Empty until a provider sets it. */
export const currentDatasetStore = createStore('');
