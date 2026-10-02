#!/usr/bin/env node
import { parseArgsOrExit } from '../src/cli-args.mjs';
import { createReleaseEvidence } from '../src/release-evidence.mjs';

const USAGE = `Usage: cribl-app-release-evidence [options]

Write checksum, SBOM and provenance metadata for the release artifact.

Options:
  --artifact <path>            Artifact to attest (default build/<name>-<version>.tgz)
  --proxies-manifest <path>    Require the packaged proxies.yml to equal this file
  --require-empty-proxies      Refuse any external proxy capability
  -h, --help                   Show this help`;

const { values } = parseArgsOrExit(process.argv.slice(2), {
  flags: {
    '--artifact': 'string',
    '--proxies-manifest': 'string',
    '--require-empty-proxies': 'boolean',
  },
}, { command: 'cribl-app-release-evidence', usage: USAGE });

try {
  const metadata = await createReleaseEvidence({
    root: process.cwd(),
    artifact: values['--artifact'],
    requireEmptyProxies: values['--require-empty-proxies'] === true,
    proxiesManifest: values['--proxies-manifest'],
  });
  console.log(`Release evidence created for ${metadata.artifact_sha256}`);
} catch (error) {
  console.error(`Release evidence failed: ${error.message}`);
  process.exit(1);
}
