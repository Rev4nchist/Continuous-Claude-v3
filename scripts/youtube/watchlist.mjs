#!/usr/bin/env node
// Compatibility alias. The version-2 source registry is canonical; invoking an
// old watchlist command lazily migrates watchlist.json without modifying it.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { YT_ROOT } from './lib/config.mjs';

const [command = 'list', ...args] = process.argv.slice(2);
const translated = [command, ...args];
if (command === 'add' && !args.includes('--topic')) translated.push('--topic', 'Uncategorized');
const result = spawnSync(process.execPath, [join(YT_ROOT, 'source.mjs'), ...translated], {
  encoding: 'utf8', windowsHide: true, input: '', timeout: 20 * 60 * 1000,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
