import type { FrameLocator, Page } from '@playwright/test';
import type { SearchJobOptions } from '@criblio/app-utils/search-job';

export interface CriblCredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface HostGlobalsOptions extends CriblCredentials {
  /** App id; the app path defaults to `/app-ui/<appId>/`. */
  appId?: string;
  /** Explicit app path (e.g. `/app-ui/my-app/`); wins over `appId`. */
  appPath?: string;
}

/** Identify the app by `appPath` alone (the id is parsed from it with
 * `appIdFromPath`) or by `appId`. */
export interface AppTarget {
  appId?: string;
  appPath?: string;
}

export interface GotoAppOptions {
  appPath?: string;
  /** In-app path. The shell ignores deep paths today; navigate inside the frame instead. */
  path?: string;
  /** How long to wait for the app iframe to attach (default 30 000 ms). */
  timeoutMs?: number;
}

export interface LoginSetupOptions {
  email: string;
  password: string;
  /** Where to save the authenticated storage state, e.g. `playwright/.auth/cribl-cloud.json`. */
  storageStatePath?: string;
  /** Page to open first (default `/`, resolved against Playwright's baseURL). */
  baseUrl?: string;
}

export function appPathFor(appId: string): string;
/** `/app-ui/<id>/` (or a full URL / deep path under it) → `<id>`; throws otherwise. */
export function appIdFromPath(appPath: string): string;
export function loadTestEnv(path?: string, env?: NodeJS.ProcessEnv): Record<string, string>;
export function criblCredentialsFromEnv(env?: NodeJS.ProcessEnv): CriblCredentials;
export function hostGlobalsInitScript(args: [basePath: string, apiUrl: string, token: string]): void;
export function installCriblHostGlobals(page: Page, options: HostGlobalsOptions): Promise<void>;
export function appFrameSelector(appId: string): string;
export function appFrame(page: Page, app: string | AppTarget): FrameLocator;
export const KNOWN_HOST_ANNOUNCEMENTS: RegExp[];
export function dismissHostAnnouncements(page: Page, signatures?: RegExp[]): Promise<void>;
export function gotoApp(page: Page, appId: string, options?: GotoAppOptions): Promise<FrameLocator>;
export function gotoApp(page: Page, target: AppTarget & Omit<GotoAppOptions, 'appPath'>): Promise<FrameLocator>;
export function loginSetup(page: Page, options: LoginSetupOptions): Promise<void>;
export function runSearch(
  credentials: CriblCredentials,
  query: string,
  options?: SearchJobOptions,
): Promise<Record<string, unknown>[]>;
