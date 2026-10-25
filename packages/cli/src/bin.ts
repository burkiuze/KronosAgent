#!/usr/bin/env node
import { main } from './main.js';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`Kronos needs Node.js 20 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`\x1b[31m✗ ${(e as Error)?.message ?? String(e)}\x1b[0m`);
  if (process.env.KRONOS_DEBUG) console.error(e);
  process.exit(1);
});
