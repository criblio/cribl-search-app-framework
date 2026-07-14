#!/usr/bin/env node
import { runStaticSecurityChecks } from '../src/security.mjs';

try {
  await runStaticSecurityChecks(process.cwd());
  console.log('Static security checks passed');
} catch (error) {
  console.error(`Static security checks failed: ${error.message}`);
  process.exit(1);
}
