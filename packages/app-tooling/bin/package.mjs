#!/usr/bin/env node
import { parseArgsOrExit } from '../src/cli-args.mjs';
import { packageApp } from '../src/pack.mjs';

const USAGE = `Usage: cribl-app-package

DEPRECATED: use \`apps package\` from @cribl/apps. Packs dist/ and
config/proxies.yml into build/<name>-<version>.tgz. Takes no options.`;

parseArgsOrExit(process.argv.slice(2), {}, { command: 'cribl-app-package', usage: USAGE });

// Superseded by `apps package` from @cribl/apps, which is now the only
// packer that can ship backend functions: it writes `default/backend.yml`
// alongside the bundles `apps build` produced, and this one knows nothing
// about either — nor about config/policies.yml, config/schedules.yml or the
// README the platform copies into the archive.
//
// Kept working, not removed, for apps generated before the scaffold
// contract landed. The warning says exactly what to change, because a bare
// "deprecated" printed on every `npm run package` is noise nobody acts on.
console.warn(
  'cribl-app-package is deprecated: switch the app\'s package script to `apps package` (@cribl/apps).\n' +
  '  1. npm install --save-dev --save-exact @cribl/apps\n' +
  '  2. package.json: "package": "apps package" (and append " && apps build" to "build" if the app has backend/)\n' +
  '  3. @criblio/app-tooling >= 0.4.2, whose deploy follows the version bump `apps package` makes\n' +
  '     (it increments package.json on every run; `npm run package -- --version X.Y.Z` pins it).\n' +
  'This packer omits config/backend.yml, policies.yml, schedules.yml and README.md.',
);

try {
  const artifact = await packageApp(process.cwd());
  console.log(`Package created: ${artifact}`);
} catch (error) {
  console.error(`Package failed: ${error.message}`);
  process.exit(1);
}
