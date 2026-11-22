// Drift test: the plugin copy of the lane GOAL extractor must give the same result as the repo copy.
//   plugin copy  .claude/plugins/ccv3-mods/hooks/agentic-os/goal-extractor.ts  goalOfNote
//   repo copy    scripts/coordination/lane-dash-metrics.mjs                    goalOf
// The plugin copy exists because `claude plugin test` cannot import outside the plugin folder. This test is the tie between the two.
//
// Loader: the plugin file has no imports and only erasable TypeScript, so Node loads it with type stripping. The test runs it in a
// child `node --experimental-strip-types` (the flag is needed below Node 22.18 and harmless above it), so a plain
// `node --test scripts/mods/goal-extractor-drift.test.mjs` works. The test writes no file.
//
// Both copies get the same text. In the plugin, a note reaches the extractor after `oneLine` (first line, redacted, 400-unit cut with a
// trailing "…"), so the inputs below are written in that form. Lane ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { goalOf as repoGoalOf } from '../coordination/lane-dash-metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginFile = resolve(here, '../../.claude/plugins/ccv3-mods/hooks/agentic-os/goal-extractor.ts');

const long = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const line400 = `GOAL: Fix [REDACTED:api_key] handling ${'and more words '.repeat(40)}`.slice(0, 399) + '…';

const CASES = [
  ['stop " | "', 'GOAL: Ship the thing | NEXT: build it'],
  ['stop " || "', 'GOAL: Ship the thing || an older note'],
  ['stop WAITS ON', 'GOAL: Ship the thing WAITS ON lane-demo-b'],
  ['stop NEXT', 'GOAL: Ship the thing NEXT: build it'],
  ['stop MS:', 'GOAL: Ship the thing MS: m2 done'],
  ['first stop wins', 'GOAL: Ship the thing NEXT: x | y WAITS ON z'],
  ['PARKED lead', 'PARKED until 2026-12-01 -- waiting on review || GOAL: Ship the thing | NEXT: x'],
  ['PARKED with no old note', 'PARKED until 2026-12-01 -- waiting on review'],
  ['200 cap at a word', `GOAL: ${long(60)}`],
  ['200 cap, no space', `GOAL: ${'x'.repeat(250)}`],
  ['exactly 200', `GOAL: ${'y'.repeat(200)}`],
  ['redacted 400-unit line', line400],
  ['200 cap, marker straddles the cut', `GOAL: ${'x'.repeat(190)}[REDACTED:api_key]`],
  ['200 cap, two markers: first inside the cut, second straddles it', `GOAL: ${'a'.repeat(100)}[REDACTED:api_key]${'b'.repeat(72)}[REDACTED:token]`],
  ['200 cap at a word, marker early in the kept text', `GOAL: Fix [REDACTED:api_key] now ${long(60)}`],
  ['200 cap, marker ends exactly at the cut', `GOAL: ${'x'.repeat(181)}[REDACTED:api_key]${'y'.repeat(50)}`],
  ['200 cap, text that starts like a marker but holds a space', `GOAL: Strip [REDACTED: prefix from ${long(60)} [done]`],
  ['200 cap, index 199 inside a word', `GOAL: Go ${long(60)}`],
  ['ids masked', 'GOAL: Fix #0d40499c, 0d40499c-aaaa-bbbb-cccc-123456789abc and abc1234def'],
  ['empty note', ''],
  ['spaces only', '   '],
  ['no GOAL tag', 'Ship the thing | NEXT: x'],
  ['GOAL tag, empty sentence', 'GOAL: | NEXT: x'],
  ['null', null],
  ['undefined', undefined],
];

const RUN = `
import { goalOfNote } from ${JSON.stringify(pathToFileURL(pluginFile).href)};
let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;
// JSON has no undefined: the test sends it as {"u":1}.
const notes = JSON.parse(raw).map((one) => (one && one.u ? undefined : one));
process.stdout.write(JSON.stringify(notes.map((note) => goalOfNote(note) ?? null)));
`;

function pluginResults(notes) {
  const sent = notes.map((note) => (note === undefined ? { u: 1 } : note));
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', RUN], {
    input: JSON.stringify(sent),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `plugin extractor did not load (node ${process.version}): ${run.stderr}`);
  return JSON.parse(run.stdout);
}

test('the plugin goalOfNote gives the repo goalOf result on every shared input', () => {
  const notes = CASES.map(([, note]) => note);
  const plugin = pluginResults(notes);
  assert.equal(plugin.length, CASES.length);
  CASES.forEach(([name, note], i) => {
    assert.equal(plugin[i], repoGoalOf(note), `drift on "${name}"`);
  });
});

// Pinned values, so two copies that are both wrong cannot pass the equality test above: the cap drops a marker it would split.
test('the cap never returns part of a [REDACTED:kind] marker: both copies drop a straddling marker whole', () => {
  const notes = [
    `GOAL: ${'x'.repeat(190)}[REDACTED:api_key]`,
    `GOAL: ${'a'.repeat(100)}[REDACTED:api_key]${'b'.repeat(72)}[REDACTED:token]`,
    `GOAL: ${'x'.repeat(181)}[REDACTED:api_key]${'y'.repeat(50)}`,
    `GOAL: Go ${long(60)}`,
  ];
  const expected = [
    `${'x'.repeat(190)}…`,
    `${'a'.repeat(100)}[REDACTED:api_key]${'b'.repeat(72)}…`,
    `${'x'.repeat(181)}[REDACTED:api_key]…`,
    // Index 199 is inside a word: the word cut ends at word28 (195 characters), not at 199.
    `Go ${long(60).slice(0, 192)}…`,
  ];
  const plugin = pluginResults(notes);
  notes.forEach((note, i) => {
    assert.equal(repoGoalOf(note), expected[i], `repo copy, input ${i}`);
    assert.equal(plugin[i], expected[i], `plugin copy, input ${i}`);
  });
});

test('the shared inputs are not all null (a vacuous pass would hide a broken loader)', () => {
  const plugin = pluginResults(CASES.map(([, note]) => note));
  const found = plugin.filter((one) => one !== null);
  assert.ok(found.length >= 10, `only ${found.length} goals found`);
  assert.equal(plugin[CASES.findIndex(([name]) => name === 'stop NEXT')], 'Ship the thing');
  assert.equal(plugin[CASES.findIndex(([name]) => name === 'PARKED lead')], 'Ship the thing');
  assert.equal(plugin[CASES.findIndex(([name]) => name === 'empty note')], null);
});
