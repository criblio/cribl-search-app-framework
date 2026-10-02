import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { UsageError, parseArgs } from '../src/cli-args.mjs';

const binDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const spec = { flags: { '--artifact': 'string', '--dry-run': 'boolean' } };

test('parses known boolean and string flags, both value spellings', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--artifact', 'a.tgz'], spec).values, {
    '--dry-run': true,
    '--artifact': 'a.tgz',
  });
  assert.deepEqual(parseArgs(['--artifact=b.tgz'], spec).values, { '--artifact': 'b.tgz' });
});

test('an unknown flag is an error, never ignored', () => {
  // The bug: `--dry` matched nothing, nothing complained, and the deploy was real.
  assert.throws(() => parseArgs(['--dry'], spec), (e) => e instanceof UsageError && /unknown option "--dry"/.test(e.message) && /--dry-run/.test(e.message));
  assert.throws(() => parseArgs(['-n'], spec), /unknown option "-n"/);
  assert.throws(() => parseArgs(['--x'], {}), /takes no options/);
});

test('missing values, repeated flags, values on booleans and stray positionals are errors', () => {
  assert.throws(() => parseArgs(['--artifact'], spec), /--artifact requires a value/);
  assert.throws(() => parseArgs(['--artifact', '--dry-run'], spec), /--artifact requires a value/);
  assert.throws(() => parseArgs(['--artifact='], spec), /--artifact requires a value/);
  assert.throws(() => parseArgs(['--dry-run', '--dry-run'], spec), /more than once/);
  assert.throws(() => parseArgs(['--dry-run=yes'], spec), /does not take a value/);
  // A shell glob matching two archives used to deploy whichever came first.
  assert.throws(() => parseArgs(['--artifact', 'a.tgz', 'b.tgz'], spec), /unexpected argument.*"b.tgz"/);
  assert.deepEqual(parseArgs(['x.tgz'], { positionals: 1 }).positionals, ['x.tgz']);
  assert.throws(() => parseArgs(['x.tgz', 'y.tgz'], { positionals: 1 }), /at most 1/);
});

test('--help is reported, and -- ends option parsing', () => {
  assert.equal(parseArgs(['--help'], spec).help, true);
  assert.equal(parseArgs(['-h'], spec).help, true);
  assert.deepEqual(parseArgs(['--', '--weird.tgz'], { positionals: 1 }).positionals, ['--weird.tgz']);
});

test('every bin rejects an unknown flag with exit 2 before doing any work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cribl-app-tooling-cli-'));
  try {
    // A package script that would leave a marker if anything ran. With real
    // credentials in the env, a parse that fell through would get as far as
    // `npm run verify`/`npm run package`; nothing may run at all.
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'cli-app',
      version: '1.0.0',
      scripts: { verify: 'node -e "require(\'fs\').writeFileSync(\'RAN\',\'\')"', package: 'node -e "require(\'fs\').writeFileSync(\'RAN\',\'\')"' },
    }));
    const env = {
      ...process.env,
      CRIBL_BASE_URL: 'https://example.invalid',
      CRIBL_CLIENT_ID: 'id',
      CRIBL_CLIENT_SECRET: 'secret',
    };
    for (const bin of await readdir(binDir)) {
      const result = spawnSync(process.execPath, [join(binDir, bin), '--dry'], { cwd: root, env, encoding: 'utf8' });
      assert.equal(result.status, 2, `${bin} exit status (stderr: ${result.stderr})`);
      assert.match(result.stderr, /unknown option "--dry"/, bin);
      assert.match(result.stderr, /Usage:/, bin);
      assert.doesNotMatch(result.stderr, /deprecated/, `${bin} did work before parsing`);
      const help = spawnSync(process.execPath, [join(binDir, bin), '--help'], { cwd: root, env, encoding: 'utf8' });
      assert.equal(help.status, 0, `${bin} --help`);
      assert.match(help.stdout, /Usage:/, bin);
    }
    assert.deepEqual((await readdir(root)).sort(), ['package.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
