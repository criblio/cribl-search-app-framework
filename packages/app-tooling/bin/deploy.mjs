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
  const unchanged = result.installed?.unchanged ? ' (already installed)' : '';
  console.log(`Deployment passed${unchanged}: ${result.artifact}`);
} catch (error) {
  console.error(`Deployment failed: ${error.message}`);
  process.exit(1);
}
