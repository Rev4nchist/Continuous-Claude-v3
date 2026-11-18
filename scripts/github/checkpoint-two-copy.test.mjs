// The review question has two builders: the engine (lib/checkpoint-ledger.mjs askSpecOf, used with checkpoint.ledger on) and the mod
// (.claude/plugins/ccv3-mods/hooks/pr-checkpoint/model.ts buildPathwayAsk, the dialog path). Dave must see the same rows from both.
// Run: node --test scripts/github/checkpoint-two-copy.test.mjs
// The mod copy is TypeScript. Node 22.13 imports a .ts file only with --experimental-strip-types, so the test runs a child of itself with
// that flag (the flag is harmless on a Node that strips types by default). The child prints the labels of both copies as JSON.
//
// How it can fail, and the test that catches it:
//   one copy reads the slot fact by another rule (free older than 5 minutes, a wait whose slot passed)       -> TC1
//   one copy orders the rows another way, so row 0 or the place of a paid row differs                         -> TC1
//   one copy words a label another way (the price part, the Greptile credits)                                  -> TC1
//   the child cannot load a copy, or it runs fewer than the 8 cases (a vacuous pass)                           -> TC2
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SELF = fileURLToPath(import.meta.url);
const NOW = Date.parse('2026-11-17T22:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const CASES = [
  ['free, checked 1 min ago', { state: 'free', checkedAt: iso(NOW - 60_000) }],
  ['free, checked 10 min ago', { state: 'free', checkedAt: iso(NOW - 600_000) }],
  ['wait, next slot passed', { state: 'wait', checkedAt: iso(NOW - 600_000), nextSlotAt: iso(NOW - 60_000), minutesToSlot: 3 }],
  ['wait, next slot ahead', { state: 'wait', checkedAt: iso(NOW - 60_000), nextSlotAt: iso(NOW + 600_000), minutesToSlot: 10 }],
];

const option = (pathway, cost) => ({ pathway, label: null, available: true, cost, reason: `${pathway} reason` });
const resultOf = (capacity, recommended) => ({
  recommended, why: ['Band HIGH'], size: { files: 4, lines: 40 }, auto: { band: 'HIGH', eligible: false }, config_drift: false,
  options: [option('none', [0, 0]), option('coderabbit', [1, 0]), option('both', [1, 1])],
  capacity: { count: null, band: null, warning: null, source: null, date: null, ...capacity },
});

/** Child mode: load both real copies, build the question for every case, print the labels. */
async function childRows() {
  const { askSpecOf } = await import(pathToFileURL(path.join(ROOT, 'scripts/github/lib/checkpoint-ledger.mjs')).href);
  const { buildPathwayAsk } = await import(pathToFileURL(path.join(ROOT, '.claude/plugins/ccv3-mods/hooks/pr-checkpoint/model.ts')).href);
  const rows = [];
  for (const recommended of ['coderabbit', 'none']) {
    for (const [name, capacity] of CASES) {
      const result = resultOf(capacity, recommended);
      rows.push({
        name: `rec ${recommended}, ${name}`,
        engine: askSpecOf(7, result, 'slot line', NOW).options.map((o) => o.label),
        mod: buildPathwayAsk(7, result, NOW).choices.map((c) => c.label),
      });
    }
  }
  process.stdout.write(JSON.stringify(rows));
}

if (process.argv[2] === '--rows') {
  await childRows();
  process.exit(0);
}

const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SELF, '--rows'], { encoding: 'utf8', cwd: ROOT });
const rows = run.status === 0 ? JSON.parse(run.stdout) : [];

test('TC2: the child loaded both copies and ran all 8 cases', () => {
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(rows.length, 8);
});

test('TC1: the engine and the mod give the same row labels in the same order, for every recommendation and slot fact', () => {
  for (const row of rows) assert.deepEqual(row.engine, row.mod, row.name);
});

test('TC3: row 0 of both copies is a $0 row, in every case', () => {
  for (const row of rows) for (const copy of ['engine', 'mod']) assert.match(row[copy][0], /\(\$0\)( \(Recommended\))?$/, `${row.name}, ${copy}`);
});
