#!/usr/bin/env node
import { deployApp } from '../src/deploy.mjs';

try {
  const args = process.argv.slice(2);
  const artifactIndex = args.indexOf('--artifact');
  const artifact = artifactIndex >= 0 ? args[artifactIndex + 1] : undefined;
  if (artifactIndex >= 0 && !artifact) throw new Error('--artifact requires a path');
  const manifestIndex = args.indexOf('--proxies-manifest');
  const proxiesManifest = manifestIndex >= 0 ? args[manifestIndex + 1] : undefined;
  if (manifestIndex >= 0 && !proxiesManifest) throw new Error('--proxies-manifest requires a path');
  const result = await deployApp({
    root: process.cwd(),
    artifact,
    requireEmptyProxies: args.includes('--require-empty-proxies'),
    proxiesManifest,
    requireNoPolicies: args.includes('--require-no-policies'),
    provision: !args.includes('--no-provision'),
  });
  // An ambiguous install is reported loudly and still exits 0: the expected
  // version IS installed, so failing the run would be wrong — but printing
  // only the success line would hide the one fact the operator needs.
  if (result.installed?.warning) {
    console.error(`WARNING: ${result.installed.warning}`);
  }
  const note = result.installed?.unchanged
    ? ' (already installed)'
    : result.installed?.reconciled
      ? ' (reconciled after an ambiguous install response)'
      : '';
  console.log(`Deployment passed${note}: ${result.artifact}`);
} catch (error) {
  console.error(`Deployment failed: ${error.message}`);
  process.exit(1);
}
