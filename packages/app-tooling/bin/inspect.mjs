#!/usr/bin/env node
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { formatInspection, inspectPack } from '../src/inspect.mjs';

try {
  const root = process.cwd();
  const args = process.argv.slice(2);
  const requireEmptyProxies = args.includes('--require-empty-proxies');
  const manifestIndex = args.indexOf('--proxies-manifest');
  const proxiesManifest = manifestIndex >= 0 ? args[manifestIndex + 1] : undefined;
  if (manifestIndex >= 0 && !proxiesManifest) throw new Error('--proxies-manifest requires a path');
  const positional = args.filter(
    (arg, index) => !arg.startsWith('--') && (manifestIndex < 0 || index !== manifestIndex + 1),
  );
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const artifact = positional[0] ?? join(root, 'build', `${pkg.name}-${pkg.version}.tgz`);
  const report = await inspectPack(artifact, { root, requireEmptyProxies, proxiesManifest });
  console.log(formatInspection(report));
} catch (error) {
  console.error(`Pack inspection failed: ${error.message}`);
  process.exit(1);
}
