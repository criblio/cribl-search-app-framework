/** Types for `@criblio/app-tooling/inspect`. Hand-written: the module is plain ESM. */

export interface InspectPackOptions {
  /** App root holding `package.json`. Default `process.cwd()`. */
  root?: string;
  /** Fail when the packaged proxies.yml declares anything. */
  requireEmptyProxies?: boolean;
  /** Path (relative to `root`) of an expected proxies.yml to deep-compare
   * against. Mutually exclusive with `requireEmptyProxies`. */
  proxiesManifest?: string;
}

export interface PackInspection {
  /** Absolute artifact path. */
  artifact: string;
  /** Every file in the archive, without the leading `./`. */
  files: string[];
  /** The packaged `package.json`. */
  manifest: Record<string, unknown> & { name?: string; version?: string };
  /** The packaged `default/proxies.yml` text. */
  proxies: string;
  /** Endpoint bundle paths declared by `default/backend.yml` (relative to `default/`). */
  endpoints: string[];
}

/** Endpoint bundle paths declared in a packaged `default/backend.yml`. */
export function backendScripts(yamlText: string): string[];

/** Inspect an exact Cribl App archive before upload or publication.
 * Rejects with a descriptive error on any shape, identity, proxy or
 * backend-bundle problem. */
export function inspectPack(artifactPath: string, options?: InspectPackOptions): Promise<PackInspection>;

/** One-line summary of a passed inspection. */
export function formatInspection(report: Pick<PackInspection, 'artifact' | 'files'> & { endpoints?: string[] }): string;
