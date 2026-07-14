#!/usr/bin/env node
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { formatInspection, inspectPack } from '../src/inspect.mjs';

try {
  const root = process.cwd();
  const args = process.argv.slice(2);
  const requireEmptyProxies = args.includes('--require-empty-proxies');
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const artifact = positional[0] ?? join(root, 'build', `${pkg.name}-${pkg.version}.tgz`);
  const report = await inspectPack(artifact, { root, requireEmptyProxies });
  console.log(formatInspection(report));
} catch (error) {
  console.error(`Pack inspection failed: ${error.message}`);
  process.exit(1);
}
