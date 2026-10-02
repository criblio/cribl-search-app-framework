/** Types for `@criblio/app-tooling/security`. Hand-written: the module is plain ESM.
 * Every check rejects with a descriptive error and resolves to nothing on success. */

/** Every `uses:` under `.github/` must be pinned to a full commit SHA. */
export function checkActionsPinned(root?: string): Promise<void>;
/** No copyleft or unlicensed package in `package-lock.json`. */
export function checkDependencyLicenses(root?: string): Promise<void>;
/** No obvious secret in any tracked or untracked-but-not-ignored file. */
export function scanTrackedSecrets(root?: string): Promise<void>;
/** All three checks, in order. */
export function runStaticSecurityChecks(root?: string): Promise<void>;
