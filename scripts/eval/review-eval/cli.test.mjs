// Failure modes (P0 spec section 2 cli.mjs: exit codes 0 ok, 1 failed, 2 refused, 3 cap).
//  an unknown subcommand exits 1, not 0         -> default branch returns 0
//  replay with a changed prompt exits 2         -> main swallows the refusal
//  replay with a used budget exits 3            -> main maps cap to 1
//  replay needs --pr and --round (or --all-majors) -> missing args start a run
//  labels export over the week cap exits 2      -> main maps the refusal to 0
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main } from './cli.mjs';

const tmp = () => mkdtempSync(path.join(process.env.REVIEW_EVAL_TMP || os.tmpdir(), 'cli-'));
const quiet = () => { const out = []; return { out, stdout: (s) => out.push(String(s)), stderr: (s) => out.push(String(s)) }; };

test('an unknown subcommand exits 1', async () => {
  // Breaks when: the default branch of main returns 0.
  assert.equal(await main(['bogus'], quiet()), 1);
  assert.equal(await main([], quiet()), 1);
});

test('replay without --pr/--round and without --all-majors exits 2 and runs nothing', async () => {
  // Breaks when: missing arguments fall through to a run.
  let ran = 0;
  const io = { ...quiet(), replayRun: async () => { ran += 1; return { exit: 0 }; } };
  assert.equal(await main(['replay'], io), 2);
  assert.equal(ran, 0);
});

test('replay passes the replayRun exit code through: frozen is 2, cap is 3, ok is 0', async () => {
  // Breaks when: main maps every non-zero exit to 1.
  const run = (exit) => main(['replay', '--pr', '207', '--round', '1'], { ...quiet(), replayRun: async () => ({ exit }) });
  assert.deepEqual([await run(0), await run(2), await run(3)], [0, 2, 3]);
});

test('replay --all-majors --build-only runs one build per distinct (pr, round) and reports the count', async () => {
  // Breaks when: --all-majors replays each finding (duplicates) or starts agents.
  const calls = [];
  const io = {
    ...quiet(),
    loadFindings: async () => [{ pr: 1, round: 1 }, { pr: 1, round: 1 }, { pr: 2, round: 2 }],
    replayRun: async (a) => { calls.push(a); return { exit: 0, status: 'built' }; },
  };
  assert.equal(await main(['replay', '--all-majors', '--build-only'], io), 0);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((c) => c.buildOnly === true), true);
});

test('labels export over the week cap exits 2', async () => {
  // Breaks when: main ignores the refusal from exportPairs.
  const dir = tmp();
  const file = path.join(dir, 'pairs.json');
  const pairs = Array.from({ length: 21 }, (_, i) => ({ kind: 'same_issue', pr: 1, sha: 's', file: 'f', line: i, engine: { title: `t${i}` }, cr: {}, judge: {} }));
  writeFileSync(file, JSON.stringify(pairs));
  assert.equal(await main(['labels', 'export', '--pairs', file, '--dir', dir], quiet()), 2);
});
