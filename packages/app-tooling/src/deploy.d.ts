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
  /** Existing artifact to deploy; otherwise `npm run package` builds one
   * and the artifact is named from package.json as it reads AFTER packaging
   * (`apps package` increments the version). */
  artifact?: string;
  requireEmptyProxies?: boolean;
  /** Expected proxies.yml, relative to `root`. */
  proxiesManifest?: string;
  requireNoPolicies?: boolean;
  /** Run `scripts/provision.ts` after install when present. Default true. */
  provision?: boolean;
  /** Build and inspect the artifact, read the installed record, and return
   * the plan in `DeployResult.dryRun` — nothing is uploaded, installed or
   * provisioned. A package.json bumped by packaging is restored. Default false. */
  dryRun?: boolean;
}

/** What a real deploy would have done. */
export interface DeployDryRunPlan {
  baseUrl: string;
  pkg: { name: string; version: string };
  bytes: number;
  sha256: string;
  /** `null` when the app is not installed. */
  installedVersion: string | null;
  action: 'install' | 'upgrade' | 'skip (same version already installed)';
  /** `scripts/provision.ts` would run after install. */
  provision: boolean;
  /** Packaging bumped package.json and the dry run wrote it back. */
  restoredPackageJson: boolean;
}

export interface DeployResult {
  artifact: string;
  source: string;
  installed: InstallResult;
}

/** `deployApp({ dryRun: true })`: the built artifact and the plan, no upload. */
export interface DeployDryRunResult {
  artifact: string;
  dryRun: DeployDryRunPlan;
}

/** Validate and install or upgrade one exact Cribl App candidate without
 * force. Reads `CRIBL_BASE_URL`, `CRIBL_CLIENT_ID`, `CRIBL_CLIENT_SECRET`
 * from the environment or the app's `.env`. */
export function deployApp(options: DeployAppOptions & { dryRun: true }): Promise<DeployDryRunResult>;
export function deployApp(options?: DeployAppOptions & { dryRun?: false }): Promise<DeployResult>;
export function deployApp(options?: DeployAppOptions): Promise<DeployResult | DeployDryRunResult>;
