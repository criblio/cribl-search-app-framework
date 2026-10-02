/** Types for `@criblio/app-tooling/deploy`. Hand-written: the module is plain ESM. */

/** The app's `package.json` fields the install path reads. */
export interface DeployPackageInfo {
  name: string;
  version: string;
  displayName?: string;
  [key: string]: unknown;
}

/** An installed-app record as the Cribl apps API returns it. */
export interface InstalledAppRecord {
  id?: string;
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface InstallResult {
  items?: InstalledAppRecord[];
  count?: number;
  /** Same version already installed; nothing was uploaded over it. */
  unchanged?: boolean;
  /** Set when the outcome needed explaining (same-version skip, or an
   * install error reconciled by reading the record back). */
  warning?: string;
  [key: string]: unknown;
}

export interface InstallUploadedPackOptions {
  /** Workspace base URL, no trailing slash. */
  baseUrl: string;
  token: string;
  /** The `source` id the upload returned. */
  source: string;
  pkg: DeployPackageInfo;
}

/** Install or upgrade an uploaded pack without force. An ambiguous install
 * error is reconciled by reading the installed record back, never retried. */
export function installUploadedPack(options: InstallUploadedPackOptions): Promise<InstallResult>;

export interface DeployAppOptions {
  /** App root. Default `process.cwd()`. */
  root?: string;
  /** Existing artifact to deploy; otherwise `npm run package` builds one. */
  artifact?: string;
  requireEmptyProxies?: boolean;
  /** Expected proxies.yml, relative to `root`. */
  proxiesManifest?: string;
  requireNoPolicies?: boolean;
  /** Run `scripts/provision.ts` after install when present. Default true. */
  provision?: boolean;
}

export interface DeployResult {
  artifact: string;
  source: string;
  installed: InstallResult;
}

/** Validate and install or upgrade one exact Cribl App candidate without
 * force. Reads `CRIBL_BASE_URL`, `CRIBL_CLIENT_ID`, `CRIBL_CLIENT_SECRET`
 * from the environment or the app's `.env`. */
export function deployApp(options?: DeployAppOptions): Promise<DeployResult>;
