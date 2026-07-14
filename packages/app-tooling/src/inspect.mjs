import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

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
  { root = process.cwd(), requireEmptyProxies = false } = {},
) {
  const rootDir = resolve(root);
  const artifact = resolve(rootDir, artifactPath);
  const sourcePackage = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  const listing = (await tarText(rootDir, ['-tzf', artifact]))
    .split('\n')
    .map((entry) => entry.replace(/^\.\//, ''))
    .filter(Boolean);
  const files = listing.filter((entry) => !entry.endsWith('/'));
  const unexpected = files.filter((entry) =>
    entry !== 'package.json' &&
    entry !== 'default/proxies.yml' &&
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
  if (!files.some((entry) => /^static\/assets\/.*\.js$/.test(entry))) {
    throw new Error('pack contains no compiled JavaScript asset');
  }
  return { artifact, files, manifest, proxies };
}

export function formatInspection(report) {
  return `Pack inspection passed: ${basename(report.artifact)} (${report.files.length} files)`;
}
