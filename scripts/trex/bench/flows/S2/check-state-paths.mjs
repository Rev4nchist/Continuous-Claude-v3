import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const empty = pathToFileURL(join(here, 'empty-module.mjs')).href;
const marker = join('apps', 'agentic-os', 'src', 'server', 'sources', 'state-files.ts');

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: empty, shortCircuit: true, format: 'module' };
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (relative && !/\.(?:[cm]?js|json|node|ts)$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});

function repoRoot() {
  for (const start of [process.cwd(), here]) {
    let dir = start;
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(join(dir, marker))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('state-files.ts not found');
}

const token = ['ghp', '_'].join('') + 'A'.repeat(36);
const raw = await readFile(join(here, 'fixtures', 'session.json'), 'utf8');
const dir = await mkdtemp(join(tmpdir(), 'trex-s2-'));
try {
  await writeFile(join(dir, 'session.json'), raw.replaceAll('__TOKEN__', token));
  process.env.AGENTIC_OS_STATE_DIR = dir;
  const src = pathToFileURL(join(repoRoot(), marker)).href;
  const { readStateFiles } = await import(src);
  const { snapshots } = await readStateFiles();
  if (snapshots.length !== 1) throw new Error(`expected 1 snapshot, got ${snapshots.length}`);
  process.stdout.write(`${JSON.stringify(snapshots[0])}\n`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
