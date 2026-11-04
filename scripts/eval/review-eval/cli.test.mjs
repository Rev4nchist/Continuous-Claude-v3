// Failure modes (P0 spec section 2 cli.mjs: exit codes 0 ok, 1 failed, 2 refused, 3 cap).
//  an unknown subcommand exits 1, not 0         -> default branch returns 0
//  replay with a changed prompt exits 2         -> main swallows the refusal
//  replay with a used budget exits 3            -> main maps cap to 1
//  replay needs --pr and --round (or --all-majors) -> missing args start a run
//  labels export over the week cap exits 2      -> main maps the refusal to 0
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

test('score reads --linktype and report prints n, raw agreement, kappa, the NOTE status and per-class recall (breaks if the labels file is not passed to the scorecard or report drops a line)', async () => {
  // Breaks when: scoreCmd stops passing linkTypes, or the report table leaves out the agreement or per-class rows.
  const dir = tmp();
  const sha40 = 'a'.repeat(40);
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({ findings: [{ file: 'src/a.mjs', line: 10, severity: 'major', title: 'bug' }] }));
  writeFileSync(path.join(dir, 'runs.jsonl'), `${JSON.stringify({ set: 'holdout', pr: 5, round: 1, sha40, status: 'ok', ts: '2026-11-04T00:00:00Z', promptSha256: 'P', findingsPath: path.join(dir, 'findings.json') })}\n`);
  const dataset = { findings: [{ key: '5:1', pr: 5, sha40, path: 'src/a.mjs', startLine: 10, endLine: 10, severity: 'Major', verdict: 'real', source: 'inline' }], zeroMajorPrs: [] };
  writeFileSync(path.join(dir, 'dataset-resolved.json'), JSON.stringify(dataset));
  const lt = path.join(dir, 'lt.json');
  writeFileSync(lt, JSON.stringify({ labels: { '5:1': { final: 'same-file' } } }));
  const cfg = { freeze: { promptSha256: 'P' } };
  const io = quiet();
  assert.equal(await main(['report', '--dir', dir, '--linktype', lt], { ...io, cfg }), 0);
  const text = io.out.join('\n');
  assert.match(text, /Judge agreement \| n=0, raw n\/a, kappa n\/a, NOTE/);
  assert.match(text, /same-issue recall.*1\/1/i);
  assert.match(text, /same-file \| 100% \(1\/1\)/);
});

// ---------- phase 1 bridge: engine reviewer, run sets, engine freeze ----------

test('replay --only keeps one set, and --reviewer reaches replayRun; with no flag the reviewer is left to replayRun (breaks if --only is ignored or the reviewer is dropped)', async () => {
  const calls = [];
  const io = {
    ...quiet(),
    loadFindings: async () => [{ pr: 1, round: 1, set: 'holdout' }, { pr: 2, round: 1, set: 'dev' }, { pr: 3, round: 2, set: 'holdout' }],
    replayRun: async (a) => { calls.push(a); return { exit: 0, status: 'ok' }; },
  };
  assert.equal(await main(['replay', '--all-majors', '--only', 'holdout', '--reviewer', 'cursor-review'], io), 0);
  assert.deepEqual(calls.map((c) => [c.pr, c.set, c.reviewer]), [[1, 'holdout', 'cursor-review'], [3, 'holdout', 'cursor-review']]);
  calls.length = 0;
  await main(['replay', '--all-majors'], io);
  assert.equal(calls.length, 3);
  assert.equal(calls.every((c) => c.reviewer === undefined), true);
  assert.equal(await main(['replay', '--all-majors', '--only', 'nope'], io), 2);
});

test('freeze --engine records the engine prompt hashes in the config and leaves the old freeze (breaks if freeze --engine writes the cursor-review hash)', async () => {
  const file = path.join(tmp(), 'config.json');
  writeFileSync(file, JSON.stringify({ freeze: { promptSha256: 'old' } }));
  const io = quiet();
  assert.equal(await main(['freeze', '--engine', '--config', file, '--root', fileURLToPath(new URL('../../..', import.meta.url))], io), 0);
  const { buildEnginePrompt } = await import('../../github/local-review/prompt.mjs');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(cfg.engineFreeze.promptSha256.full, buildEnginePrompt({ mode: 'full' }).promptSha256);
  assert.equal(cfg.freeze.promptSha256, 'old');
});

test('score judges engine runs against the engine freeze, and report prints the funnel and the withdrawn misses (breaks if engine rows are checked against the old freeze or a line is missing)', async () => {
  const dir = tmp();
  const sha40 = 'b'.repeat(40);
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({ findings: [{ file: 'src/other.mjs', line: 3, severity: 'minor', title: 'x' }], withdrawn: [{ id: 'w1', path: 'src/a.mjs', line: 11, severity: 'major', reason: 'r' }] }));
  const funnel = { raw: 1, withdrawn: 1, dropped: { byReason: { 'no-file': 1 } }, posted: 1 };
  writeFileSync(path.join(dir, 'runs.jsonl'), `${JSON.stringify({ reviewer: 'engine', set: 'holdout', pr: 5, round: 1, sha40, status: 'ok', ts: '2026-11-04T00:00:00Z', promptSha256: 'E1', funnel, findingsPath: path.join(dir, 'findings.json') })}\n`);
  writeFileSync(path.join(dir, 'dataset-resolved.json'), JSON.stringify({ findings: [{ key: '5:1', pr: 5, sha40, path: 'src/a.mjs', startLine: 10, endLine: 10, severity: 'Major', verdict: 'real', source: 'inline' }], zeroMajorPrs: [] }));
  const lt = path.join(dir, 'lt.json');
  writeFileSync(lt, JSON.stringify({ labels: { '5:1': { final: 'within-hunk' } } }));
  const cfg = { freeze: { promptSha256: 'OLD' }, engineFreeze: { promptSha256: { full: 'E1', delta: 'D1' } } };
  const io = quiet();
  assert.equal(await main(['report', '--dir', dir, '--linktype', lt], { ...io, cfg }), 0);
  const text = io.out.join('\n');
  assert.match(text, /Strict Major recall \| 0% \(0\/1\)/);
  assert.match(text, /Funnel, 1 run\(s\) \| raw 1, withdrawn 1, dropped 1 \(no-file 1\), posted 1/);
  assert.match(text, /Holdout misses the reviewer withdrew \| 1 of 1 \(no data: 0\)/);
});

test('replay --body full reaches replayRun as bodyMode; with no flag bodyMode is left to replayRun (breaks if the flag is dropped)', async () => {
  const calls = [];
  const io = { ...quiet(), replayRun: async (a) => { calls.push(a); return { exit: 0, status: 'ok' }; } };
  await main(['replay', '--pr', '207', '--round', '1', '--body', 'full'], io);
  await main(['replay', '--pr', '207', '--round', '1'], io);
  assert.deepEqual(calls.map((c) => c.bodyMode), ['full', undefined]);
});

test('replay --all-majors goes on past a per-ref cap and stops on the eval budget or headroom; the end exit is 1 for a skipped ref-cap round, 3 for a budget stop (breaks if any exit 3 stops the batch)', async () => {
  const majors = [{ pr: 1, round: 1, set: 'holdout' }, { pr: 2, round: 1, set: 'holdout' }, { pr: 3, round: 1, set: 'holdout' }];
  const batch = async (answer) => {
    const calls = [];
    const io = { ...quiet(), loadFindings: async () => majors, replayRun: async (a) => { calls.push(a.pr); return answer(a.pr); } };
    const code = await main(['replay', '--all-majors'], io);
    return { calls, code };
  };
  const refCap = await batch((pr) => (pr === 1 ? { exit: 3, status: 'cap', reason: 'ref-cap reached (8)' } : { exit: 0, status: 'ok' }));
  assert.deepEqual([refCap.calls, refCap.code], [[1, 2, 3], 1]);
  for (const reason of ['eval-budget (eval 120, global 5)', 'headroom (eval 3, global 240)']) {
    const stopped = await batch((pr) => (pr === 2 ? { exit: 3, status: 'cap', reason } : { exit: 0, status: 'ok' }));
    assert.deepEqual([stopped.calls, stopped.code], [[1, 2], 3], reason);
  }
});

test('report prints the body-mode counts and the excluded runs (breaks if the report drops the line)', async () => {
  const dir = tmp();
  const sha40 = 'a'.repeat(40);
  const row = (pr, over) => JSON.stringify({ set: 'holdout', pr, round: 1, sha40, status: 'ok', ts: '2026-11-04T00:00:00Z', promptSha256: 'P', findingsPath: path.join(dir, 'findings.json'), ...over });
  writeFileSync(path.join(dir, 'findings.json'), JSON.stringify({ findings: [] }));
  writeFileSync(path.join(dir, 'runs.jsonl'), [row(5, { bodyMode: 'withheld' }), row(6, { bodyMode: 'full' }), row(7, {})].join('\n'));
  writeFileSync(path.join(dir, 'dataset-resolved.json'), JSON.stringify({ findings: [], zeroMajorPrs: [] }));
  const io = quiet();
  assert.equal(await main(['report', '--dir', dir], { ...io, cfg: { freeze: { promptSha256: 'P' } } }), 0);
  assert.match(io.out.join('\n'), /Runs, 3 \(1 excluded\) \| body mode: withheld 1, full 1, unknown 1/);
});


test('score checks each run against the freeze of its own reviewer: engine and cursor-review rows in one archive both count (breaks if one freeze judges every row)', async () => {
  const dir = tmp();
  const find = path.join(dir, 'findings.json');
  writeFileSync(find, JSON.stringify({ findings: [] }));
  const row = (pr, extra) => ({ set: 'holdout', pr, round: 1, sha40: String(pr).repeat(40).slice(0, 40), status: 'ok', ts: '2026-11-04T00:00:00Z', findingsPath: find, ...extra });
  const runs = [row(5, { reviewer: 'engine', promptSha256: 'E1' }), row(6, { reviewer: 'cursor-review', promptSha256: 'OLD' }), row(7, { promptSha256: 'E1' }), row(8, { reviewer: 'engine', promptSha256: 'STALE' })];
  writeFileSync(path.join(dir, 'runs.jsonl'), `${runs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  writeFileSync(path.join(dir, 'dataset-resolved.json'), JSON.stringify({ findings: [], zeroMajorPrs: [] }));
  const cfg = { freeze: { promptSha256: 'OLD' }, engineFreeze: { promptSha256: { full: 'E1', delta: 'D1' } } };
  const io = quiet();
  assert.equal(await main(['score', '--dir', dir, '--linktype', path.join(dir, 'none.json')], { ...io, cfg }), 0);
  assert.equal(JSON.parse(io.out.join('\n')).excludedRuns, 1, 'only the engine row with a stale hash leaves; the row with no reviewer uses the fallback freeze');
});
