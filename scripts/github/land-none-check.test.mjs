// land-none-check.mjs: the land gate for a review:none PR at HIGH or CRITICAL (lane agent-self-approve-hole, Dave 2026-11-03: DETECT).
// land-pr.ps1 runs it before the merge. It passes only when Dave's own pick is on record for this head.
// Run: node --test scripts/github/land-none-check.test.mjs
//
// How it can fail, and the test that catches it:
//   a record for an older head (a push after the pick) lands                                  -> L1
//   a record for another PR lands                                                             -> L2
//   a pick that came from the bridge, from auto-confirm, or an old record with no `via` lands -> L3, L4
//   a record that Dave did not decide (decided_by default or auto) lands                      -> L5
//   no store file, or one that is not JSON, lets the PR land                                  -> L6, L7
//   the check blocks or reads the store for a PR below HIGH, or one without review:none       -> L8, L12
//   a CRITICAL PR with a valid record is refused, or a band that rose after the pick lands    -> L9, L10
//   a base that moved (live band lower than the record) refuses on the band                   -> L11b
//   a null band passes, or --warn blocks                                                      -> L11, L14
//   the line shows the wrong zone (CST in summer, CDT in winter)                              -> L13
//   a --head that differs from the PR head is accepted                                        -> L15
//   a valid record is refused, or the line is missing from the output                         -> L16
//   an unreadable `at` passes                                                                 -> L17
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const LIVE = JSON.parse(readFileSync(path.join(ROOT, 'review-router.config.json'), 'utf8'));
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const STORE = '/home/x/.claude/plugins/store/ccv3-mods_test.json';
const GLOB = '/home/x/.claude/plugins/store/ccv3-mods_*.json';
const GATE = ['.claude/hooks/src/pre-pr-gate.ts', 'scripts/github/review-status.mjs', 'scripts/github/review-router.mjs', 'scripts/github/cr-paid.mjs', 'scripts/github/land-pr.ps1'];

const load = () => import('./land-none-check.mjs');

const record = (over = {}) => ({
  pr: 7, state: 'applied', head: HEAD, pathway: 'none', label: 'review:none', decided_by: 'dave', via: 'dialog', band: 'HIGH', at: '2026-11-04T03:42:00.000Z', ...over,
});
const reads = (values, extra = {}) => () => ({ glob: GLOB, files: values.map(() => STORE), records: values.map((value) => ({ file: STORE, value })), bad: [], ...extra });
const NO_READ = () => { throw new Error('the store must not be read'); };
async function pick(over = {}, value = record()) {
  const { nonePick } = await load();
  return nonePick({ pr: 7, head: HEAD, labels: ['review:none'], band: 'HIGH', read: reads([value]), ...over });
}

test('L1: a record for an older head refuses and names both sha7', async () => {
  const r = await pick({}, record({ head: OLD }));
  assert.equal(r.ok, false);
  assert.match(r.problem, /bbbbbbb/);
  assert.match(r.problem, /aaaaaaa/);
});

test('L2: a record whose pr field is another PR refuses', async () => {
  assert.equal((await pick({}, record({ pr: 8 }))).ok, false);
});

test('L3: via bridge refuses at HIGH', async () => {
  const r = await pick({}, record({ via: 'bridge' }));
  assert.equal(r.ok, false);
  assert.match(r.problem, /bridge/);
});

test('L4: via auto and a record with no via both refuse at HIGH', async () => {
  const { via: _gone, ...noVia } = record();
  const auto = await pick({}, record({ via: 'auto' }));
  const none = await pick({}, noVia);
  assert.equal(auto.ok, false);
  assert.equal(none.ok, false);
  assert.match(auto.problem, /auto/);
  assert.match(none.problem, /via/);
  assert.equal((await pick()).ok, true, 'the same record with via dialog passes');
  assert.equal((await pick({}, record({ via: 'composer' }))).ok, true, 'via composer passes');
});

test('L5: decided_by default refuses', async () => {
  const r = await pick({}, record({ decided_by: 'default' }));
  assert.equal(r.ok, false);
  assert.match(r.problem, /decided_by/);
});

function cli(args, { fixture, store, storeText } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'land-none-'));
  try {
    const argv = [path.join(HERE, 'land-none-check.mjs'), '900', '--repo', 'o/r', '--head', HEAD, ...args];
    if (fixture) {
      const f = path.join(dir, 'land.json');
      writeFileSync(f, JSON.stringify(fixture));
      argv.push('--fixture', f);
    }
    const storeFile = path.join(dir, 'ccv3-mods_test.json');
    if (storeText !== undefined) writeFileSync(storeFile, storeText);
    else if (store) writeFileSync(storeFile, JSON.stringify(store));
    argv.push('--store', storeFile);
    const r = spawnSync(process.execPath, argv, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'invalid-token', GH_CONFIG_DIR: dir } });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, storeFile };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const fixture = (over = {}, config = LIVE) => ({
  pull: { number: 900, state: 'open', head: { sha: HEAD }, base: { ref: 'main', sha: 'c'.repeat(40) }, labels: [{ name: 'review:none' }], changed_files: GATE.length, ...over },
  files: GATE.map((filename) => ({ filename, additions: 10, deletions: 0 })),
  config,
});
const storeWith = (value) => ({ 'checkpoint:pr:900': value });

test('L6: no store file refuses and names the glob it read', async () => {
  const r = await pick({ read: () => ({ glob: GLOB, files: [], records: [], bad: [] }) });
  assert.equal(r.ok, false);
  assert.ok(r.problem.includes(GLOB), r.problem);
  const missing = cli([], { fixture: fixture() });
  assert.equal(missing.code, 1, missing.out);
  assert.ok(missing.out.includes(missing.storeFile), missing.out);
});

test('L7: a store file that is not JSON refuses and names the file', () => {
  const r = cli([], { fixture: fixture(), storeText: '{ not json' });
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(r.storeFile), r.out);
});

test('L8: band ELEVATED, MID or LOW with review:none needs no record and reads no store', async () => {
  for (const band of ['LOW', 'MID', 'ELEVATED']) {
    const r = await pick({ band, read: NO_READ });
    assert.equal(r.needed, false, band);
    assert.equal(r.ok, true, band);
  }
});

test('L9: a valid dialog record at CRITICAL passes and the line says CRITICAL', async () => {
  const r = await pick({ band: 'CRITICAL' }, record({ band: 'CRITICAL' }));
  assert.equal(r.ok, true, r.problem);
  assert.equal(r.needed, true);
  assert.match(r.line, /CRITICAL/);
  assert.match(r.line, /via dialog/);
});

test('L10: record band HIGH with live band CRITICAL refuses; a record with no band refuses', async () => {
  const rose = await pick({ band: 'CRITICAL' }, record({ band: 'HIGH' }));
  assert.equal(rose.ok, false);
  assert.match(rose.problem, /CRITICAL/);
  assert.equal((await pick({}, record({ band: null }))).ok, false);
});

test('L11: review:none with a null live band exits 2; with --warn it exits 0', () => {
  const noMatrix = fixture({}, { ...LIVE, matrix: undefined });
  const hard = cli([], { fixture: noMatrix, store: storeWith(record({ pr: 900 })) });
  assert.equal(hard.code, 2, hard.out);
  const soft = cli(['--warn'], { fixture: noMatrix, store: storeWith(record({ pr: 900 })) });
  assert.equal(soft.code, 0, soft.out);
  assert.match(soft.out, /band/i);
});

test('L11b: record band HIGH with live band ELEVATED (the base moved) does not refuse on the band', async () => {
  const r = await pick({ band: 'ELEVATED', read: NO_READ }, record({ band: 'HIGH' }));
  assert.equal(r.needed, false);
  assert.equal(r.ok, true);
});

test('L12: a PR without review:none needs no record and reads no store', async () => {
  for (const labels of [[], ['review:coderabbit'], ['review:deep']]) {
    const r = await pick({ labels, band: 'CRITICAL', read: NO_READ });
    assert.equal(r.needed, false);
    assert.equal(r.ok, true);
  }
});

test('L13: the line prints CST for a November time and CDT for a July time', async () => {
  const winter = await pick({}, record({ at: '2026-11-04T03:42:00.000Z' }));
  assert.match(winter.line, /^Dave chose none at 2026-11-03 21:42 CST via dialog, head aaaaaaa \(band HIGH, store /);
  const summer = await pick({}, record({ at: '2026-07-04T02:42:00.000Z' }));
  assert.match(summer.line, /at 2026-07-03 21:42 CDT via dialog/);
});

test('L14: --warn prints the refusal and exits 0; without it the same input exits 1', () => {
  const bridge = storeWith(record({ pr: 900, via: 'bridge' }));
  const hard = cli([], { fixture: fixture(), store: bridge });
  assert.equal(hard.code, 1, hard.out);
  const soft = cli(['--warn'], { fixture: fixture(), store: bridge });
  assert.equal(soft.code, 0, soft.out);
  assert.match(soft.out, /bridge/);
  assert.match(soft.out, /WARNING/);
});

test('L15: a --head that differs from the fixture head exits 2', () => {
  const r = cli([], { fixture: fixture({ head: { sha: OLD } }), store: storeWith(record({ pr: 900 })) });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /head/i);
});

test('L16: a valid record exits 0 and prints the provenance line', () => {
  const r = cli([], { fixture: fixture(), store: storeWith(record({ pr: 900 })) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Dave chose none at \d{4}-\d{2}-\d{2} \d{2}:\d{2} C[SD]T via dialog, head aaaaaaa \(band HIGH, store /);
});

test('L17: an `at` that is not a date refuses', async () => {
  const r = await pick({}, record({ at: 'yesterday-ish' }));
  assert.equal(r.ok, false);
  assert.match(r.problem, /at/);
});
