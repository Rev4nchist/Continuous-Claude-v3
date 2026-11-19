#!/usr/bin/env node
/**
 * Record sha256 of each hook build input in dist/.build-inputs.json.
 *
 * `inputs`: the walk matches listSrcFiles in src/shared/dist-freshness.ts:
 * every src .ts file except __tests__ and node_modules. Keys are
 * posix paths relative to src/. Mtime is not recorded.
 *
 * `external` (item 14, coord-hooks-followups): every other file the bundler
 * read, from the esbuild metafile `<root>/.build-meta.json` (the build script
 * passes --metafile=.build-meta.json). The bundles import files outside
 * .claude/hooks, such as scripts/github/lib/decisions.mjs. Keys are posix paths
 * relative to the repo root (<root>/../..), sorted; each value is { sha256 }. Files under any
 * node_modules folder are left out (the lockfile covers them), and so are
 * files outside the repo. No metafile: exit 1, and the old manifest stays.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'));
const srcRoot = join(root, 'src');
const distDir = join(root, 'dist');
const repoRoot = resolve(root, '..', '..');
const metaPath = join(root, '.build-meta.json');

function list(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) list(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
}

// Same CR strip as sha256() in src/shared/dist-freshness.ts. LF and CRLF
// copies of one source record one hash.
const hashOf = (file) => createHash('sha256').update(readFileSync(file).toString('utf8').replace(/\r/g, '')).digest('hex');
const posix = (p) => p.split('\\').join('/');

/** Repo-relative posix keys of the metafile inputs that are outside src, outside node_modules and inside the repo, sorted. */
function externalFiles() {
  if (!existsSync(metaPath)) {
    process.stderr.write(`write-build-inputs: no esbuild metafile at ${metaPath}. Build with --metafile=.build-meta.json; the manifest was not written.\n`);
    process.exit(1);
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const keys = new Set();
  for (const input of Object.keys(meta.inputs ?? {})) {
    const abs = resolve(root, posix(input));
    if (posix(abs).split('/').includes('node_modules')) continue;
    const inSrc = relative(srcRoot, abs);
    if (!inSrc.startsWith('..') && !isAbsolute(inSrc)) continue;
    const key = posix(relative(repoRoot, abs));
    if (key.startsWith('..') || isAbsolute(key)) continue;
    keys.add(key);
  }
  return [...keys].sort();
}

const external = {};
for (const key of externalFiles()) {
  const file = join(repoRoot, key);
  // An object, not a bare hash: a path that holds "key" (answer-key.mjs) next to a 64-hex value is a gitleaks generic-api-key match.
  if (existsSync(file)) external[key] = { sha256: hashOf(file) };
}

const files = [];
list(srcRoot, files);
const inputs = {};
for (const file of files) inputs[posix(relative(srcRoot, file))] = hashOf(file);

if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
writeFileSync(
  join(distDir, '.build-inputs.json'),
  JSON.stringify({ version: 1, algorithm: 'sha256', inputs, external }, null, 2) + '\n',
);
