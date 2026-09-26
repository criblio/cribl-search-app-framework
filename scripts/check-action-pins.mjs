/**
 * Assert every SHA-pinned local action declares the inputs the skeleton
 * passes it.
 *
 * The skeleton pins `release-build` by commit SHA — supply-chain hygiene
 * every other step follows — which means the workflow and the action it
 * calls are versioned independently and can silently disagree. They did:
 * #63 added an `app-version` input to the action and started passing it
 * from `skeleton/release.yml`, but left the pin at a SHA predating the
 * input. A composite action only WARNS about an input it does not declare,
 * so the value was dropped and the release-version pinning that input
 * exists to provide never ran. Nothing failed; every gate stayed green for
 * three weeks.
 *
 * Checking the other direction too — a declared-but-unpassed REQUIRED input
 * — costs nothing and catches the inverse mistake, where a pin moves
 * forward onto an action that now demands something the template does not
 * send.
 *
 * This deliberately FAILS when it cannot read a pinned SHA rather than
 * skipping it. CI checks out shallow, so "the commit isn't here" is the
 * normal case, and a check that passes when it cannot see the thing it
 * guards is exactly the failure being fixed.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = join(root, 'skeleton', '.github', 'workflows');

/** `criblio/cribl-search-app-framework/.github/actions/<name>@<ref>` */
const LOCAL_ACTION = /^criblio\/cribl-search-app-framework\/\.github\/actions\/([^@]+)@(.+)$/;

const failures = [];
const fail = (message) => failures.push(message);

/** Every `uses:` of a local action, with the inputs that step passes. */
function pinnedUses() {
  const found = [];
  for (const name of readdirSync(workflowDir)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    const file = join('skeleton/.github/workflows', name);
    const doc = parse(readFileSync(join(workflowDir, name), 'utf8'));
    for (const job of Object.values(doc?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const match = typeof step?.uses === 'string' && LOCAL_ACTION.exec(step.uses);
        if (!match) continue;
        found.push({
          file,
          action: match[1],
          ref: match[2],
          inputs: Object.keys(step.with ?? {}),
        });
      }
    }
  }
  return found;
}

/**
 * Read a file at a commit, fetching it first if the shallow clone lacks it.
 *
 * Returns null only when the ref genuinely cannot be resolved, which the
 * caller reports as a failure — never as a pass.
 */
function readAtRef(ref, path) {
  const show = () => execFileSync('git', ['show', `${ref}:${path}`], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    return show();
  } catch {
    /* not in the local (likely shallow) history yet — try to fetch it */
  }
  try {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', ref], {
      cwd: root, stdio: 'ignore',
    });
    return show();
  } catch {
    return null;
  }
}

const uses = pinnedUses();
if (uses.length === 0) fail('no SHA-pinned local action found in skeleton/.github/workflows');

// One read per (action, ref); several workflows usually share a pin.
const byPin = new Map();
for (const use of uses) {
  const key = `${use.action}@${use.ref}`;
  if (!byPin.has(key)) byPin.set(key, []);
  byPin.get(key).push(use);
}

for (const [key, group] of byPin) {
  const { action, ref } = group[0];
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    fail(`${key} is not pinned to a full 40-character commit SHA (${group.map((g) => g.file).join(', ')})`);
    continue;
  }
  const source = readAtRef(ref, `.github/actions/${action}/action.yml`);
  if (source === null) {
    fail(
      `cannot read .github/actions/${action}/action.yml at ${ref}. The pin may name a commit ` +
      'that does not exist, or the fetch failed. Not treating this as a pass — an unreadable ' +
      'pin is the case this check exists to catch.',
    );
    continue;
  }
  const declared = parse(source)?.inputs ?? {};
  const names = new Set(Object.keys(declared));

  for (const use of group) {
    for (const input of use.inputs) {
      if (!names.has(input)) {
        fail(
          `${use.file} passes \`${input}\` to ${key}, which declares no such input ` +
          `(it has: ${[...names].join(', ') || 'none'}). A composite action only WARNS about an ` +
          'unknown input, so the value is silently dropped. Bump the pinned SHA to a commit that ' +
          'declares it.',
        );
      }
    }
  }

  // The inverse: a pin moved onto an action that now demands something the
  // template does not send.
  for (const [name, spec] of Object.entries(declared)) {
    if (spec?.required !== true || spec?.default !== undefined) continue;
    const passedBy = group.filter((use) => use.inputs.includes(name));
    if (passedBy.length !== group.length) {
      const missing = group.filter((use) => !use.inputs.includes(name)).map((use) => use.file);
      fail(`${key} requires input \`${name}\`, which ${missing.join(', ')} does not pass`);
    }
  }
}

if (failures.length > 0) {
  console.error('Pinned action inputs do not match the workflows that call them:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const summary = [...byPin.keys()].map((key) => key.replace(/@([0-9a-f]{7})[0-9a-f]+$/, '@$1')).join(', ');
console.log(`action pins verified: ${summary} (${uses.length} call site${uses.length === 1 ? '' : 's'})`);
