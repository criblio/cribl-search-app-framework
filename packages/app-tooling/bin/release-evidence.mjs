#!/usr/bin/env node
import { createReleaseEvidence } from '../src/release-evidence.mjs';

try {
  const args = process.argv.slice(2);
  const requireEmptyProxies = args.includes('--require-empty-proxies');
  const artifactIndex = args.indexOf('--artifact');
  const artifact = artifactIndex >= 0 ? args[artifactIndex + 1] : undefined;
  const manifestIndex = args.indexOf('--proxies-manifest');
  const proxiesManifest = manifestIndex >= 0 ? args[manifestIndex + 1] : undefined;
  if (manifestIndex >= 0 && !proxiesManifest) throw new Error('--proxies-manifest requires a path');
  const metadata = await createReleaseEvidence({
    root: process.cwd(),
    artifact,
    requireEmptyProxies,
    proxiesManifest,
  });
  console.log(`Release evidence created for ${metadata.artifact_sha256}`);
} catch (error) {
  console.error(`Release evidence failed: ${error.message}`);
  process.exit(1);
}
