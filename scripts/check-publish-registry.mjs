#!/usr/bin/env node
/**
 * Every publishable package must target npmjs, publicly.
 *
 * This is a guard, not bookkeeping, and the failure it prevents is invisible
 * in the direction that matters: a package published to GitHub Packages
 * installs fine for anyone with a token, all tests pass, and the only thing
 * that breaks is an app GoatTown *generates*. `build_app` runs in a workerd
 * isolate with no filesystem and no npm — it rewrites every bare import into
 * an `https://esm.sh/<name>@<range>` URL, and esm.sh mirrors npmjs only. So
 * the wrong registry does not fail loudly at install time; it 404s at bundle
 * time in somebody else's repo.
 *
 * That already happened once. The skeleton's `src/api/cribl.ts` and
 * `src/api/appSettings.ts` re-export `@criblio/app-utils`, nothing else
 * imports those two files, so tree-shaking dropped them: the build went
 * green, the agent quietly wrote its own Cribl client, and an app that does
 * not use the framework shipped with no error anywhere.
 *
 * `access: public` is checked for the same class of reason. A scoped package
 * defaults to a *private* publish, which fails on the FIRST release of a new
 * package and only then — long after review.
 *
 * `license` is checked because npm does NOT warn about its absence, and the
 * consequence is not recoverable: a published version is immutable, so a
 * package that ships without the field reads as "all rights reserved" to
 * every consumer of that exact version, forever. Three of these four went
 * out that way on the first npmjs release before anyone noticed. A later
 * patch bump fixes the next version and nothing before it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WANT_REGISTRY = 'https://registry.npmjs.org';
const WANT_LICENSE = 'Apache-2.0';
const PACKAGES = 'packages';

const problems = [];
for (const dir of readdirSync(PACKAGES)) {
  const manifest = join(PACKAGES, dir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    continue; // not a package directory
  }
  if (pkg.private) continue; // never published, so the rule does not apply
  const cfg = pkg.publishConfig ?? {};
  // Absent is allowed: npm's default registry IS npmjs. Wrong is not.
  if (cfg.registry != null && cfg.registry.replace(/\/$/, '') !== WANT_REGISTRY) {
    problems.push(
      `${manifest}: publishConfig.registry is "${cfg.registry}" — must be ` +
        `"${WANT_REGISTRY}" (or absent). esm.sh mirrors npmjs only, so a ` +
        `package anywhere else cannot be imported by an app GoatTown builds.`,
    );
  }
  if (cfg.access !== 'public') {
    problems.push(
      `${manifest}: publishConfig.access must be "public" — a scoped package ` +
        `defaults to a private publish, which fails on a new package's first ` +
        `release and nowhere earlier.`,
    );
  }
  if (pkg.license !== WANT_LICENSE) {
    problems.push(
      `${manifest}: license must be "${WANT_LICENSE}" (got ` +
        `${pkg.license == null ? 'nothing' : `"${pkg.license}"`}). npm does ` +
        `not warn, and a published version is immutable — shipping without ` +
        `it means "all rights reserved" for that version permanently.`,
    );
  }
  // The field is the machine-readable half; the text has to be in the
  // tarball. npm includes a root LICENSE regardless of `files`, so the only
  // way to get this wrong is to not have the file.
  if (!existsSync(join(PACKAGES, dir, 'LICENSE'))) {
    problems.push(`${join(PACKAGES, dir)}/LICENSE is missing (copy the root LICENSE).`);
  }
}

if (problems.length) {
  console.error(`✗ publish config:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `✓ publish config: every package targets ${WANT_REGISTRY} publicly, ` +
    `${WANT_LICENSE}, with LICENSE in the tarball`,
);
