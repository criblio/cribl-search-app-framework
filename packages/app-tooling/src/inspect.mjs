import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { diffProxies, parseProxiesYaml } from './proxies.mjs';

/** Config files `apps package` places under `default/`. Only proxies.yml is
 *  required — an app that declares no API access, schedules, or endpoints
 *  simply has no policies/schedules/backend manifest to ship. */
const DEFAULT_CONFIG = ['proxies.yml', 'policies.yml', 'schedules.yml', 'backend.yml'];

/** Root files `apps package` copies verbatim. README.md is the app's
 *  customer-facing Marketplace overview — the scaffold ships one and the
 *  platform's own AGENTS.md documents it as intended to ship — so rejecting
 *  it failed every app that wrote one, with no opt-out in either the packer
 *  or this gate. Kept as an explicit list rather than "any root file":
 *  the point of this check is that nothing arrives in the archive by
 *  accident. */
const ROOT_FILES = ['package.json', 'README.md'];

/**
 * Endpoint bundle paths declared in a packaged `default/backend.yml`.
 *
 * `apps package` rewrites each endpoint's `script` from the authored `.ts`
 * to the built `.js`, relative to `default/`. Parsed by line rather than
 * with a YAML dependency: the one fact needed here is which bundles the
 * manifest claims, and that is a flat list of `script:` values.
 */
export function backendScripts(yamlText) {
  const scripts = [];
  for (const raw of yamlText.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^-?\s*script:\s*(.+?)\s*$/.exec(line);
    if (match) scripts.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return scripts;
}

const execFileAsync = promisify(execFile);

async function tarText(root, args) {
  const { stdout } = await execFileAsync('tar', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

/** Inspect an exact Cribl App archive before upload or publication. */
export async function inspectPack(
  artifactPath,
  { root = process.cwd(), requireEmptyProxies = false, proxiesManifest } = {},
) {
  if (requireEmptyProxies && proxiesManifest) {
    throw new Error('--require-empty-proxies and --proxies-manifest are mutually exclusive');
  }
  const rootDir = resolve(root);
  const artifact = resolve(rootDir, artifactPath);
  const sourcePackage = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  const listing = (await tarText(rootDir, ['-tzf', artifact]))
    .split('\n')
    .map((entry) => entry.replace(/^\.\//, ''))
    .filter(Boolean);
  const files = listing.filter((entry) => !entry.endsWith('/'));
  const unexpected = files.filter((entry) =>
    !ROOT_FILES.includes(entry) &&
    !DEFAULT_CONFIG.some((name) => entry === `default/${name}`) &&
    !entry.startsWith('default/backend/') &&
    !entry.startsWith('static/'));
  if (unexpected.length > 0) {
    throw new Error(`pack contains unexpected files: ${unexpected.join(', ')}`);
  }
  for (const required of ['package.json', 'default/proxies.yml']) {
    if (!files.includes(required)) throw new Error(`pack is missing ${required}`);
  }

  const manifest = JSON.parse(await tarText(rootDir, ['-xOzf', artifact, './package.json']));
  if (manifest.name !== sourcePackage.name || manifest.version !== sourcePackage.version) {
    throw new Error(
      `pack identity ${manifest.name}@${manifest.version} does not match package.json ` +
      `${sourcePackage.name}@${sourcePackage.version}`,
    );
  }
  if ('scripts' in manifest || 'dependencies' in manifest || 'devDependencies' in manifest) {
    throw new Error('pack manifest unexpectedly contains executable or dependency metadata');
  }

  const proxies = await tarText(rootDir, ['-xOzf', artifact, './default/proxies.yml']);
  const activeProxyLines = proxies
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (requireEmptyProxies && activeProxyLines.length > 0) {
    throw new Error(`pack declares external proxy capability: ${activeProxyLines.join(' ')}`);
  }
  if (proxiesManifest) {
    const manifestText = await readFile(resolve(rootDir, proxiesManifest), 'utf8');
    const differences = diffProxies(parseProxiesYaml(proxies), parseProxiesYaml(manifestText));
    if (differences.length > 0) {
      throw new Error(
        `packaged proxies.yml does not match ${proxiesManifest}:\n` +
        differences.map((entry) => `  - ${entry}`).join('\n'),
      );
    }
  }
  // The backend manifest and its bundles ship together or not at all: the
  // platform fuses each endpoint from the file `script` names, so a manifest
  // pointing at a bundle that never got built is an app that installs and
  // then 404s on its own endpoint. `apps build` runs separately from
  // `apps package`, so the two really can drift.
  const endpoints = [];
  if (files.includes('default/backend.yml')) {
    const backendYaml = await tarText(rootDir, ['-xOzf', artifact, './default/backend.yml']);
    for (const script of backendScripts(backendYaml)) {
      const packed = `default/${script}`;
      if (!files.includes(packed)) {
        throw new Error(`backend.yml declares ${script} but the pack has no ${packed}`);
      }
      endpoints.push(script);
    }
  }
  const orphans = files.filter(
    (entry) => entry.startsWith('default/backend/') && !endpoints.includes(entry.slice('default/'.length)),
  );
  if (orphans.length > 0) {
    throw new Error(`pack ships backend bundles no manifest declares: ${orphans.join(', ')}`);
  }

  if (!files.some((entry) => /^static\/assets\/.*\.js$/.test(entry))) {
    throw new Error('pack contains no compiled JavaScript asset');
  }
  return { artifact, files, manifest, proxies, endpoints };
}

export function formatInspection(report) {
  const endpoints = report.endpoints?.length
    ? `, ${report.endpoints.length} backend endpoint${report.endpoints.length === 1 ? '' : 's'}`
    : '';
  return `Pack inspection passed: ${basename(report.artifact)} (${report.files.length} files${endpoints})`;
}
