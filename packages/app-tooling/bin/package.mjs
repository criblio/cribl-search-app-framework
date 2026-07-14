#!/usr/bin/env node
import { packageApp } from '../src/pack.mjs';

try {
  const artifact = await packageApp(process.cwd());
  console.log(`Package created: ${artifact}`);
} catch (error) {
  console.error(`Package failed: ${error.message}`);
  process.exit(1);
}
