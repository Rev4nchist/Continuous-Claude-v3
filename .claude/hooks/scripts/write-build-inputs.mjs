#!/usr/bin/env node
/**
 * Record sha256 of each hook build input in dist/.build-inputs.json.
 *
 * The walk matches listSrcFiles in src/shared/dist-freshness.ts:
 * every src .ts file except __tests__ and node_modules. Keys are
 * posix paths relative to src/. Mtime is not recorded.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'));
const srcRoot = join(root, 'src');
const distDir = join(root, 'dist');

function list(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) list(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
}

const files = [];
list(srcRoot, files);
const inputs = {};
for (const file of files) {
  // Same CR strip as sha256() in src/shared/dist-freshness.ts. LF and CRLF
  // copies of one source record one hash.
  const text = readFileSync(file).toString('utf8').replace(/\r/g, '');
  inputs[relative(srcRoot, file).split('\\').join('/')] = createHash('sha256').update(text).digest('hex');
}
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
writeFileSync(
  join(distDir, '.build-inputs.json'),
  JSON.stringify({ version: 1, algorithm: 'sha256', inputs }, null, 2) + '\n',
);
