/**
 * The dataset clause every query builder starts from. Queries read the
 * CURRENT dataset (set by DatasetProvider and the configuration page),
 * never a literal: `kqlDatasetId` throws on '' because `dataset=""` reads
 * nothing and reports success.
 *
 * `source` is a function on purpose: call it when a query is built, never
 * at module scope. DatasetProvider sets the default during its first
 * render, after every module has been imported, so a module-scope
 * `const Q = source() + ' | …'` reads '' and throws.
 *
 * Put query builders beside this file (`src/data/queries.ts`), one exported
 * function per query, so tests can snapshot and guard each of them.
 */
import { getCurrentDataset } from '@criblio/app-utils/dataset';
import { kqlDatasetId } from '@criblio/app-utils/kql';

export const source = (): string => `dataset="${kqlDatasetId(getCurrentDataset())}"`;
