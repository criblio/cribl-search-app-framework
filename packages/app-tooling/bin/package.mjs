#!/usr/bin/env node
import { packageApp } from '../src/pack.mjs';

// Superseded by `apps package` from @cribl/apps, which is now the only
// packer that can ship backend functions: it writes `default/backend.yml`
// alongside the bundles `apps build` produced, and this one knows nothing
// about either. An app that declares endpoints and packs with this gets an
// archive that installs and then 404s on its own endpoint.
//
// Kept working, not removed, for apps generated before the scaffold
// contract landed — those have no backend/ directory, so what this
// produces is still correct for them.
console.warn(
  'cribl-app-package is deprecated: use `apps package` (@cribl/apps), which is ' +
  'the only packer that ships backend endpoints. This command cannot package ' +
  'config/backend.yml or the bundles from `apps build`.',
);

try {
  const artifact = await packageApp(process.cwd());
  console.log(`Package created: ${artifact}`);
} catch (error) {
  console.error(`Package failed: ${error.message}`);
  process.exit(1);
}
