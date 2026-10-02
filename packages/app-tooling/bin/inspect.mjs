#!/usr/bin/env node
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgsOrExit } from '../src/cli-args.mjs';
import { formatInspection, inspectPack } from '../src/inspect.mjs';

const USAGE = `Usage: cribl-app-inspect [options] [artifact.tgz]

Inspect a packaged app. Defaults to build/<name>-<version>.tgz.

Options:
  --proxies-manifest <path>    Require the packaged proxies.yml to equal this file
  --require-empty-proxies      Refuse any external proxy capability
  -h, --help                   Show this help`;

const { values, positionals } = parseArgsOrExit(process.argv.slice(2), {
  flags: {
    '--proxies-manifest': 'string',
    '--require-empty-proxies': 'boolean',
  },
  positionals: 1,
}, { command: 'cribl-app-inspect', usage: USAGE });

try {
  const root = process.cwd();
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const artifact = positionals[0] ?? join(root, 'build', `${pkg.name}-${pkg.version}.tgz`);
  const report = await inspectPack(artifact, {
    root,
    requireEmptyProxies: values['--require-empty-proxies'] === true,
    proxiesManifest: values['--proxies-manifest'],
  });
  console.log(formatInspection(report));
} catch (error) {
  console.error(`Pack inspection failed: ${error.message}`);
  process.exit(1);
}
