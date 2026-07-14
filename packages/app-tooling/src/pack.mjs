import { createWriteStream } from 'node:fs';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { runCommand } from './process.mjs';

let packageInProgress = false;

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Create a deterministic Cribl App tgz stream from an app root. */
export async function createAppPack({ root = process.cwd(), dev = false } = {}) {
  const rootDir = resolve(root);
  const buildDir = join(rootDir, 'package-build');
  const distDir = join(rootDir, 'dist');
  const proxiesPath = join(rootDir, 'config', 'proxies.yml');

  if (await pathExists(buildDir)) await rm(buildDir, { recursive: true });
  await mkdir(join(buildDir, 'static'), { recursive: true });
  await mkdir(join(buildDir, 'default'), { recursive: true });

  if (!dev) {
    if (!(await pathExists(distDir))) throw new Error('dist folder not found. Run the app build first.');
    await cp(distDir, join(buildDir, 'static'), { recursive: true });
  }
  if (!(await pathExists(proxiesPath))) {
    throw new Error('config/proxies.yml is required for an auditable Cribl App package');
  }
  await cp(proxiesPath, join(buildDir, 'default', 'proxies.yml'));

  const sourcePackage = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  const packageInfo = Object.fromEntries(
    ['name', 'version', 'displayName', 'description', 'author', 'license']
      .filter((key) => sourcePackage[key])
      .map((key) => [key, sourcePackage[key]]),
  );
  if (dev && packageInfo.name) {
    packageInfo.name = `__dev__${packageInfo.name}`;
    packageInfo.displayName = `__dev__${packageInfo.displayName || packageInfo.name}`;
  }
  await writeFile(join(buildDir, 'package.json'), JSON.stringify(packageInfo, null, 2));

  const child = spawn('tar', [
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf',
    '-',
    '-C',
    'package-build',
    '.',
  ], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] });

  const closePromise = new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      await rm(buildDir, { recursive: true }).catch(() => undefined);
      if (error) reject(error);
      else resolvePromise();
    };
    child.once('error', (error) => {
      child.stdout.destroy(error);
      void finish(error);
    });
    child.once('close', (code) => {
      void finish(code === 0 ? null : new Error(`tar exited with code ${code}`));
    });
  });
  return { closePromise, stdout: child.stdout };
}

/** Write one deterministic release candidate into the app's build directory. */
export async function packageApp(root = process.cwd()) {
  const rootDir = resolve(root);
  const pkg = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  const outputDir = join(rootDir, 'build');
  const artifact = join(outputDir, `${pkg.name || 'app'}-${pkg.version || '0.0.0'}.tgz`);
  await mkdir(outputDir, { recursive: true });
  const { closePromise, stdout } = await createAppPack({ root: rootDir });
  await Promise.all([pipeline(stdout, createWriteStream(artifact)), closePromise]);
  return artifact;
}

/** Vite development handler for packaging through the local app server. */
export async function servePackageTgz(req, res, root) {
  if (packageInProgress) {
    res.statusCode = 503;
    res.setHeader('Retry-After', '30');
    res.setHeader('Content-Type', 'text/plain');
    res.end('Package build in progress. Retry in 30 seconds.');
    return;
  }
  packageInProgress = true;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const dev = url.searchParams.get('dev') === 'true';
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const baseName = pkg.name ?? 'app';
    const tgzBase = dev ? `__dev__${baseName}` : baseName;
    const tgzName = `${tgzBase}-${pkg.version ?? '0.0.0'}.tgz`;
    if (!dev) await runCommand('npm', ['run', 'build'], root, { capture: true });
    const { closePromise, stdout } = await createAppPack({ root, dev });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${tgzName}"`);
    await Promise.all([pipeline(stdout, res), closePromise]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain');
      res.end(`Package failed: ${message}`);
    } else if (!res.writableEnded) {
      res.destroy();
    }
  } finally {
    packageInProgress = false;
  }
}
