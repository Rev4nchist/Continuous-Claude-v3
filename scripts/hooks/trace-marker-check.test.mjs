// Tests for scripts/hooks/trace-marker-check.mjs, the check hook-contract-guard.mjs runs for the tracer.
//
// How it can fail, one test each:
//   scripts.build loses --inject:src/lib/trace-boot.ts and the check still passes
//   a registered dist has no marker and the check still passes
//   zero registered dists exist (0 of 0) and the check passes (a vacuous gate)
//   fewer marked dists than the floor pass
//   a registered name with no dist (a plugin or dist-only hook) is wrongly a finding
//   a dist has the marker string but not the injected boot call (another import of trace-boot, or a lost call) and the check passes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { traceMarkerFindings, TRACE_MARKER, BOOT_CALL_TOKEN } from './trace-marker-check.mjs';

const BUILD_OK = 'esbuild src/*.ts --bundle --inject:src/lib/trace-boot.ts --outdir=dist';
function hooksDir({ build = BUILD_OK, dists = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tmc-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build } }));
  for (const [name, text] of Object.entries(dists)) writeFileSync(join(dir, 'dist', `${name}.mjs`), text);
  return dir;
}
// What a real bundle carries: the marker string, and the boot call with its sentinel argument.
const marked = `var m = "${TRACE_MARKER}";\nbootTrace(process.env, "${BOOT_CALL_TOKEN}");\n`;
const names = (n) => Array.from({ length: n }, (_, i) => `h${i}`);
const allMarked = (n) => Object.fromEntries(names(n).map((x) => [x, marked]));

test('every registered dist marked, the flag present, count at the floor: no findings', () => {
  const dir = hooksDir({ dists: allMarked(5) });
  assert.deepEqual(traceMarkerFindings({ hooksDir: dir, names: names(5), minCount: 5 }), []);
});

test('a build line without --inject is a finding', () => {
  const dir = hooksDir({ build: 'esbuild src/*.ts --bundle', dists: allMarked(5) });
  const f = traceMarkerFindings({ hooksDir: dir, names: names(5), minCount: 5 });
  assert.ok(f.some((x) => x.kind === 'trace-inject-missing'), JSON.stringify(f));
});

test('a registered dist without the marker is a finding that names it', () => {
  const dists = { ...allMarked(5), h2: '// no marker\n' };
  const f = traceMarkerFindings({ hooksDir: hooksDir({ dists }), names: names(5), minCount: 4 });
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'trace-marker-missing');
  assert.match(f[0].detail, /h2/);
});

test('zero registered names, or zero dists on disk, is a finding, never a pass', () => {
  const dir = hooksDir({ dists: allMarked(5) });
  assert.ok(traceMarkerFindings({ hooksDir: dir, names: [], minCount: 5 }).some((x) => x.kind === 'trace-marker-vacuous'));
  assert.ok(traceMarkerFindings({ hooksDir: hooksDir(), names: names(5), minCount: 5 }).some((x) => x.kind === 'trace-marker-vacuous'));
});

test('fewer marked dists than the floor is a finding', () => {
  const dir = hooksDir({ dists: allMarked(3) });
  const f = traceMarkerFindings({ hooksDir: dir, names: names(3), minCount: 60 });
  assert.ok(f.some((x) => x.kind === 'trace-marker-count-regression'), JSON.stringify(f));
});

test('a registered name with no dist file is skipped, not a finding', () => {
  const dir = hooksDir({ dists: allMarked(5) });
  const f = traceMarkerFindings({ hooksDir: dir, names: [...names(5), 'plugin-only'], minCount: 5 });
  assert.deepEqual(f, []);
});

test('a dist with the marker string but no boot call is a finding that names it', () => {
  const markerOnly = `var m = "${TRACE_MARKER}";
export function appendTraceRow() {}
`;
  const dists = { ...allMarked(5), h3: markerOnly };
  const f = traceMarkerFindings({ hooksDir: hooksDir({ dists }), names: names(5), minCount: 4 });
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].kind, 'trace-boot-call-missing');
  assert.match(f[0].detail, /h3/);
});

test('the token in a comment is not the boot call', () => {
  const dists = { ...allMarked(5), h1: `var m = "${TRACE_MARKER}";
// ${BOOT_CALL_TOKEN}
` };
  const f = traceMarkerFindings({ hooksDir: hooksDir({ dists }), names: names(5), minCount: 4 });
  assert.ok(f.some((x) => x.kind === 'trace-boot-call-missing' && /h1/.test(x.detail)), JSON.stringify(f));
});

// Ruling B item 1 (card hook-build-run-lock): `build` is the wrapper line and the esbuild line moved to `build:raw`.
// The check reads build:raw first, then build, and still fails closed when neither carries the flag.
const WRAPPER_LINE = 'node scripts/build-with-lock.mjs';
function hooksDirScripts(scripts, dists = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tmc-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
  for (const [name, text] of Object.entries(dists)) writeFileSync(join(dir, 'dist', `${name}.mjs`), text);
  return dir;
}

test('a wrapper build line with the flag in build:raw is no finding', () => {
  const dir = hooksDirScripts({ build: WRAPPER_LINE, 'build:raw': BUILD_OK }, allMarked(5));
  assert.deepEqual(traceMarkerFindings({ hooksDir: dir, names: names(5), minCount: 5 }), []);
});

test('a wrapper build line with no flag in build:raw is a finding (the guard fails closed)', () => {
  const dir = hooksDirScripts({ build: WRAPPER_LINE, 'build:raw': 'esbuild src/*.ts --bundle' }, allMarked(5));
  const f = traceMarkerFindings({ hooksDir: dir, names: names(5), minCount: 5 });
  assert.ok(f.some((x) => x.kind === 'trace-inject-missing'), JSON.stringify(f));
});

test('a wrapper build line and no build:raw at all is a finding', () => {
  const dir = hooksDirScripts({ build: WRAPPER_LINE }, allMarked(5));
  const f = traceMarkerFindings({ hooksDir: dir, names: names(5), minCount: 5 });
  assert.ok(f.some((x) => x.kind === 'trace-inject-missing'), JSON.stringify(f));
});

// Seat ruling B, item 1 changed (07:03 CST): read the line that RUNS. build:raw counts only behind the wrapper. A plain build line with no flag
// is a finding even when build:raw holds the flag (the real build runs the plain line and drops the tracer).
test('a plain esbuild build line with no flag is a finding even when build:raw holds the flag (the line that runs decides)', () => {
  const dir = hooksDirScripts({ build: 'esbuild src/*.ts --bundle', 'build:raw': BUILD_OK }, allMarked(5));
  const f = traceMarkerFindings({ hooksDir: dir, names: names(5), minCount: 5 });
  assert.ok(f.some((x) => x.kind === 'trace-inject-missing'), JSON.stringify(f));
});

test('a package.json with no build line at all is a finding, even when build:raw holds the flag', () => {
  const dir = hooksDirScripts({ 'build:raw': BUILD_OK }, allMarked(5));
  const f = traceMarkerFindings({ hooksDir: dir, names: names(5), minCount: 5 });
  assert.ok(f.some((x) => x.kind === 'trace-inject-missing'), JSON.stringify(f));
});

// CLI run 2 minor 1 (seat 07:22): the wrapper test is exact. Only a trimmed scripts.build equal to the wrapper line is the wrapper; a line that only names the
// file (an echo, a comment) is read as itself.
test('a build line that only names build-with-lock.mjs in an echo is read as itself, not as the wrapper', () => {
  const echoLine = 'echo build-with-lock.mjs && esbuild src/*.ts --bundle';
  const dir = hooksDirScripts({ build: echoLine, 'build:raw': BUILD_OK }, allMarked(5));
  const f = traceMarkerFindings({ hooksDir: dir, names: names(5), minCount: 5 });
  assert.ok(f.some((x) => x.kind === 'trace-inject-missing'), JSON.stringify(f));
});

test('the wrapper line is exact: surrounding spaces are trimmed, extra words are not the wrapper', async () => {
  const mod = await import('./trace-marker-check.mjs');
  assert.equal(mod.buildLineThatRuns({ build: `  ${WRAPPER_LINE}  `, 'build:raw': BUILD_OK }), BUILD_OK);
  assert.equal(mod.buildLineThatRuns({ build: `${WRAPPER_LINE} && true`, 'build:raw': BUILD_OK }), `${WRAPPER_LINE} && true`);
  assert.equal(mod.buildLineThatRuns({ build: `# ${WRAPPER_LINE}`, 'build:raw': BUILD_OK }), `# ${WRAPPER_LINE}`);
});

test('buildLineThatRuns is build:raw behind the wrapper and build otherwise (one helper for every reader)', async () => {
  const mod = await import('./trace-marker-check.mjs');
  assert.equal(typeof mod.buildLineThatRuns, 'function', 'trace-marker-check.mjs must export buildLineThatRuns');
  assert.equal(mod.buildLineThatRuns({ build: WRAPPER_LINE, 'build:raw': BUILD_OK }), BUILD_OK);
  assert.equal(mod.buildLineThatRuns({ build: BUILD_OK }), BUILD_OK);
  assert.equal(mod.buildLineThatRuns({ build: 'esbuild src/*.ts', 'build:raw': BUILD_OK }), 'esbuild src/*.ts');
  assert.equal(mod.buildLineThatRuns({ build: WRAPPER_LINE }), '', 'the wrapper with no build:raw runs nothing');
  assert.equal(mod.buildLineThatRuns({}), '');
});

test('a dist with the boot call counts toward the floor only once it has both', () => {
  const dists = { ...allMarked(3), h3: `var m = "${TRACE_MARKER}";
`, h4: `var m = "${TRACE_MARKER}";
` };
  const f = traceMarkerFindings({ hooksDir: hooksDir({ dists }), names: names(5), minCount: 5 });
  assert.ok(f.some((x) => x.kind === 'trace-marker-count-regression'), JSON.stringify(f));
});
