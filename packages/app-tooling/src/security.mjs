import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function yamlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await yamlFiles(path));
    else if (/\.ya?ml$/.test(entry.name)) out.push(path);
  }
  return out;
}

export async function checkActionsPinned(root = process.cwd()) {
  const rootDir = resolve(root);
  const failures = [];
  for (const file of await yamlFiles(join(rootDir, '.github'))) {
    const text = await readFile(file, 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      const match = line.match(/\buses:\s*([^\s#]+)/);
      if (!match || match[1].startsWith('./')) continue;
      if (!/@[0-9a-f]{40}$/.test(match[1])) {
        failures.push(`${relative(rootDir, file)}:${index + 1}: ${match[1]}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`GitHub Actions must be pinned to full commit SHAs:\n${failures.join('\n')}`);
  }
}

export async function checkDependencyLicenses(root = process.cwd()) {
  const rootDir = resolve(root);
  const lock = JSON.parse(await readFile(join(rootDir, 'package-lock.json'), 'utf8'));
  const denied = /\b(?:AGPL|GPL|LGPL|SSPL|BUSL|Commons Clause|UNLICENSED)\b/i;
  const failures = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path || !path.startsWith('node_modules/')) continue;
    const license = typeof meta.license === 'string' ? meta.license : '';
    if (denied.test(license)) failures.push(`${path}: ${license || 'missing'}`);
  }
  if (failures.length > 0) {
    throw new Error(`dependency license policy failed:\n${failures.join('\n')}`);
  }
}

export async function scanTrackedSecrets(root = process.cwd()) {
  const rootDir = resolve(root);
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: rootDir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  const patterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    ['Cribl client secret assignment', /CRIBL_CLIENT_SECRET\s*=\s*[A-Za-z0-9_+\/=.-]{20,}/],
  ];
  const failures = [];
  for (const file of stdout.split('\0').filter(Boolean)) {
    if (file === 'package-lock.json' || file.endsWith('.snap')) continue;
    const buffer = await readFile(resolve(rootDir, file)).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!buffer || buffer.includes(0) || buffer.length > 5 * 1024 * 1024) continue;
    const text = buffer.toString('utf8');
    for (const [label, pattern] of patterns) {
      if (pattern.test(text)) failures.push(`${file}: ${label}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`potential committed secrets:\n${failures.join('\n')}`);
  }
}

export async function runStaticSecurityChecks(root = process.cwd()) {
  await checkActionsPinned(root);
  await checkDependencyLicenses(root);
  await scanTrackedSecrets(root);
}
