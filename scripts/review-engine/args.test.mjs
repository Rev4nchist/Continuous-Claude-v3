// Tests for lib/args.mjs (the grammar of design B.1) and the readMap guard for the test-only flags.
// Failure modes:
//   A1 a new flag is unknown, or a flag is accepted on the wrong verb
//   A2 --project accepts a value that is not a board key (it reaches SQL binds and child argv)
//   A3 --since accepts a non-number
//   A4 the removed --edges-out still parses
//   A5 --decisions or --lane-cli runs outside test mode (live mode must refuse, exit 3)
//   A6 the handler key changes for an old verb
// Run: node --test scripts/review-engine/args.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, USAGE } from './lib/args.mjs';
import { readMap } from './lib/source.mjs';

const usage = (argv, re) => assert.throws(() => parseArgs(argv), (e) => e.exitCode === 2 && re.test(e.message), argv.join(' '));

test('A1 seed-file takes --rank; check --claims takes --since and --project', () => {
  assert.deepEqual(parseArgs(['seed-file', '--rank', 'r.json', '--out', 'o.json', '--project', 'p']).flags, { rank: 'r.json', out: 'o.json', project: 'p' });
  const c = parseArgs(['check', '--claims', '--since', '120', '--project', 'continuous-claude']);
  assert.equal(c.key, 'check --claims');
  assert.deepEqual(c.flags, { claims: true, since: '120', project: 'continuous-claude' });
});

test('A1b ready, sync-board and status take --project; ready and sync-board take --as; sync-board takes --apply', () => {
  assert.deepEqual(parseArgs(['ready', '--project', 'p', '--as', 'abc']).flags, { project: 'p', as: 'abc' });
  assert.deepEqual(parseArgs(['sync-board', '--apply', '--project', 'p', '--as', 'abc']).flags, { apply: true, project: 'p', as: 'abc' });
  assert.deepEqual(parseArgs(['status', '--project', 'p']).flags, { project: 'p' });
  usage(['status', '--as', 'x'], /unknown flag '--as'/);
  usage(['ready', '--apply'], /unknown flag '--apply'/);
});

test('A1c check --board and --orphans take --project; --table and --diff do not', () => {
  assert.equal(parseArgs(['check', '--board', '--project', 'p']).key, 'check --board');
  assert.equal(parseArgs(['check', '--orphans', '--project', 'p']).key, 'check --orphans');
  usage(['check', '--table', '--project', 'p'], /--project goes with/);
  usage(['check', '--project', 'p'], /--project goes with/);
  usage(['check', '--diff', 're-x', '--project', 'p'], /--project goes with/);
});

test('A1d --since goes with --claims only', () => {
  usage(['check', '--board', '--since', '5'], /--since goes with --claims/);
  usage(['check', '--since', '5'], /--since goes with --claims/);
});

test('A2 --project must be a board key', () => {
  for (const bad of ['Bad_Key', '-x', 'a b', 'a;b', '../x', '', 'A']) {
    usage(['status', `--project=${bad}`], /--project must match/);
  }
  assert.equal(parseArgs(['status', '--project', 'zz-reprobe-1']).flags.project, 'zz-reprobe-1');
});

test('A3 --since must be a whole number', () => {
  for (const bad of ['abc', '-1', '1.5', '1e3', '']) usage(['check', '--claims', `--since=${bad}`], /--since must be a whole number/);
  assert.equal(parseArgs(['check', '--claims', '--since', '0']).flags.since, '0');
});

test('A4 --edges-out is gone: an unknown flag, exit 2', () => {
  usage(['seed-file', '--edges-out', 'e.json'], /unknown flag '--edges-out'/);
  assert.equal(USAGE.includes('edges-out'), false);
});

test('A5 --decisions and --lane-cli parse on any verb; the live-mode guard is in readMap', () => {
  assert.equal(parseArgs(['status', '--test-mode', '--decisions', 'd.md']).flags.decisions, 'd.md');
  assert.equal(parseArgs(['sync-board', '--test-mode', '--lane-cli', 'fake.mjs']).flags['lane-cli'], 'fake.mjs');
  for (const flag of ['decisions', 'lane-cli']) {
    assert.throws(() => readMap({ [flag]: 'x' }, '/nowhere'), (e) => e.exitCode === 3 && e.message.includes(`--${flag} needs --test-mode`), flag);
  }
  assert.throws(() => readMap({ decisions: 'x', 'lane-cli': 'y' }, '/nowhere'), (e) => e.exitCode === 3 && /--decisions, --lane-cli needs --test-mode/.test(e.message));
});

test('A6 the handler keys of the old verbs are unchanged', () => {
  assert.equal(parseArgs(['check']).key, 'check --table');
  assert.equal(parseArgs(['check', '--diff', 're-x', '--branch', 'b']).key, 'check --diff');
  assert.equal(parseArgs(['seed-file']).key, 'seed-file');
  assert.equal(parseArgs(['ready']).key, 'ready');
  assert.equal(parseArgs(['sync-board']).key, 'sync-board');
  assert.equal(parseArgs(['status']).key, 'status');
});

test('A7 USAGE names every new flag', () => {
  for (const word of ['--rank', '--since', '--as', '--apply', '--project', '--decisions', '--lane-cli']) assert.ok(USAGE.includes(word), word);
});
