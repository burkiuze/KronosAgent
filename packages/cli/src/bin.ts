#!/usr/bin/env node
import { main } from './main.js';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`Kronos needs Node.js 20 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

// `kronos run … | head` closes our stdout early: that's a normal way to stop, not a crash
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`\x1b[31m✗ ${(e as Error)?.message ?? String(e)}\x1b[0m`);
  if (process.env.KRONOS_DEBUG) console.error(e);
  process.exit(1);
});
