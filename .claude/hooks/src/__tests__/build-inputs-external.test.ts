/**
 * Item 14 (coord-hooks-followups): the build manifest hashes every input the bundler read, not only hooks/src.
 * The bundles import files outside .claude/hooks (scripts/github/lib/decisions.mjs and others). Before this change an edit to one
 * of them left a stale dist that the session-start freshness line never saw.
 *
 * Failure list (one test each):
 *   F1 an input outside src in the metafile is missing from `external`
 *   F2 a node_modules input appears in `external`
 *   F3 CRLF and LF copies of one external file give two hashes
 *   F4 a missing metafile writes a manifest anyway (silent), or changes the old one
 *   F5 assessTreeFreshness misses a changed or a deleted external file
 *   F6 a manifest with no `external` field stops loading or reports stale
 *   F8 `external` keys are unsorted, hold a backslash, or are not repo-relative
 *   Wiring: the build script stops writing the metafile the writer reads
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessTreeFreshness, loadBuildInputs } from '../shared/dist-freshness.js';

const here = dirname(fileURLToPath(import.meta.url));
const hooksRoot = resolve(here, '..', '..');
const writer = join(hooksRoot, 'scripts', 'write-build-inputs.mjs');

interface Fixture { repo: string; hooks: string; src: string; dist: string }

function fixture(): Fixture {
  const repo = mkdtempSync(join(tmpdir(), 'build-inputs-ext-'));
  const hooks = join(repo, '.claude', 'hooks');
  const src = join(hooks, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'a.ts'), 'export const a = 1;\n');
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'lib', 'zeta.mjs'), 'export const z = 1;\n');
  writeFileSync(join(repo, 'scripts', 'lib', 'alpha.mjs'), 'export const y = 2;\n');
  mkdirSync(join(hooks, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(hooks, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  return { repo, hooks, src, dist: join(hooks, 'dist') };
}

/** A metafile in the form esbuild writes: input paths relative to the folder the build ran in (the hooks root). */
function writeMeta(f: Fixture, inputs: string[]): void {
  const obj = { inputs: Object.fromEntries(inputs.map(k => [k, { bytes: 1, imports: [] }])), outputs: {} };
  writeFileSync(join(f.hooks, '.build-meta.json'), JSON.stringify(obj));
}

const ALL_INPUTS = ['src/a.ts', '../../scripts/lib/zeta.mjs', '../../scripts/lib/alpha.mjs', 'node_modules/pkg/index.js', '../node_modules/other/i.js'];
const runWriter = (f: Fixture) => spawnSync(process.execPath, [writer, f.hooks], { encoding: 'utf8' });
const manifest = (f: Fixture) => JSON.parse(readFileSync(join(f.dist, '.build-inputs.json'), 'utf8'));
const withFixture = (fn: (f: Fixture) => void) => { const f = fixture(); try { fn(f); } finally { rmSync(f.repo, { recursive: true, force: true }); } };

describe('build manifest: external inputs (item 14)', () => {
  it('F1. an input outside hooks/src that the bundler read is recorded in external (break: the metafile is not read)', () => withFixture((f) => {
    writeMeta(f, ALL_INPUTS);
    expect(runWriter(f).status).toBe(0);
    const m = manifest(f);
    expect(Object.keys(m.external)).toContain('scripts/lib/zeta.mjs');
    expect(m.inputs['a.ts']).toMatch(/^[0-9a-f]{64}$/);
  }));

  it('F2. no node_modules input is recorded in external (break: the filter)', () => withFixture((f) => {
    writeMeta(f, ALL_INPUTS);
    runWriter(f);
    expect(Object.keys(manifest(f).external).filter(k => k.includes('node_modules'))).toEqual([]);
  }));

  it('F3. CRLF and LF copies of one external file record one hash (break: no CR strip)', () => withFixture((f) => {
    writeMeta(f, ALL_INPUTS);
    runWriter(f);
    const lf = manifest(f).external['scripts/lib/zeta.mjs'];
    writeFileSync(join(f.repo, 'scripts', 'lib', 'zeta.mjs'), 'export const z = 1;\r\n');
    runWriter(f);
    expect(manifest(f).external['scripts/lib/zeta.mjs']).toEqual(lf);
    expect(lf.sha256).toMatch(/^[0-9a-f]{64}$/);
  }));

  it('F4. with no metafile the writer exits 1 and leaves the old manifest unchanged (break: a silent manifest without external)', () => withFixture((f) => {
    writeMeta(f, ALL_INPUTS);
    runWriter(f);
    const before = readFileSync(join(f.dist, '.build-inputs.json'), 'utf8');
    unlinkSync(join(f.hooks, '.build-meta.json'));
    const r = runWriter(f);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/metafile/);
    expect(readFileSync(join(f.dist, '.build-inputs.json'), 'utf8')).toBe(before);
  }));

  it('F5. assessTreeFreshness reports a changed external file and a deleted one as stale (break: externals not checked)', () => withFixture((f) => {
    writeMeta(f, ALL_INPUTS);
    runWriter(f);
    expect(assessTreeFreshness(f.src, f.dist, f.repo).state).toBe('fresh');
    writeFileSync(join(f.repo, 'scripts', 'lib', 'zeta.mjs'), 'export const z = 2;\n');
    const changed = assessTreeFreshness(f.src, f.dist, f.repo);
    expect(changed.state).toBe('stale');
    expect(changed.staleExternal).toEqual(['scripts/lib/zeta.mjs']);
    unlinkSync(join(f.repo, 'scripts', 'lib', 'alpha.mjs'));
    expect(assessTreeFreshness(f.src, f.dist, f.repo).staleExternal).toEqual(['scripts/lib/alpha.mjs', 'scripts/lib/zeta.mjs']);
  }));

  it('F6. a manifest with no external field still loads and a matching tree is fresh (break: version handling)', () => withFixture((f) => {
    writeMeta(f, ALL_INPUTS);
    runWriter(f);
    const m = manifest(f);
    delete m.external;
    writeFileSync(join(f.dist, '.build-inputs.json'), JSON.stringify(m));
    const loaded = loadBuildInputs(f.dist);
    expect(loaded?.inputs['a.ts']).toBe(m.inputs['a.ts']);
    expect(loaded?.external).toEqual({});
    expect(assessTreeFreshness(f.src, f.dist, f.repo).state).toBe('fresh');
  }));

  it('F6b. loadBuildInputs carries external (break: the loader returns only version, algorithm and inputs)', () => withFixture((f) => {
    writeMeta(f, ALL_INPUTS);
    runWriter(f);
    expect(loadBuildInputs(f.dist)?.external).toEqual(manifest(f).external);
  }));

  it('F8. external keys are sorted, posix and repo-relative, in the written file too (break: metafile order or backslashes reach the committed manifest)', () => withFixture((f) => {
    writeMeta(f, ['src/a.ts', '../../scripts/lib/zeta.mjs', '..\\..\\scripts\\lib\\alpha.mjs']);
    runWriter(f);
    const text = readFileSync(join(f.dist, '.build-inputs.json'), 'utf8');
    const keys = Object.keys(JSON.parse(text).external);
    expect(keys).toEqual(['scripts/lib/alpha.mjs', 'scripts/lib/zeta.mjs']);
    expect(text.indexOf('alpha.mjs')).toBeLessThan(text.indexOf('zeta.mjs'));
    expect(keys.every(k => !k.includes('\\') && !k.startsWith('.') && !k.startsWith('/'))).toBe(true);
  }));

  // Follow-up of PR 656 (CodeRabbit CLI finding 1): a non-.ts input under hooks/src, such as src/shared/malicious-packages.json
  // (a json import that the daily blocklist job edits), was skipped by the src filter and never hashed.
  const JSON_KEY = '.claude/hooks/src/shared/data.json';
  const withJson = (f: Fixture) => {
    mkdirSync(join(f.src, 'shared'), { recursive: true });
    writeFileSync(join(f.src, 'shared', 'data.json'), '{"npm":{}}\n');
    writeMeta(f, [...ALL_INPUTS, 'src/shared/data.json']);
  };

  it('G1. a non-.ts input under hooks/src is recorded in external and a .ts src input is not (break: the in-src filter drops every src file)', () => withFixture((f) => {
    withJson(f);
    expect(runWriter(f).status).toBe(0);
    const m = manifest(f);
    expect(m.external[JSON_KEY]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(m.external).filter(k => k.endsWith('.ts'))).toEqual([]);
    expect(Object.keys(m.inputs)).not.toContain('shared/data.json');
  }));

  it('G2. editing that json makes the tree stale and names it (break: the json is not hashed)', () => withFixture((f) => {
    withJson(f);
    runWriter(f);
    expect(assessTreeFreshness(f.src, f.dist, f.repo).state).toBe('fresh');
    writeFileSync(join(f.src, 'shared', 'data.json'), '{"npm":{"evil":1}}\n');
    const r = assessTreeFreshness(f.src, f.dist, f.repo);
    expect(r.state).toBe('stale');
    expect(r.staleExternal).toEqual([JSON_KEY]);
  }));

  it('Wiring. the build script writes the metafile the writer reads (break: --metafile dropped from package.json)', () => {
    const scripts = JSON.parse(readFileSync(join(hooksRoot, 'package.json'), 'utf8')).scripts;
    const build: string = scripts['build:raw'] ?? scripts.build; // scripts.build runs the run-lock wrapper; the esbuild line is build:raw
    expect(build).toContain('--metafile=.build-meta.json');
  });
});
