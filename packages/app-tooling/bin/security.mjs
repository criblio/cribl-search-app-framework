#!/usr/bin/env node
import { parseArgsOrExit } from '../src/cli-args.mjs';
import { runStaticSecurityChecks } from '../src/security.mjs';

const USAGE = `Usage: cribl-app-security

Run the static security checks (SHA-pinned Actions, dependency licenses,
tracked secrets) for the app in the current directory. Takes no options.`;

parseArgsOrExit(process.argv.slice(2), {}, { command: 'cribl-app-security', usage: USAGE });

try {
  await runStaticSecurityChecks(process.cwd());
  console.log('Static security checks passed');
} catch (error) {
  console.error(`Static security checks failed: ${error.message}`);
  process.exit(1);
}
