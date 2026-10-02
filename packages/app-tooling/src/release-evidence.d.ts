/** Types for `@criblio/app-tooling/release-evidence`. Hand-written: the module is plain ESM. */

export interface CreateReleaseEvidenceOptions {
  /** App root. Default `process.cwd()`. */
  root?: string;
  /** Artifact path; default `build/<name>-<version>.tgz`. */
  artifact?: string;
  requireEmptyProxies?: boolean;
  proxiesManifest?: string;
}

/** Also written to `build/<name>-<version>.release-metadata.json`. */
export interface ReleaseMetadata {
  artifact: string;
  artifact_sha256: string;
  source_commit: string;
  framework_sha?: string;
  package_lock_sha256: string;
  node: string;
}

/** Inspect the artifact, then write its checksum, provenance metadata and
 * production CycloneDX SBOM beside it under `build/`. */
export function createReleaseEvidence(options?: CreateReleaseEvidenceOptions): Promise<ReleaseMetadata>;
