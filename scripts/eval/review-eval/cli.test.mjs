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
import { goldView, main } from './cli.mjs';

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
  const cfg = { judgeModels: { grok: 'opus' }, freeze: { promptSha256: 'P' } };
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
  const cfg = { judgeModels: { grok: 'opus' }, freeze: { promptSha256: 'OLD' }, engineFreeze: { promptSha256: { full: 'E1', delta: 'D1' } } };
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
  assert.equal(await main(['report', '--dir', dir], { ...io, cfg: { judgeModels: { grok: 'opus' }, freeze: { promptSha256: 'P' } } }), 0);
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
  const cfg = { judgeModels: { grok: 'opus' }, freeze: { promptSha256: 'OLD' }, engineFreeze: { promptSha256: { full: 'E1', delta: 'D1' } } };
  const io = quiet();
  assert.equal(await main(['score', '--dir', dir, '--linktype', path.join(dir, 'none.json')], { ...io, cfg }), 0);
  assert.equal(JSON.parse(io.out.join('\n')).excludedRuns, 1, 'only the engine row with a stale hash leaves; the row with no reviewer uses the fallback freeze');
});

// ---------- eval contract (re-eval-contract): budget report, judge family, versioned freeze, holdout spend, config keys ----------
// Failure modes:
//  K1 the dead key judgeModel ("sonnet") comes back in config.json      -> no test reads the live file
//  K2 the reserve or suites list ships with a PR number in it          -> a list filled by hand
//  K3 P1 is not closed at 75 in the live config                        -> evalScopes missing
//  J1 a reviewer family with no judgeModels entry falls back to a judge -> judgeModelFor returns a default
//  J2 a judge of the reviewer's own family is accepted                 -> no family compare
//  J3 score runs a run whose reviewer family has no judge              -> score does not call judgeModelFor
//  B1 the budget report drops a scope, an input source or a cut case   -> one line missing
//  B2 the budget report writes something                               -> it is not read only
//  H1 plain score or report writes the holdout-spend ledger            -> write not behind --holdout-spend
//  H2 a spend line carries a PR number                                 -> the run row is copied
//  H3 a run of a stale (not frozen) arm writes a spend line           -> no frozen check
//  F1 freeze --engine --prompt-version v2 writes engineFreeze          -> the old path runs
//  F2 score mixes two engine prompt versions in one card               -> one frozen hash for all engine rows
import { existsSync } from 'node:fs';
import { familyOfModel, judgeModelFor, loadConfig } from './config.mjs';

test('K1 K2 K3 the live config.json: no judgeModel key, well-formed reserve and suites, P1 closed at 75, a valid judge for grok', () => {
  // Breaks when: the dead key comes back, a list entry is malformed, or a scope cap changes.
  // The list contents are not pinned: re-holdout-rotate owns config.json next and moves PRs between them.
  const cfg = loadConfig();
  assert.equal(Object.hasOwn(cfg, 'judgeModel'), false);
  assert.ok(Array.isArray(cfg.reserve) && cfg.reserve.every((r) => Number.isInteger(r.pr) && Object.hasOwn(r, 'answerKeySource')));
  assert.deepEqual(Object.keys(cfg.suites).sort(), ['capability', 'regression']);
  assert.ok(Object.values(cfg.suites).every((l) => Array.isArray(l) && l.every(Number.isInteger)));
  assert.deepEqual(cfg.evalScopes, { P1: 75, P4: 120, P6: 120 });
  assert.equal(familyOfModel(judgeModelFor(cfg, 'grok')), 'claude');
  assert.equal(cfg.p4.controlsMin, 15);
});

test('J1 J2 judgeModelFor refuses a family with no entry and a judge of the same family; familyOfModel reads the model name', () => {
  // Breaks when: a missing family falls back to a default judge, or a Claude judge is accepted for a Claude reviewer.
  assert.equal(judgeModelFor({ judgeModels: { grok: 'opus' } }, 'grok'), 'opus');
  assert.throws(() => judgeModelFor({ judgeModels: { grok: 'opus' } }, 'claude'), (e) => e.code === 'NO_JUDGE');
  assert.throws(() => judgeModelFor({}, 'grok'), (e) => e.code === 'NO_JUDGE');
  assert.throws(() => judgeModelFor({ judgeModels: { claude: 'sonnet' } }, 'claude'), (e) => e.code === 'SAME_FAMILY');
  assert.throws(() => judgeModelFor({ judgeModels: { grok: 'grok4x' } }, 'grok'), (e) => e.code === 'UNKNOWN_FAMILY');
  assert.deepEqual(['opus', 'claude-opus-5-5', 'sonnet', 'grok-4.7-high', 'composer-2.5', 'x'].map(familyOfModel), ['claude', 'claude', 'claude', 'grok', 'composer', null]);
});

const scoreDir = (rows) => {
  const dir = tmp();
  const find = path.join(dir, 'findings.json');
  writeFileSync(find, JSON.stringify({ findings: [] }));
  const runs = rows.map((r, i) => ({ set: 'holdout', pr: 5 + i, round: 1, sha40: 'c'.repeat(40), status: 'ok', ts: '2026-11-13T00:00:00Z', findingsPath: find, ...r }));
  writeFileSync(path.join(dir, 'runs.jsonl'), `${runs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  writeFileSync(path.join(dir, 'dataset-resolved.json'), JSON.stringify({ findings: [], zeroMajorPrs: [] }));
  return dir;
};
const freezeCfg = { judgeModels: { grok: 'opus' }, freeze: { promptSha256: 'OLD' }, engineFreeze: { promptSha256: { full: 'E1' } }, engineFreezes: { v2: { promptSha256: { full: 'E2' } } } };

test('J3 score refuses (exit 2) a run whose reviewer family has no judge entry', async () => {
  // Breaks when: scoreCmd does not check the judge of each reviewer family.
  const dir = scoreDir([{ reviewer: 'engine', promptSha256: 'E1' }, { reviewer: 'claude-backend', promptSha256: 'C1' }]);
  const io = quiet();
  assert.equal(await main(['score', '--dir', dir], { ...io, cfg: freezeCfg }), 2);
  assert.match(io.out.join('\n'), /no judge model for reviewer family/);
});

test('F2 score refuses engine runs of two prompt versions in one card; one version scores against its own freeze', async () => {
  // Breaks when: all engine rows are judged against engineFreeze, or two versions mix in one scorecard.
  const mixed = scoreDir([{ reviewer: 'engine', promptVersion: 'v1', promptSha256: 'E1' }, { reviewer: 'engine', promptVersion: 'v2', promptSha256: 'E2' }]);
  assert.equal(await main(['score', '--dir', mixed], { ...quiet(), cfg: freezeCfg }), 2);
  const v2 = scoreDir([{ reviewer: 'engine', promptVersion: 'v2', promptSha256: 'E2' }]);
  const io = quiet();
  assert.equal(await main(['score', '--dir', v2], { ...io, cfg: freezeCfg }), 0);
  assert.equal(JSON.parse(io.out.join('\n')).excludedRuns, 0);
});

test('score refuses engine runs of a prompt version with no freeze (they never count as clean holdout)', async () => {
  // Breaks when: a null frozen hash makes hashStale false and unfrozen rows score as holdout.
  const dir = scoreDir([{ reviewer: 'engine', promptVersion: 'v2', promptSha256: 'X' }]);
  const io = quiet();
  assert.equal(await main(['score', '--dir', dir], { ...io, cfg: { ...freezeCfg, engineFreezes: {} } }), 2);
  assert.match(io.out.join('\n'), /no engine freeze for v2/);
});

test('single replay: a reserve PR is refused and runs nothing; the default set comes from config (dev here), not holdout', async () => {
  // Breaks when: replay --pr skips setOf, so a reserve PR is replayed and scored as holdout.
  const calls = [];
  const cfg = { holdoutExclude: [217], reserve: [{ pr: 300, answerKeySource: null }] };
  const io = { ...quiet(), cfg, replayRun: async (a) => { calls.push(a); return { exit: 0 }; } };
  assert.equal(await main(['replay', '--pr', '300', '--round', '1'], io), 2);
  assert.equal(calls.length, 0);
  assert.equal(await main(['replay', '--pr', '217', '--round', '1'], io), 0);
  assert.equal(await main(['replay', '--pr', '5', '--round', '1'], io), 0);
  assert.deepEqual(calls.map((c) => c.set), ['dev', 'holdout']);
});

test('holdout spend counts only ok runs that score keeps: not a failed build, a full-body leak or incomplete coverage', async () => {
  // Breaks when: rows that score excludes (or that made no model call) are counted as holdout spend.
  const dir = scoreDir([{ reviewer: 'engine', promptSha256: 'E1' }, { reviewer: 'engine', promptSha256: 'E1', status: 'tree_unbuildable' }, { reviewer: 'engine', promptSha256: 'E1', bodyMode: 'full' }, { reviewer: 'engine', promptSha256: 'E1', coverageComplete: false }]);
  const ledger = path.join(tmp(), 'h.jsonl');
  assert.equal(await main(['score', '--dir', dir, '--holdout-spend'], { ...quiet(), cfg: freezeCfg, spendLedger: ledger }), 0);
  assert.equal(JSON.parse(readFileSync(ledger, 'utf8').trim()).holdoutRuns, 1);
});

test('holdout spend counts a re-run of one round once, as score keeps only the newest row (CodeRabbit CLI minor on 60570913)', async () => {
  // Breaks when: holdoutSpendLines reads the raw runs instead of the rows evaluateRuns keeps.
  const dir = scoreDir([{ reviewer: 'engine', promptSha256: 'E1' }]);
  const rows = readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').trim();
  const again = JSON.stringify({ ...JSON.parse(rows), ts: '2026-11-13T01:00:00Z' });
  writeFileSync(path.join(dir, 'runs.jsonl'), `${rows}\n${again}\n`);
  const ledger = path.join(tmp(), 'h.jsonl');
  assert.equal(await main(['score', '--dir', dir, '--holdout-spend'], { ...quiet(), cfg: freezeCfg, spendLedger: ledger }), 0);
  assert.equal(JSON.parse(readFileSync(ledger, 'utf8').trim()).holdoutRuns, 1);
});

test('holdout spend keeps both arms of one round: one line per reviewer (CodeRabbit CLI major on 90fb577)', async () => {
  // Breaks when: the spend dedupe keys a round without the reviewer, so one A/B arm replaces the other.
  const dir = scoreDir([{ reviewer: 'engine', promptSha256: 'E1' }, { reviewer: 'cursor-review', promptSha256: 'OLD' }]);
  const rows = readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => ({ ...JSON.parse(l), pr: 5 }));
  writeFileSync(path.join(dir, 'runs.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const ledger = path.join(tmp(), 'h.jsonl');
  assert.equal(await main(['score', '--dir', dir, '--holdout-spend'], { ...quiet(), cfg: freezeCfg, spendLedger: ledger }), 0);
  const lines = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.reviewer, l.holdoutRuns]).sort(), [['cursor-review', 1], ['engine', 1]]);
});

test('holdout spend judges a row with no reviewer by the same freeze as score: in a folder with engine runs, that is the engine freeze (CodeRabbit CLI minor on 90fb577)', async () => {
  // Breaks when: the spend helper maps a missing reviewer to the cursor-review freeze while score uses the engine hash.
  const dir = scoreDir([{ reviewer: 'engine', promptSha256: 'E1' }, { promptSha256: 'OLD' }, { promptSha256: 'E1' }]);
  const ledger = path.join(tmp(), 'h.jsonl');
  const io = quiet();
  assert.equal(await main(['score', '--dir', dir, '--holdout-spend'], { ...io, cfg: freezeCfg, spendLedger: ledger }), 0);
  const excluded = JSON.parse(io.out.filter((s) => s.startsWith('{')).join('\n')).excludedRuns;
  const lines = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(excluded, 1, 'score excludes the no-reviewer row with OLD');
  // The engine row and the no-reviewer row with E1 count; the no-reviewer row with OLD (excluded by score) does not.
  assert.deepEqual(lines.map((l) => [l.reviewer, l.promptSha256, l.holdoutRuns]).sort(), [['engine', 'E1', 1], ['none', 'E1', 1]]);
});

test('an invalid --scope exits 2 before any write (no --out card, no spend line)', async () => {
  // Breaks when: the scope is checked after the --out scorecard is written.
  const dir = scoreDir([{ reviewer: 'engine', promptSha256: 'E1' }]);
  const out = path.join(tmp(), 'card.json');
  const ledger = path.join(tmp(), 'h.jsonl');
  assert.equal(await main(['score', '--dir', dir, '--out', out, '--holdout-spend', '--scope', 'P9'], { ...quiet(), cfg: freezeCfg, spendLedger: ledger }), 2);
  assert.deepEqual([existsSync(out), existsSync(ledger)], [false, false]);
});

test('H1 H2 H3 score --holdout-spend writes one line per frozen arm, no PR id; plain score and report write nothing', async () => {
  // Breaks when: the write is not behind the flag, a PR number is copied, or a stale arm is counted.
  const dir = scoreDir([{ reviewer: 'engine', promptSha256: 'E1' }, { reviewer: 'engine', promptSha256: 'E1', set: 'dev' }, { reviewer: 'engine', promptSha256: 'E1' }]);
  const ledger = path.join(tmp(), 'spend', 'holdout-spend.jsonl');
  assert.equal(await main(['score', '--dir', dir], { ...quiet(), cfg: freezeCfg, spendLedger: ledger }), 0);
  assert.equal(await main(['report', '--dir', dir, '--holdout-spend'], { ...quiet(), cfg: freezeCfg, spendLedger: ledger }), 0);
  assert.equal(existsSync(ledger), false);
  assert.equal(await main(['score', '--dir', dir, '--holdout-spend'], { ...quiet(), cfg: freezeCfg, spendLedger: ledger, now: () => Date.parse('2026-11-13T20:00:00Z') }), 0);
  const lines = readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { ts: '2026-11-13T20:00:00.000Z', reviewer: 'engine', promptVersion: 'v1', promptSha256: 'E1', holdoutRuns: 2, scope: 'P4' });
  const stale = scoreDir([{ reviewer: 'engine', promptSha256: 'STALE' }]);
  const ledger2 = path.join(tmp(), 'h2.jsonl');
  await main(['score', '--dir', stale, '--holdout-spend'], { ...quiet(), cfg: freezeCfg, spendLedger: ledger2 });
  assert.equal(existsSync(ledger2), false);
});

test('F1 freeze --engine --prompt-version v2 writes engineFreezes.v2 and leaves engineFreeze; an unknown version exits 2', async () => {
  // Breaks when: the flag is ignored (engineFreeze is overwritten with the v2 hash) or v9 is accepted.
  const file = path.join(tmp(), 'config.json');
  writeFileSync(file, JSON.stringify({ engineFreeze: { promptSha256: { full: 'KEEP' } } }));
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  assert.equal(await main(['freeze', '--engine', '--prompt-version', 'v2', '--config', file, '--root', root], quiet()), 0);
  const { buildEnginePrompt } = await import('../../github/local-review/prompt.mjs');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(cfg.engineFreezes.v2.promptSha256.full, buildEnginePrompt({ mode: 'full', promptVersion: 'v2' }).promptSha256);
  assert.equal(cfg.engineFreeze.promptSha256.full, 'KEEP');
  assert.equal(await main(['freeze', '--engine', '--prompt-version', 'v9', '--config', file, '--root', root], quiet()), 2);
});

const budgetFixture = () => {
  const dir = tmp();
  const ledger = path.join(dir, 'ledger.jsonl');
  const row = (i, sessionId) => JSON.stringify({ ts: '2026-11-03T12:00:00Z', phase: 'start', id: `${sessionId}-${i}`, ref: 'r', sessionId });
  writeFileSync(ledger, `${[...Array.from({ length: 75 }, (_, i) => row(i, 'review-eval')), ...Array.from({ length: 4 }, (_, i) => row(i, 'review-shadow'))].join('\n')}\n`);
  const ds = path.join(dir, 'ds.json');
  const major = (pr) => ({ pr, severity: 'Major', verdict: 'real', round: 1, path: 'a.mjs' });
  writeFileSync(ds, JSON.stringify({ prs: [], findings: [...[1, 2, 3, 4, 5, 6, 7, 8].map(major), ...[217, 222, 225, 238].map(major)] }));
  const goldDir = path.join(dir, 'gold');
  const live = loadConfig();
  const cfg = { cursorEvalBudget: 120, cursorHeadroom: 60, evalScopes: { P1: 75, P4: 120, P6: 120 }, p4: live.p4, holdoutExclude: [217, 222, 225, 238], reserve: [], suites: { regression: [1, 2, 217], capability: [3] } };
  return { ledger, ds, goldDir, cfg };
};

test('B1 B2 budget --json on a fixture ledger: P1 75 used and closed, P4 120 free, inputs with their sources, four cut cases, reserve count', async () => {
  // Breaks when: a scope, an input source, a cut case or the reserve count is missing, or the verb writes a file.
  const f = budgetFixture();
  const io = quiet();
  const before = readFileSync(f.ledger, 'utf8');
  const spend = path.join(tmp(), 'spend.jsonl');
  assert.equal(await main(['budget', '--ledger', f.ledger, '--dataset', f.ds, '--gold-dir', f.goldDir, '--json'], { ...io, cfg: f.cfg, spendLedger: spend, now: () => Date.parse('2026-11-13T20:00:00Z') }), 0);
  assert.equal(readFileSync(f.ledger, 'utf8'), before);
  assert.equal(existsSync(spend), false);
  const r = JSON.parse(io.out.join('\n'));
  assert.deepEqual(r.scopes.P1, { used: 75, cap: 75, free: 0 });
  assert.deepEqual(r.scopes.P4, { used: 0, cap: 120, free: 120 });
  assert.deepEqual(r.inputs.sources, { holdout: 'dataset + config.json holdoutExclude', dev: 'dataset + config.json holdoutExclude', gold: 'gold loader', controls: 'planned (config.json p4.controlsMin; clean-controls.json has 0)' });
  assert.deepEqual([r.inputs.holdout, r.inputs.dev, r.inputs.gold, r.inputs.controls], [8, 4, 0, 15]);
  assert.equal(r.cases.length, 4);
  assert.deepEqual(r.reserve, { total: 0, noSource: 0, bySource: {} });
  assert.equal(existsSync(f.goldDir), false);
});

test('B1 budget text report: each case states the gold targets that get a call, and a case that does not fit states the shortfall', async () => {
  // Breaks when: the text drops the gold line or prints a negative case as a fit.
  const f = budgetFixture();
  const io = quiet();
  assert.equal(await main(['budget', '--ledger', f.ledger, '--dataset', f.ds, '--gold-dir', f.goldDir], { ...io, cfg: f.cfg, now: () => Date.parse('2026-11-13T20:00:00Z') }), 0);
  const text = io.out.join('\n');
  assert.match(text, /P1 75 used of 75 \(closed\)/);
  assert.match(text, /P4 0 used of 120, 120 free/);
  assert.match(text, /holdout 1 run per arm, winner evidence 32 starts: .*gold targets with a call 0 of 0/);
  assert.match(text, /holdout 2 runs per arm, winner evidence 32 starts: DOES NOT FIT, short by 7 engine calls/);
  assert.match(text, /holdout 2 runs per arm, winner evidence 40 starts: DOES NOT FIT, short by 14 engine calls/);
  assert.match(text, /reserve PRs 0, with no answer-key source 0/);
  assert.match(text, /dataset PRs with no suite in config\.json: 8 of 12 \(regression 3, capability 1\)/);
});

test('budget without --dataset exits 2 and names the flag', async () => {
  // Breaks when: a missing dataset gives counts of 0 that read as real.
  const io = quiet();
  assert.equal(await main(['budget', '--ledger', path.join(tmp(), 'l.jsonl')], { ...io, cfg: loadConfig() }), 2);
  assert.match(io.out.join('\n'), /--dataset/);
});

// ---------- pass-through commands, gold report, goldView (card re-gold-assemble phase 1) ----------

const fakeMains = (calls, exits) => Object.fromEntries(Object.entries(exits).map(([name, exit]) => [name, async (a) => { calls.push([name, a]); return exit; }]));

test('mine, seed and dispositions pass argv.slice(1) to their own main and return its exit code (breaks if the command name is passed along, the args are dropped, or the exit is mapped to 0)', async () => {
  const calls = [];
  const io = { ...quiet(), cfg: {}, mains: fakeMains(calls, { mine: 0, seed: 2, dispositions: 3 }) };
  assert.equal(await main(['mine', '--from', '1', '--flag'], io), 0);
  assert.equal(await main(['seed', 'create', '--x', 'y'], io), 2);
  assert.equal(await main(['dispositions', 'sweep', '--json'], io), 3);
  assert.deepEqual(calls, [['mine', ['--from', '1', '--flag']], ['seed', ['create', '--x', 'y']], ['dispositions', ['sweep', '--json']]]);
});

const SHA = 'a'.repeat(40);
const goldRow = (i, over = {}) => ({ id: `fx-${i}`, source: 'A', suite: 'regression', split: 'dev', target: { pr: 900000 + i, round: 1, sha40: SHA }, file: 'src/a.mjs', severity: 'major', linkType: 'within-hunk', labels: [], provenance: { fx: true }, ...over });
const goldRun = (from, count, over = {}) => Array.from({ length: count }, (_, k) => goldRow(from + k, over));
const B_PROV = { test: 'node --test fx.test.mjs', failureSha256: 'b'.repeat(64) };
/** 20 A + 15 B + 15 C majors, one CR critical: majors 51, majors across A/B/C 50. Every done-when bar is met. */
function baseRows() {
  const c = goldRun(36, 15, { source: 'C', suite: 'capability', split: 'reserve' }).map((r) => ({ ...r, target: { ...r.target, repo: 'fx/repo' } }));
  return [...goldRun(1, 20), ...goldRun(21, 15, { source: 'B', suite: 'capability', split: 'holdout', provenance: { ...B_PROV } }), ...c, goldRow(51, { source: 'CR', severity: 'critical' })];
}
function goldDir(rows, controls = 30) {
  const dir = tmp();
  writeFileSync(path.join(dir, 'rows.json'), JSON.stringify(rows));
  const list = Array.from({ length: controls }, (_, i) => ({ id: `fx-c${i}`, split: 'dev', target: { pr: 800000 + i, round: 1, sha40: SHA }, provenance: { fx: true } }));
  writeFileSync(path.join(dir, 'clean-controls.json'), JSON.stringify(list));
  return dir;
}
async function report(rows, { controls = 30, extra = [], io = {} } = {}) {
  const sink = quiet();
  const code = await main(['gold', 'report', '--gold-dir', goldDir(rows, controls), ...extra], { ...sink, cfg: {}, ...io });
  return { code, text: sink.out.join('\n') };
}

test('gold report counts rows by source, suite, severity and split, majors by source, Gold B tests and controls (breaks if a count reads the wrong field or a zero key is dropped)', async () => {
  const { code, text } = await report(baseRows(), { extra: ['--json'] });
  const r = JSON.parse(text);
  assert.equal(code, 0);
  assert.deepEqual(r.bySource, { A: 20, B: 15, C: 15, CR: 1 });
  assert.deepEqual(r.bySuite, { regression: 21, capability: 30 });
  assert.deepEqual(r.bySeverity, { critical: 1, major: 50, minor: 0 });
  assert.deepEqual(r.bySplit, { dev: 21, holdout: 15, reserve: 15 });
  assert.deepEqual(r.majors, { total: 51, bySource: { A: 20, B: 15, C: 15, CR: 1 } });
  assert.deepEqual(r.goldB, { rows: 15, withBreakingTest: 15, missingBreakingTest: 0 });
  assert.equal(r.cleanControls, 30);
  const plain = (await report(baseRows())).text;
  assert.match(plain, /source A 20, B 15, C 15, CR 1/);
  assert.match(plain, /clean controls 30/);
});

test('gold report never prints a row id, a PR number or a sha, as text or JSON (breaks if the report lists rows or targets)', async () => {
  for (const extra of [[], ['--json']]) {
    const { code, text } = await report(baseRows(), { extra });
    assert.equal(code, 0);
    assert.match(text, extra.length ? /"rows": 51/ : /gold rows 51/);
    assert.doesNotMatch(text, /fx-/);
    assert.doesNotMatch(text, /9000\d\d|8000\d\d/);
    assert.equal(text.includes(SHA), false);
    assert.equal(text.includes('b'.repeat(64)), false);
  }
});

const BARS = { majors: 'majors across A/B/C >= 50', breaking: 'every Gold B row has a breaking test', regression: 'regression suite non-empty', capability: 'capability suite non-empty', controls: 'clean controls >= 30' };

test('gold report exits 0 and prints PASS on every done-when line when all bars are met (breaks if a bar is off by one or a PASS line is missing)', async () => {
  const { code, text } = await report(baseRows());
  assert.equal(code, 0);
  for (const name of Object.values(BARS)) assert.ok(text.split('\n').some((l) => l.startsWith(`PASS ${name}`)), name);
  assert.doesNotMatch(text, /FAIL/);
});

const edges = {
  majors: () => { const rows = baseRows(); rows[40] = { ...rows[40], severity: 'minor' }; return { rows }; },
  breaking: () => { const rows = baseRows(); rows[25] = { ...rows[25], provenance: { failureSha256: B_PROV.failureSha256 } }; return { rows }; },
  regression: () => ({ rows: baseRows().map((r) => ({ ...r, suite: 'capability' })) }),
  capability: () => ({ rows: baseRows().map((r) => ({ ...r, suite: 'regression' })) }),
  controls: () => ({ rows: baseRows(), controls: 29 }),
};

for (const [key, make] of Object.entries(edges)) {
  test(`gold report exits 3 when only "${BARS[key]}" is missed at its edge (breaks if the bar is off by one, reads the wrong field, or fails another line)`, async () => {
    const { rows, controls } = make();
    const { code, text } = await report(rows, { controls });
    assert.equal(code, 3);
    const fails = text.split('\n').filter((l) => l.startsWith('FAIL'));
    assert.equal(fails.length, 1);
    assert.ok(fails[0].includes(BARS[key]), fails[0]);
  });
}

test('gold report counts a Gold B row as tested only when provenance.test and provenance.failureSha256 are both present (breaks if one field is enough)', async () => {
  const rows = baseRows();
  rows[20] = { ...rows[20], provenance: { test: B_PROV.test } };
  rows[21] = { ...rows[21], provenance: { failureSha256: B_PROV.failureSha256 } };
  const r = JSON.parse((await report(rows, { extra: ['--json'] })).text);
  assert.deepEqual(r.goldB, { rows: 15, withBreakingTest: 13, missingBreakingTest: 2 });
});

test('gold D reports fixed over records with a disposition and never changes the exit (breaks if unlabeled records count, a verdict-only record is ignored, or the bars move)', async () => {
  const dispositions = [{ disposition: 'fixed' }, { disposition: 'fixed' }, { verdict: 'real' }, { disposition: 'wrong' }, { disposition: 'unlabeled' }];
  const text = await report(baseRows(), { io: { dispositions } });
  assert.equal(text.code, 0);
  assert.match(text.text, /gold D[^\n]*0\.75[^\n]*3\/4/);
  const json = JSON.parse((await report(baseRows(), { extra: ['--json'], io: { dispositions } })).text);
  assert.deepEqual(json.goldD, { value: 0.75, fixed: 3, withDisposition: 4 });
});

test('gold D with no records prints the no-records line and no number (breaks if it prints 0 or NaN)', async () => {
  for (const io of [{}, { dispositions: [] }]) {
    const { text } = await report(baseRows(), { io });
    assert.match(text, /gold D: no disposition records/);
    assert.doesNotMatch(text, /gold D[^\n]*\d/);
  }
  const json = JSON.parse((await report(baseRows(), { extra: ['--json'] })).text);
  assert.equal(json.goldD, null);
});

test('gold with no subcommand exits 2 and a bad gold folder exits 1 (breaks if a usage error or a load error maps to 0)', async () => {
  assert.equal(await main(['gold'], { ...quiet(), cfg: {} }), 2);
  const dir = tmp();
  writeFileSync(path.join(dir, 'rows.json'), '{ not json');
  assert.equal(await main(['gold', 'report', '--gold-dir', dir], { ...quiet(), cfg: {} }), 1);
});

test('goldView adds truth.note to a Gold B row with provenance.truthNote and changes nothing else (breaks if A or C rows get truth, a B row with no truthNote gets one, or the input is mutated)', () => {
  const b = goldRow(1, { source: 'B', provenance: { ...B_PROV, truthNote: 'the bound flips' } });
  const bNo = goldRow(2, { source: 'B', provenance: { ...B_PROV } });
  const bNum = goldRow(3, { source: 'B', provenance: { ...B_PROV, truthNote: 7 } });
  const a = goldRow(4, { provenance: { truthNote: 'not a B row' } });
  const c = goldRow(5, { source: 'C' });
  const rows = [b, bNo, bNum, a, c];
  const before = JSON.stringify(rows);
  const out = goldView(rows);
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(out[0].truth, { note: 'the bound flips' });
  assert.deepEqual({ ...out[0], truth: undefined }, { ...b, truth: undefined });
  assert.deepEqual(out.slice(1), [bNo, bNum, a, c]);
  assert.equal(Object.hasOwn(out[1], 'truth'), false);
  assert.equal(Object.hasOwn(b, 'truth'), false);
});

test('the unknown-command usage lists mine, seed, dispositions and gold (breaks if a new command is missing from the usage line)', async () => {
  const io = quiet();
  assert.equal(await main(['bogus'], { ...io, cfg: {} }), 1);
  for (const name of ['mine', 'seed', 'dispositions', 'gold']) assert.match(io.out.join('\n'), new RegExp(`\\b${name}\\b`));
});
