#!/usr/bin/env node
import { createReleaseEvidence } from '../src/release-evidence.mjs';

try {
  const args = process.argv.slice(2);
  const requireEmptyProxies = args.includes('--require-empty-proxies');
  const artifactIndex = args.indexOf('--artifact');
  const artifact = artifactIndex >= 0 ? args[artifactIndex + 1] : undefined;
  const metadata = await createReleaseEvidence({
    root: process.cwd(),
    artifact,
    requireEmptyProxies,
  });
  console.log(`Release evidence created for ${metadata.artifact_sha256}`);
} catch (error) {
  console.error(`Release evidence failed: ${error.message}`);
  process.exit(1);
}
