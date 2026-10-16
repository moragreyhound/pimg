#!/usr/bin/env node
import { cliMain } from '../src/cli.js';

// Inside a compiled SEA binary there is no script argument; this Node build
// reports argv as [exe, exe, ...userArgs], so drop the duplicated entry.
let args = process.argv.slice(2);
try {
  if ((await import('node:sea')).isSea() && args[0] === process.execPath) {
    args = args.slice(1);
  }
} catch {
  /* not a SEA binary */
}

const code = await cliMain(args);
process.exit(code ?? 0);
