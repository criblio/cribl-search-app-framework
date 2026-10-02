#!/usr/bin/env node
import { parseArgsOrExit } from '../src/cli-args.mjs';
import { deployApp } from '../src/deploy.mjs';

const USAGE = `Usage: cribl-app-deploy [options]

Verify, package, upload and install this app on the workspace in .env.

Options:
  --dry-run                    Build and inspect the artifact, read the installed
                               version, and print what would happen. Uploads,
                               installs and provisions nothing.
  --artifact <path>            Deploy an existing .tgz instead of running
                               \`npm run verify\` and \`npm run package\`
  --proxies-manifest <path>    Require the packaged proxies.yml to equal this file
  --require-empty-proxies      Refuse any external proxy capability
  --require-no-policies        Refuse any declared policy
  --no-provision               Skip scripts/provision.ts after install
  -h, --help                   Show this help`;

// Parsed BEFORE anything runs: an unknown flag must never fall through to a
// real deploy (`--dry` used to do exactly that).
const { values } = parseArgsOrExit(process.argv.slice(2), {
  flags: {
    '--dry-run': 'boolean',
    '--artifact': 'string',
    '--proxies-manifest': 'string',
    '--require-empty-proxies': 'boolean',
    '--require-no-policies': 'boolean',
    '--no-provision': 'boolean',
  },
}, { command: 'cribl-app-deploy', usage: USAGE });

try {
  const result = await deployApp({
    root: process.cwd(),
    artifact: values['--artifact'],
    requireEmptyProxies: values['--require-empty-proxies'] === true,
    proxiesManifest: values['--proxies-manifest'],
    requireNoPolicies: values['--require-no-policies'] === true,
    provision: values['--no-provision'] !== true,
    dryRun: values['--dry-run'] === true,
  });
  if (result.dryRun) {
    const plan = result.dryRun;
    console.log(`Dry run: nothing was uploaded, installed or provisioned.`);
    console.log(`  artifact:  ${result.artifact} (${plan.bytes} bytes, sha256 ${plan.sha256})`);
    console.log(`  workspace: ${plan.baseUrl}`);
    console.log(`  installed: ${plan.installedVersion ?? 'not installed'}`);
    console.log(`  would:     ${plan.action} ${plan.pkg.name}@${plan.pkg.version}`);
    if (plan.provision) console.log('  then:      run scripts/provision.ts');
    if (plan.restoredPackageJson) {
      console.log('  note:      packaging bumped package.json; the dry run restored it');
    }
    process.exit(0);
  }
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
