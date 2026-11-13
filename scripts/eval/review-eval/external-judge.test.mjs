// Failure modes for step A (external judge pre-check). No network, no real headless call: fetch, runner and clock are injected.
//  F1 a file over 5 MB (or of unknown size) is pulled          -> drop the HEAD size check
//  F2 an unpinned dataset (branch name, no sha) is pulled/judged -> drop assertPinned
//  F3 more than 10 external judge calls in one Chicago day     -> drop the daily-share check, or count only today's UTC day
//  F4 a judged pair is judged again                            -> resume ignores the ledger
//  F5 the sample changes between runs for one seed             -> unseeded shuffle or row-order dependence
//  F6 wrong Wilson interval                                    -> normal approximation, or z dropped
//  F7 --dry-run spends a headless call or writes a ledger      -> dry-run branch skipped
//  F8 judge calls use the P0 eval session                      -> sessionId review-eval would burn the 40-run eval budget
//  F9 an Uncertain human label counts as "no"                  -> map anything not Yes to no
//  F10 parquet is read as if it were JSON                      -> no extension check
//  G1-G10 the prompt gives the label away (one action per row, same shape), kappa, hard split, bySource, console line, stale end rows
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { JUDGE_MODEL, loadRows, parseArgs, pickAction, rowToPair, run, sampleIds, summarize, toFinding, wilson } from './external-judge.mjs';
import { judgePrompt } from './judge.mjs';
import { JUDGE_PROMPT_V1_FILLED_SHA256, JUDGE_PROMPT_V1_SHA256, judgePromptV1 } from './judge-prompt-v1.mjs';
import { pullPinned, PullRefusal } from './external-pull.mjs';

const SHA = 'a'.repeat(40);
const ID = 'owner/name';
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ext-judge-'));
const silent = { stdout: () => {}, stderr: () => {} };
// 2026-11-02 18:00 UTC is 12:00 on 2 November in Chicago.
const NOW = Date.parse('2026-11-02T18:00:00Z');

const row = (i, decision = 'Yes') => ({
  task_id: `t${String(i).padStart(3, '0')}`,
  human_match_decision: decision,
  bot_suggestion: JSON.stringify({ title: `s${i}`, body: `suggestion ${i}` }),
  developer_actions: JSON.stringify([{ id: 'a1', body: 'fixed it' }, { id: 'a2', body: 'other' }]),
  human_matched_action_id: decision === 'Yes' ? 'a1' : null,
  judge_matched_action_id: 'a2',
});
const rows = (n) => Array.from({ length: n }, (_, i) => row(i, i % 2 ? 'No' : 'Yes'));
// served: the model name the fake claude -p envelope reports in modelUsage (null: no modelUsage at all).
const verdictRun = (sameIssue = 'yes', served = 'claude-opus-5-5') => {
  const calls = [];
  const envelope = () => ({ type: 'result', result: JSON.stringify({ sameIssue, real: 'unclear', confidence: 5, reason: 'r' }), ...(served ? { modelUsage: { [served]: { inputTokens: 1 } } } : {}) });
  const fn = async (req, deps) => { calls.push({ req, deps }); return { ok: true, stdout: JSON.stringify(envelope()) }; };
  return { fn, calls };
};
const ledgerLines = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const startRow = (i, ts = new Date(NOW - 1000).toISOString()) => ({ ts, phase: 'start', dataset: `${ID}@${SHA}`, pairId: `x${i}` });
const base = (extra = {}) => ({ id: ID, sha: SHA, file: 'f.jsonl', sample: 20, seed: 7, dailyShare: 10, ...extra });

function fakeFetch({ headLength, bodyBytes = 10 }) {
  const log = [];
  const fn = async (url, init = {}) => {
    log.push(init.method ?? 'GET');
    const headers = new Map(headLength === undefined ? [] : [['content-length', String(headLength)]]);
    if (init.method === 'HEAD') return { ok: true, status: 200, headers: { get: (k) => headers.get(k) ?? null } };
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array(bodyBytes).buffer };
  };
  return { fn, log };
}

test('F1 refuses a file over 5 MB before any download, and a file of unknown size', async () => {
  // Breaks when: the Content-Length check is dropped or uses `>=` against a wrong limit.
  const big = fakeFetch({ headLength: 5 * 1024 * 1024 + 1 });
  const root = tmp();
  await assert.rejects(pullPinned({ id: ID, sha: SHA, file: 'f.jsonl' }, { fetchFn: big.fn, root }), PullRefusal);
  assert.deepEqual(big.log, ['HEAD'], 'no GET after a refusing HEAD');
  assert.equal(existsSync(path.join(root, `owner__name@${SHA}`)), false);
  await assert.rejects(pullPinned({ id: ID, sha: SHA, file: 'f.jsonl' }, { fetchFn: fakeFetch({ headLength: undefined }).fn, root }), /size unknown/);
  const ok = await pullPinned({ id: ID, sha: SHA, file: 'f.jsonl' }, { fetchFn: fakeFetch({ headLength: 5 * 1024 * 1024, bodyBytes: 10 }).fn, root, now: () => NOW });
  assert.equal(ok.manifest.bytes, 10);
  assert.equal(ok.manifest.sha, SHA);
  assert.match(ok.manifest.sha256, /^[0-9a-f]{64}$/);
});

test('F1 refuses a body larger than the limit when HEAD understated it', async () => {
  // Breaks when: only the HEAD size is trusted.
  const liar = fakeFetch({ headLength: 10, bodyBytes: 6 * 1024 * 1024 });
  await assert.rejects(pullPinned({ id: ID, sha: SHA, file: 'f.jsonl' }, { fetchFn: liar.fn, root: tmp() }), /over the .* byte limit/);
});

test('F2 refuses an unpinned dataset in the pull and in the judge', async () => {
  // Breaks when: assertPinned is dropped, so a moving branch name is scored.
  for (const sha of ['main', undefined, 'abc123', 'A'.repeat(40)]) {
    await assert.rejects(pullPinned({ id: ID, sha, file: 'f.jsonl' }, { fetchFn: fakeFetch({ headLength: 5 }).fn, root: tmp() }), PullRefusal);
    const v = verdictRun();
    const r = await run(base({ sha }), { rows: rows(4), runClaudeFn: v.fn, ledgerPath: path.join(tmp(), 'l.jsonl'), outDir: tmp(), now: () => NOW, ...silent });
    assert.equal(r.code, 2);
    assert.equal(v.calls.length, 0);
  }
});

test('F3 refuses at 10 external judge calls in a Chicago day, allows the 10th, ignores yesterday', async () => {
  // Breaks when: the share check is dropped, uses `>`, or counts a UTC day instead of a Chicago day.
  const ledgerPath = path.join(tmp(), 'l.jsonl');
  const nine = Array.from({ length: 9 }, (_, i) => JSON.stringify(startRow(i))).join('\n');
  writeFileSync(ledgerPath, `${nine}\n`);
  const v = verdictRun();
  const r = await run(base({ sample: 20 }), { rows: rows(30), runClaudeFn: v.fn, ledgerPath, outDir: tmp(), now: () => NOW, ...silent });
  assert.equal(v.calls.length, 1, 'only the 10th call is allowed');
  assert.equal(r.code, 0);

  const full = verdictRun();
  const r2 = await run(base({ sample: 20 }), { rows: rows(30), runClaudeFn: full.fn, ledgerPath, outDir: tmp(), now: () => NOW, ...silent });
  assert.equal(r2.code, 2);
  assert.equal(r2.reason, 'daily-share');
  assert.equal(full.calls.length, 0);

  // 2026-11-03 02:00 UTC is still 2 November, 20:00, in Chicago: the same day, still refused. 06:30 UTC is 3 November 00:30 there.
  const sameDay = verdictRun();
  const r3 = await run(base({ sample: 20 }), { rows: rows(30), runClaudeFn: sameDay.fn, ledgerPath, outDir: tmp(), now: () => Date.parse('2026-11-03T02:00:00Z'), ...silent });
  assert.equal(r3.code, 2);
  const nextDay = verdictRun();
  await run(base({ sample: 20 }), { rows: rows(30), runClaudeFn: nextDay.fn, ledgerPath, outDir: tmp(), now: () => Date.parse('2026-11-03T06:30:00Z'), ...silent });
  assert.equal(nextDay.calls.length, 10, 'a new Chicago day gets a fresh share of 10');
});

test('F4 resume skips pairs already judged and keeps their results in the output', async () => {
  // Breaks when: the ledger is not read, or the output is built only from this run.
  const ledgerPath = path.join(tmp(), 'l.jsonl');
  const outDir = tmp();
  const data = rows(6);
  const first = verdictRun('yes');
  await run(base({ sample: 3, dailyShare: 10 }), { rows: data, runClaudeFn: first.fn, ledgerPath, outDir, now: () => NOW, ...silent });
  assert.equal(first.calls.length, 3);
  const second = verdictRun('yes');
  const r = await run(base({ sample: 6, dailyShare: 10 }), { rows: data, runClaudeFn: second.fn, ledgerPath, outDir, now: () => NOW + 60_000, ...silent });
  assert.equal(second.calls.length, 3, 'only the 3 new pairs are judged');
  assert.equal(r.out.summary.n, 6, 'earlier results stay in the summary');
  const third = verdictRun('yes');
  await run(base({ sample: 6 }), { rows: data, runClaudeFn: third.fn, ledgerPath, outDir, now: () => NOW + 120_000, ...silent });
  assert.equal(third.calls.length, 0);
});

test('F5 the same seed gives the same sample, another seed another one, a bigger n extends it', () => {
  // Breaks when: the shuffle is unseeded (Math.random) or follows row order.
  const ids = Array.from({ length: 125 }, (_, i) => `t${i}`);
  const a = sampleIds(ids, 50, 1);
  assert.deepEqual(sampleIds(ids, 50, 1), a);
  assert.deepEqual(sampleIds([...ids].reverse(), 50, 1), a, 'row order does not matter');
  assert.notDeepEqual(sampleIds(ids, 50, 2), a);
  assert.notDeepEqual(a, ids.slice(0, 50), 'not just the first 50');
  assert.equal(new Set(a).size, 50);
  assert.deepEqual(sampleIds(ids, 60, 1).slice(0, 50), a);
});

test('F6 Wilson interval matches known values', () => {
  // Breaks when: the normal approximation replaces Wilson (8/10 would give 0.552 to 1.048), or z is wrong.
  const w = wilson(8, 10);
  assert.ok(Math.abs(w.lo - 0.4902) < 0.001, `lo ${w.lo}`);
  assert.ok(Math.abs(w.hi - 0.9433) < 0.001, `hi ${w.hi}`);
  const all = wilson(10, 10);
  assert.equal(all.hi, 1);
  assert.ok(Math.abs(all.lo - 0.7225) < 0.001, `lo ${all.lo}`);
  assert.equal(wilson(0, 0), null);
});

test('F7 dry-run makes 0 headless calls and writes no ledger and no output', async () => {
  // Breaks when: the dry-run branch is dropped, or it reserves a start row.
  const dir = tmp();
  const ledgerPath = path.join(dir, 'l.jsonl');
  const outDir = path.join(dir, 'out');
  const v = verdictRun();
  const lines = [];
  const r = await run(base({ dryRun: true, sample: 5 }), { rows: rows(10), runClaudeFn: v.fn, ledgerPath, outDir, now: () => NOW, stdout: (s) => lines.push(s), stderr: () => {} });
  assert.equal(r.code, 0);
  assert.equal(v.calls.length, 0);
  assert.equal(existsSync(ledgerPath), false);
  assert.equal(existsSync(outDir), false);
  assert.match(lines[0], /^plan: .*sample 5 seed 7.*headless calls made: 0/);
  assert.ok(lines.some((l) => l.includes('UNTRUSTED DATA')), 'prints the prompts it would send');
});

test('F8 judge calls use session review-external and purpose external-judge, and report real as not measured', async () => {
  // Breaks when: the session id is review-eval (burns the P0 eval budget) or the hunk is not empty.
  const v = verdictRun('yes');
  const r = await run(base({ sample: 2 }), { rows: rows(4), runClaudeFn: v.fn, ledgerPath: path.join(tmp(), 'l.jsonl'), outDir: tmp(), now: () => NOW, ...silent });
  assert.equal(v.calls.length, 2);
  for (const c of v.calls) {
    assert.equal(c.deps.sessionId, 'review-external');
    assert.equal(c.req.purpose, 'external-judge');
    assert.equal(c.req.model, 'opus');
    assert.equal(c.req.effort, 'high');
    assert.match(c.req.prompt, /### Hunk\n\n?<<<END UNTRUSTED DATA>>>/);
  }
  assert.deepEqual(r.out.summary.notMeasured, ['real']);
  const rec = r.out.pairs[0];
  assert.deepEqual(Object.keys(rec).slice(0, 4), ['pairId', 'human', 'judge', 'agree']);
  assert.equal(rec.agree, rec.human === rec.judge);
  assert.equal(r.out.summary.n, 2);
});

test('F9 an Uncertain label is excluded from the sample, not counted as no', () => {
  // Breaks when: any non-Yes decision maps to "no".
  assert.equal(rowToPair(row(1, 'Uncertain')).human, null);
  assert.equal(rowToPair(row(1, 'Yes')).human, 'yes');
  assert.equal(rowToPair(row(1, 'No')).human, 'no');
  assert.equal(rowToPair(row(1, 'Yes')).candidateSource, 'human');
  assert.equal(rowToPair(row(1, 'No')).candidateSource, 'judge');
});

test('F9 an unmatched no row shows one picked action and records it', async () => {
  // Breaks when: the candidate source is not recorded, or the fallback is dropped.
  const r = rowToPair({ ...row(1, 'No'), judge_matched_action_id: null });
  assert.equal(r.candidateSource, 'picked');
  assert.match(r.pair.eng.body, /^(fixed it|other)$/);
  const v = verdictRun();
  const out = await run(base({ sample: 10 }), { rows: [row(1, 'Uncertain'), row(2, 'Yes'), row(3, 'No')], runClaudeFn: v.fn, ledgerPath: path.join(tmp(), 'l.jsonl'), outDir: tmp(), now: () => NOW, ...silent });
  assert.equal(v.calls.length, 2);
  assert.equal(out.out.uncertainExcluded, 1);
});

test('F10 parquet is refused with a clear message, a JSONL file loads, a tampered file is refused', () => {
  // Breaks when: the extension check is dropped, or the manifest hash is not compared.
  const root = tmp();
  const dir = path.join(root, `owner__name@${SHA}`);
  const mk = (file, body) => { writeFileSync(path.join(dir, file), body); };
  mkdirSync(dir, { recursive: true });
  mk('t.parquet', 'PAR1');
  assert.throws(() => loadRows({ id: ID, sha: SHA, file: 't.parquet' }, { root }), /no parquet reader/);
  mk('f.jsonl', `${JSON.stringify(row(1))}\n${JSON.stringify(row(2))}\n`);
  assert.equal(loadRows({ id: ID, sha: SHA, file: 'f.jsonl' }, { root }).length, 2);
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ file: 'f.jsonl', sha256: '0'.repeat(64) }));
  assert.throws(() => loadRows({ id: ID, sha: SHA, file: 'f.jsonl' }, { root }), /does not match the sha256/);
  assert.throws(() => loadRows({ id: ID, sha: SHA, file: 'missing.jsonl' }, { root }), /is missing/);
});

// ---- G: the prompt must not give the label away; the report carries kappa and the source split ---------------------------

// Real action rows have no body, title or severity field: the description becomes the body and the title stays empty.
const ACTIONS = [1, 2, 3, 4, 5].map((k) => ({ id: `a${k}`, description: `desc ${k}`, category: 'c', action_type: 't', file_path: 'f' }));
const noRow = (id, extra = {}) => ({ task_id: id, human_match_decision: 'no', bot_suggestion: 'bot says x', developer_actions: JSON.stringify(ACTIONS), human_matched_action_id: null, judge_matched_action_id: null, ...extra });
const yesRow = (id, extra = {}) => ({ ...noRow(id), human_match_decision: 'yes', human_matched_action_id: 'a2', ...extra });
let recCount = 0;
const rec = (human, judge, candidateSource = 'human') => { recCount += 1; return { pairId: `p${recCount}`, human, judge, agree: human === judge, candidateSource }; };
const times = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const captured = () => { const lines = []; return { lines, io: { stdout: (s) => lines.push(s), stderr: () => {} } }; };
const maskEng = (p) => judgePrompt(p).replace(p.eng.body, 'ENG_BODY');

test('G1 a no row with no judge match shows exactly one action, never the whole list', () => {
  // Breaks when: the "all developer actions" fallback comes back.
  const r = rowToPair(noRow('t1'));
  assert.equal(r.candidateSource, 'picked');
  const hits = [1, 2, 3, 4, 5].filter((k) => r.pair.eng.body.includes(`desc ${k}`));
  assert.equal(hits.length, 1);
  assert.doesNotMatch(judgePrompt(r.pair), /all developer actions/);
  assert.doesNotMatch(r.pair.eng.title, /all developer actions/);
});

test('G2 the pick is stable across calls and row order, changes with task_id, and ignores the label and the bot text', () => {
  // Breaks when: the pick uses Math.random, the row index that rows.map passes, or ignores task_id (always the first action).
  const ids = times(40, (i) => `task-${i}`);
  const data = ids.map((id) => noRow(id));
  const byId = (pairs) => Object.fromEntries(pairs.map((p) => [p.pairId, p.pair.eng.body]));
  const first = byId(data.map(rowToPair));
  assert.deepEqual(byId(data.map(rowToPair)), first, 'second call');
  assert.deepEqual(byId([...data].reverse().map(rowToPair)), first, 'reversed row order, called through map as run() does');
  assert.ok(new Set(Object.values(first)).size >= 3, `picks vary with task_id: ${[...new Set(Object.values(first))]}`);
  for (const id of ids.slice(0, 10)) {
    // No word of the bot text is in any action, so every action ties and task_id alone decides.
    const expected = toFinding(pickAction(id, ACTIONS, 'bot says x'));
    assert.deepEqual(rowToPair(noRow(id)).pair.eng, expected);
    const other = noRow(id, { human_explanation: 'desc 4 is the one', human_confidence: 'high', judge_confidence: 0.9, judge_matched: true, human_matched_action_id: 'a4' });
    assert.deepEqual(rowToPair(other).pair.eng, expected, 'no label-side field moves the pick');
  }
});

test('G11 the pick is the action with the most words in common with the finding; task_id decides only between equal ones', () => {
  // Breaks when: the pick ignores the finding text (an easy negative), counts a repeated word twice, or lets task_id choose a weaker action.
  const acts = [
    { id: 'b1', description: 'renamed the logger import' },
    { id: 'b2', description: 'added a null check before the cache lookup in the handler' },
    { id: 'b3', description: 'added a null check before the cache lookup in the worker' },
    { id: 'b4', description: 'cache cache cache cache' },
  ];
  const ids = times(40, (i) => `task-${i}`);
  for (const id of ids) assert.equal(pickAction(id, acts, 'Missing null check: the handler reads the cache lookup result').id, 'b2', 'the handler action has the highest overlap');
  const tied = ids.map((id) => pickAction(id, acts, 'missing null check before the cache lookup').id);
  assert.deepEqual([...new Set(tied)].sort(), ['b2', 'b3'], 'equal overlap: task_id picks among the equal ones only');
  assert.deepEqual(ids.map((id) => pickAction(id, acts, 'missing null check before the cache lookup').id), tied, 'stable');
  assert.equal(pickAction('x', [], 'text'), null);
  const r = rowToPair(noRow('t1', { bot_suggestion: { body: 'Missing null check: the handler reads the cache lookup result' }, developer_actions: JSON.stringify(acts) }));
  assert.equal(r.candidateSource, 'picked');
  assert.equal(r.pair.eng.body, acts[1].description, 'rowToPair passes the finding text to the pick');
});

test('G3 a yes row, a judge-matched no row and a picked no row give the same prompt apart from the eng text', () => {
  // Breaks when: the label changes the eng title or severity, adds a heading or an extra action, or shows the source in the prompt.
  const y = rowToPair(yesRow('t1'));
  const j = rowToPair(noRow('t1', { judge_matched_action_id: 'a4' }));
  const n = rowToPair(noRow('t2'));
  assert.deepEqual([y.candidateSource, j.candidateSource, n.candidateSource], ['human', 'judge', 'picked']);
  assert.equal(y.pair.eng.title, '');
  assert.equal(y.pair.eng.body, 'desc 2', 'the description becomes the body');
  assert.deepEqual(y.pair.eng, toFinding(ACTIONS[1]));
  assert.equal(maskEng(y.pair), maskEng(n.pair));
  assert.equal(maskEng(y.pair), maskEng(j.pair));
  assert.equal(y.pair.hunk, n.pair.hunk);
});

test('G3b a no row takes the judge action when it exists, and a picked action is built by toFinding', () => {
  // Breaks when: the judge match is ignored, or a picked action is built by another function than a matched one.
  const j = rowToPair(noRow('t1', { judge_matched_action_id: 'a4' }));
  assert.equal(j.candidateSource, 'judge');
  assert.deepEqual(j.pair.eng, toFinding(ACTIONS[3]));
  const p = rowToPair(noRow('t9'));
  assert.deepEqual(p.pair.eng, toFinding(pickAction('t9', ACTIONS, 'bot says x')));
});

test('G4 yes with a missing action id and no with an empty or unreadable list give none, are left out and counted by label', async () => {
  // Breaks when: they fall back to the judge match, the list position or the whole list, or are sampled, or uncertain rows are counted with them.
  const yesMissing = yesRow('t1', { human_matched_action_id: 'zzz', judge_matched_action_id: 'a1' });
  const yesIndex = yesRow('t7', { human_matched_action_id: '3' }); // an id that is only a list position
  const noEmpty = noRow('t2', { developer_actions: '[]' });
  const noBad = noRow('t3', { developer_actions: 'not json' });
  const noNull = noRow('t8', { developer_actions: null });
  for (const r of [yesMissing, yesIndex, noEmpty, noBad, noNull]) assert.equal(rowToPair(r).candidateSource, 'none');
  assert.equal(rowToPair(noRow('t6', { judge_matched_action_id: '3' })).candidateSource, 'picked', 'a judge id that is only a list position is no match');
  const uncertain = noRow('t9', { human_match_decision: 'uncertain' });
  const v = verdictRun();
  const c = captured();
  const out = await run(base({ sample: 10 }), { rows: [yesMissing, yesIndex, noEmpty, noBad, noNull, uncertain, yesRow('t4'), noRow('t5'), noRow('t6', { judge_matched_action_id: '3' })], runClaudeFn: v.fn, ledgerPath: path.join(tmp(), 'l.jsonl'), outDir: tmp(), now: () => NOW, ...c.io });
  assert.equal(v.calls.length, 3);
  assert.deepEqual([...out.out.sampleIds].sort(), ['t4', 't5', 't6']);
  assert.match(c.lines[0], /no candidate 5 \(yes 2, no 3\)/);
  assert.match(c.lines[0], /uncertain excluded 1/);
  assert.equal(out.out.noCandidate, 5);
  assert.deepEqual(out.out.noCandidateByLabel, { yes: 2, no: 3 });
});

test('G5 a known 2x2 table gives the known kappa', () => {
  // Breaks when: kappa is computed from raw agreement, or from [human, human]. Table: yy 20, yn 5, ny 10, nn 15 -> po 0.7, pe 0.5, kappa 0.4.
  const records = [...times(20, () => rec('yes', 'yes')), ...times(5, () => rec('yes', 'no')), ...times(10, () => rec('no', 'yes')), ...times(15, () => rec('no', 'no'))];
  const s = summarize(records);
  assert.ok(Math.abs(s.kappa - 0.4) < 1e-9, `kappa ${s.kappa}`);
  assert.equal(s.n, 50);
  assert.equal(s.agree, 35);
  assert.equal(s.agreement, 0.7);
  assert.deepEqual(s.notMeasured, ['real']);
  assert.equal(s.ci95.length, 2);
});

test('G6 both raters with one class give kappa null, never NaN; the console says kappa: undefined and has no easy-case note without picked rows', async () => {
  // Breaks when: the null from cohenKappa becomes NaN or "null" in the report, or the picked note prints with no picked record.
  assert.equal(summarize([rec('yes', 'yes'), rec('yes', 'yes')]).kappa, null);
  assert.equal(summarize([]).kappa, null);
  const v = verdictRun('yes');
  const c = captured();
  const out = await run(base({ sample: 3 }), { rows: [yesRow('t1'), yesRow('t2'), yesRow('t3')], runClaudeFn: v.fn, ledgerPath: path.join(tmp(), 'l.jsonl'), outDir: tmp(), now: () => NOW, ...c.io });
  assert.equal(out.out.summary.kappa, null);
  assert.ok(c.lines.some((l) => l.includes('kappa: undefined')), c.lines.join('\n'));
  assert.ok(!c.lines.some((l) => /NaN/.test(l)));
  assert.ok(!c.lines.some((l) => /built cases/.test(l)), 'no picked record, no note');
});

test('G7 the final console line holds n, agreement, kappa with 3 decimals, the hard split and "real: not measured"; a split line names the easy picked negatives', async () => {
  // Breaks when: the report line drops kappa, the hard numbers, the real-not-measured words, or the source split.
  const v = verdictRun('yes');
  const c = captured();
  const data = [yesRow('t1'), yesRow('t2'), noRow('t3'), noRow('t4', { judge_matched_action_id: 'a1' })];
  await run(base({ sample: 4 }), { rows: data, runClaudeFn: v.fn, ledgerPath: path.join(tmp(), 'l.jsonl'), outDir: tmp(), now: () => NOW, ...c.io });
  const last = c.lines[c.lines.length - 1];
  assert.match(last, /n 4/);
  assert.match(last, /agreement 2\/4/);
  assert.match(last, /kappa: 0\.000;/);
  assert.match(last, /hard \(not picked\): n 3; agreement 2\/3 \(0\.667\); kappa: 0\.000/);
  assert.match(last, /real: not measured/);
  const split = c.lines.find((l) => /by source/.test(l));
  assert.ok(split, 'a split line');
  assert.match(split, /human n=2/);
  assert.match(split, /judge n=1/);
  assert.match(split, /picked n=1/);
  assert.match(split, /picked negatives are built cases, not human-paired cases/);
  assert.match(split, /kappa by source: not defined \(each source holds one human label\)/);
});

test('G8 bySource counts n, agree and agreement for each candidateSource', () => {
  // Breaks when: records are grouped by human label, or a source is dropped or double counted.
  const s = summarize([rec('yes', 'yes', 'human'), rec('yes', 'no', 'human'), rec('no', 'no', 'picked'), rec('no', 'no', 'picked'), rec('no', 'yes', 'judge')]);
  assert.deepEqual(s.bySource, {
    human: { n: 2, agree: 1, agreement: 0.5 },
    picked: { n: 2, agree: 2, agreement: 1 },
    judge: { n: 1, agree: 0, agreement: 0 },
  });
  assert.deepEqual(summarize([]).bySource, {});
});

test('G9 hard leaves out the picked records and has its own n, agree, agreement and kappa', () => {
  // Breaks when: hard includes picked records (the easy negatives inflate it) or is dropped. hard here: yy 1, yn 1, ny 1, nn 1 -> kappa 0.
  const s = summarize([rec('yes', 'yes', 'human'), rec('yes', 'no', 'human'), rec('no', 'yes', 'judge'), rec('no', 'no', 'judge'), rec('no', 'no', 'picked'), rec('no', 'no', 'picked')]);
  assert.equal(s.n, 6);
  assert.deepEqual(s.hard, { n: 4, agree: 2, agreement: 0.5, kappa: 0 });
  assert.deepEqual(summarize([rec('no', 'no', 'picked')]).hard, { n: 0, agree: 0, agreement: null, kappa: null });
});

test('G10 an old end row is reused only when its source is the one the pair has now; the others are judged again and counted', async () => {
  // Breaks when: a verdict given on the old whole-list prompt (source all) or on an unknown source still counts in n, agreement and kappa.
  const ledgerPath = path.join(tmp(), 'l.jsonl');
  const ds = `${ID}@${SHA}`;
  const end = (pairId, human, judge, candidateSource) => JSON.stringify({ ts: new Date(NOW - 5000).toISOString(), phase: 'end', dataset: ds, pairId, human, judge, ...(candidateSource ? { candidateSource } : {}) });
  writeFileSync(ledgerPath, `${[end('t1', 'yes', 'yes', 'human'), end('t2', 'no', 'yes', 'all'), end('t3', 'no', 'yes')].join('\n')}\n`);
  const v = verdictRun('no', 'claude-sonnet-5-5');
  const c = captured();
  // Old rows have no model field: they are Sonnet rows, so this resume test runs as Sonnet.
  const r = await run(base({ sample: 10, model: 'sonnet' }), { rows: [yesRow('t1'), noRow('t2'), noRow('t3')], runClaudeFn: v.fn, ledgerPath, outDir: tmp(), now: () => NOW, ...c.io });
  assert.equal(v.calls.length, 2, 'the all row and the row with no source are judged again; the human row is not');
  assert.match(c.lines[0], /already judged 1, pending 2/);
  assert.match(c.lines[0], /stale 2/);
  assert.equal(r.out.staleRejudged, 2);
  assert.equal(r.out.summary.n, 3);
  assert.deepEqual(Object.keys(r.out.summary.bySource).sort(), ['human', 'picked']);
  assert.equal(r.out.pairs.find((p) => p.pairId === 't2').judge, 'no', 'the new verdict replaces the old one');
  assert.equal(r.out.pairs.find((p) => p.pairId === 't1').judge, 'yes', 'the human row keeps its old verdict');
});

// ---- H: the judge model (hf-judge-opus) ----------------------------------------------------------------------------

const endRow = (pairId, human, judge, extra = {}) => JSON.stringify({ ts: new Date(NOW - 5000).toISOString(), phase: 'end', dataset: `${ID}@${SHA}`, pairId, human, judge, candidateSource: 'human', ...extra });

test('H1 the default judge is the one model constant, opus at effort high; start and end rows carry the model and the served model', async () => {
  // Breaks when: the call goes back to sonnet, effort is dropped, or a ledger row has no model field.
  assert.equal(JUDGE_MODEL, 'opus');
  const ledgerPath = path.join(tmp(), 'l.jsonl');
  const v = verdictRun('yes');
  const r = await run(base({ sample: 1 }), { rows: [yesRow('t1')], runClaudeFn: v.fn, ledgerPath, outDir: tmp(), now: () => NOW, headSha: 'b'.repeat(40), ...silent });
  assert.equal(r.code, 0);
  assert.equal(v.calls[0].req.model, JUDGE_MODEL);
  assert.equal(v.calls[0].req.effort, 'high');
  const [start, end] = ledgerLines(ledgerPath);
  assert.equal(start.model, 'opus');
  assert.equal(end.model, 'opus');
  assert.equal(end.servedModel, 'claude-opus-5-5');
});

test('H2 parseArgs takes --model opus|sonnet, --cap N and --stop-on-error, and refuses any other model', () => {
  // Breaks when: haiku or an unknown model reaches the judge, or --cap takes a non-integer.
  assert.equal(parseArgs([]).model, undefined);
  assert.equal(parseArgs(['--model', 'sonnet']).model, 'sonnet');
  assert.equal(parseArgs(['--model', 'opus', '--cap', '65', '--stop-on-error']).cap, 65);
  assert.equal(parseArgs(['--stop-on-error']).stopOnError, true);
  assert.throws(() => parseArgs(['--model', 'haiku']), /--model/);
  assert.throws(() => parseArgs(['--cap', 'x']), /integer/);
  assert.throws(() => parseArgs(['--cap', '0']), /1 or more/);
  assert.throws(() => parseArgs(['--cap', '-5']), /1 or more/);
  assert.equal(parseArgs(['--out-dir', 'o']).outDir, 'o');
});

test('H3 an opus run sees sonnet-judged pairs as pending; old rows with no model field read as sonnet for this ledger', async () => {
  // Breaks when: an Opus score mixes in Sonnet verdicts, or legacy rows are dropped from a Sonnet run.
  const ledgerPath = path.join(tmp(), 'l.jsonl');
  writeFileSync(ledgerPath, `${[endRow('t1', 'yes', 'no'), endRow('t2', 'yes', 'no', { model: 'sonnet' })].join('\n')}\n`);
  const opus = verdictRun('yes');
  const c = captured();
  const r = await run(base({ sample: 2 }), { rows: [yesRow('t1'), yesRow('t2')], runClaudeFn: opus.fn, ledgerPath, outDir: tmp(), now: () => NOW, ...c.io });
  assert.equal(opus.calls.length, 2, 'both pairs are judged again on opus');
  assert.equal(r.out.summary.n, 2);
  assert.equal(r.out.summary.agree, 2, 'only the opus verdicts (yes) count, not the sonnet ones (no)');
  const sonnet = verdictRun('yes', 'claude-sonnet-5-5');
  const r2 = await run(base({ sample: 2, model: 'sonnet' }), { rows: [yesRow('t1'), yesRow('t2')], runClaudeFn: sonnet.fn, ledgerPath, outDir: tmp(), now: () => NOW, ...silent });
  assert.equal(sonnet.calls.length, 0, 'a sonnet run reuses the legacy row and the sonnet row');
  assert.equal(r2.out.summary.agree, 0);
});

test('H4 --cap reaches runClaude as deps.cap for this run only; without it no cap is passed', async () => {
  // Breaks when: the raise is dropped, or a run without the flag passes a cap that overrides the shared constant.
  const a = verdictRun('yes');
  await run(base({ sample: 1, cap: 65 }), { rows: [yesRow('t1')], runClaudeFn: a.fn, ledgerPath: path.join(tmp(), 'l.jsonl'), outDir: tmp(), now: () => NOW, ...silent });
  assert.equal(a.calls[0].deps.cap, 65);
  const b = verdictRun('yes');
  await run(base({ sample: 1 }), { rows: [yesRow('t1')], runClaudeFn: b.fn, ledgerPath: path.join(tmp(), 'l.jsonl'), outDir: tmp(), now: () => NOW, ...silent });
  assert.equal('cap' in b.calls[0].deps, false);
});

test('H5 an opus call served by another model, or with no served model, is an error row and stops the run', async () => {
  // Breaks when: an older Opus or a missing modelUsage counts as an Opus verdict (seat condition a).
  for (const served of ['claude-opus-4-1', 'claude-sonnet-5-5', null]) {
    const ledgerPath = path.join(tmp(), 'l.jsonl');
    const v = verdictRun('yes', served);
    const c = captured();
    const r = await run(base({ sample: 3 }), { rows: [yesRow('t1'), yesRow('t2'), yesRow('t3')], runClaudeFn: v.fn, ledgerPath, outDir: tmp(), now: () => NOW, ...c.io });
    assert.equal(v.calls.length, 1, `served ${served}: the run stops after the first call`);
    assert.equal(r.code, 2);
    const end = ledgerLines(ledgerPath).find((x) => x.phase === 'end');
    assert.equal(end.error, 'served-model');
    assert.equal(end.servedModel, served);
    assert.equal(r.out.summary.n, 0, 'the wrong-model verdict is not counted');
    assert.match(c.lines.at(-1), /stopped: served-model/);
  }
});

test('H6 --stop-on-error stops after the first error row; without it the run goes on', async () => {
  // Breaks when: a timeout or parse fault in a batch is followed by more paid calls although the flag is set.
  let n = 0;
  const flaky = async () => { n += 1; return n === 1 ? { ok: false, reason: 'timeout' } : JSON.parse(JSON.stringify({ ok: true, stdout: JSON.stringify({ type: 'result', result: '{"sameIssue":"yes","real":"unclear","confidence":5,"reason":"r"}', modelUsage: { 'claude-opus-5-5': {} } }) })); };
  const rws = [yesRow('t1'), yesRow('t2'), yesRow('t3')];
  const r = await run(base({ sample: 3, stopOnError: true }), { rows: rws, runClaudeFn: flaky, ledgerPath: path.join(tmp(), 'l.jsonl'), outDir: tmp(), now: () => NOW, ...silent });
  assert.equal(n, 1);
  assert.equal(r.code, 2);
  n = 0;
  const r2 = await run(base({ sample: 3 }), { rows: rws, runClaudeFn: flaky, ledgerPath: path.join(tmp(), 'l.jsonl'), outDir: tmp(), now: () => NOW, ...silent });
  assert.equal(n, 3);
  assert.equal(r2.code, 0);
});

test('H7 the report file name, the output and the console line carry the model and the head SHA; the other model is printed beside it', async () => {
  // Breaks when: an Opus report overwrites the Sonnet report, or the report does not say which code made the verdicts (seat condition c).
  const ledgerPath = path.join(tmp(), 'l.jsonl');
  writeFileSync(ledgerPath, `${[endRow('t1', 'yes', 'no'), endRow('t2', 'no', 'no', { candidateSource: 'picked' })].join('\n')}\n`);
  const v = verdictRun('yes');
  const c = captured();
  const outDir = tmp();
  const r = await run(base({ sample: 2 }), { rows: [yesRow('t1'), noRow('t2')], runClaudeFn: v.fn, ledgerPath, outDir, now: () => NOW, headSha: 'c'.repeat(40), ...c.io });
  assert.match(path.basename(r.outPath), /hf-judge-precheck-opus\.json$/);
  assert.equal(r.out.model, 'opus');
  assert.equal(r.out.headSha, 'c'.repeat(40));
  assert.equal(r.out.compare.model, 'sonnet');
  assert.equal(r.out.compare.summary.n, 2);
  assert.deepEqual(r.out.compare.paired, { n: 2, bothAgree: 0, onlyThis: 1, onlyOther: 1, bothWrong: 0 });
  assert.match(c.lines.at(-1), /^external-judge \[opus @ cccccccc\]/);
  assert.ok(c.lines.some((l) => /^compare sonnet: n 2; agreement 1\/2/.test(l)));
});

test('H9 a wrong served model stops the run even when the answer does not parse', async () => {
  // Breaks when: a parse fault from another model is a plain error row and the run goes on (CLI finding on cde4777c).
  const ledgerPath = path.join(tmp(), 'l.jsonl');
  const calls = [];
  const fn = async (req) => { calls.push(req); return { ok: true, stdout: JSON.stringify({ type: 'result', result: 'not json', modelUsage: { 'claude-sonnet-5-5': {} } }) }; };
  const r = await run(base({ sample: 3 }), { rows: [yesRow('t1'), yesRow('t2'), yesRow('t3')], runClaudeFn: fn, ledgerPath, outDir: tmp(), now: () => NOW, ...silent });
  assert.equal(calls.length, 1);
  assert.equal(r.code, 2);
  assert.equal(ledgerLines(ledgerPath).find((x) => x.phase === 'end').error, 'served-model');
});

test('H10 each end row names the head that made it; the report counts verdicts by head', async () => {
  // Breaks when: resumed verdicts are credited to the head of the latest run (CLI finding on cde4777c, seat condition c).
  const ledgerPath = path.join(tmp(), 'l.jsonl');
  writeFileSync(ledgerPath, `${endRow('t1', 'yes', 'yes', { model: 'opus', servedModel: 'claude-opus-5-5', headSha: 'd'.repeat(40) })}\n`);
  const v = verdictRun('yes');
  const r = await run(base({ sample: 2 }), { rows: [yesRow('t1'), yesRow('t2')], runClaudeFn: v.fn, ledgerPath, outDir: tmp(), now: () => NOW, headSha: 'e'.repeat(40), ...silent });
  assert.equal(v.calls.length, 1);
  assert.equal(ledgerLines(ledgerPath).at(-1).headSha, 'e'.repeat(40));
  assert.deepEqual(r.out.verdictHeads, { ['d'.repeat(40)]: 1, ['e'.repeat(40)]: 1 });
});

test('H8 summarize adds tpr and tnr with Wilson intervals, and the confidence 4+ table', () => {
  // Breaks when: the strict-judge signal (misses on human yes) is hidden behind kappa alone.
  const recs = [{ ...rec('yes', 'yes'), confidence: 5 }, { ...rec('yes', 'no'), confidence: 3 }, { ...rec('no', 'no'), confidence: 4 }, { ...rec('no', 'no'), confidence: 2 }];
  const s = summarize(recs);
  assert.deepEqual([s.tpr.k, s.tpr.n], [1, 2]);
  assert.deepEqual([s.tnr.k, s.tnr.n], [2, 2]);
  assert.ok(s.tpr.ci95[0] < 0.5 && s.tpr.ci95[1] > 0.5);
  assert.deepEqual(s.highConfidence, { n: 2, agree: 2, humanYes: 1 });
});

// ---- I: judge prompt version (--prompt v0|v1) and the outside set (--set) -------------------------------------------------
// Every value below is made up. Every run() call injects rows, runClaudeFn, ledgerPath and outDir, so no test can reach a real claude -p.

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const EMPTY_PAIR = { cr: null, eng: null, hunk: '' };
const DS = `${ID}@${SHA}`;
const OPUS_V1_OUTSIDE = { model: 'opus', promptVersion: 'v1', set: 'outside' };
// 80 decisive rows t000..t079. With seed 7 the first 6 ids of the seeded sample were taken from the code before this change.
const GOLDEN_SAMPLE_6 = ['t024', 't054', 't020', 't026', 't002', 't005'];

async function exec(opts, data, { v = verdictRun('yes'), ledgerPath = path.join(tmp(), 'l.jsonl'), now = NOW } = {}) {
  const c = captured();
  const r = await run(base(opts), { rows: data, runClaudeFn: v.fn, ledgerPath, outDir: tmp(), now: () => now, ...c.io });
  return { r, v, c, ledgerPath };
}
// A finished end row for a pair of `data`, on the candidate that pair has now (a stale source would be judged again).
const doneRow = (data, pairId, extra = {}) => endRow(pairId, 'yes', 'yes', { candidateSource: data.map(rowToPair).find((p) => p.pairId === pairId).candidateSource, ...extra });
const writeLedger = (lines) => { const f = path.join(tmp(), 'l.jsonl'); writeFileSync(f, `${lines.join('\n')}\n`); return f; };

test('I1 --prompt takes v0 or v1 and --set takes sample or outside; any other value is a usage error, in parseArgs and in run', async () => {
  // Breaks when: an unknown prompt or set is accepted, so a paid run goes out with a prompt nobody froze.
  assert.equal(parseArgs(['--prompt', 'v1']).prompt, 'v1');
  assert.equal(parseArgs(['--set', 'outside']).set, 'outside');
  assert.equal(parseArgs([]).prompt, undefined);
  assert.throws(() => parseArgs(['--prompt', 'v2']), /--prompt must be one of v0, v1/);
  assert.throws(() => parseArgs(['--prompt', 'constructor']), /--prompt/, 'an object property name is not a prompt');
  assert.throws(() => parseArgs(['--set', 'all']), /--set must be one of sample, outside/);
  for (const bad of [{ prompt: 'v2' }, { set: 'all' }]) {
    const x = await exec({ sample: 2, ...bad }, rows(4));
    assert.equal(x.r.code, 1);
    assert.equal(x.v.calls.length, 0);
    assert.equal(existsSync(x.ledgerPath), false);
  }
});

test('I2 a v1 run sends the v1 text; the default run and --prompt v0 send the judge.mjs text byte for byte', async () => {
  // Breaks when: v1 is routed to judgePrompt, the default is routed to v1, or the v0 path stops calling the judge.mjs prompt.
  const pair = rowToPair(yesRow('t1')).pair;
  const v1 = await exec({ sample: 1, prompt: 'v1' }, [yesRow('t1')]);
  assert.equal(v1.v.calls[0].req.prompt, judgePromptV1(pair));
  assert.doesNotMatch(v1.v.calls[0].req.prompt, /Engine finding/);
  for (const opts of [{ sample: 1 }, { sample: 1, prompt: 'v0' }]) {
    const v0 = await exec(opts, [yesRow('t1')]);
    assert.equal(v0.v.calls[0].req.prompt, judgePrompt(pair));
    assert.match(v0.v.calls[0].req.prompt, /Engine finding/);
  }
});

test('I3 the default run picks the ids it picked before and sends judgePrompt for each, and the v0 sample report keeps its name', async () => {
  // Breaks when: the default run draws another sample, reorders it, sends another text, or renames the v0 sample report.
  const data = rows(80);
  const pairs = new Map(data.map(rowToPair).map((p) => [p.pairId, p.pair]));
  const x = await exec({ sample: 6 }, data);
  assert.deepEqual(x.r.out.sampleIds, GOLDEN_SAMPLE_6);
  assert.deepEqual(x.v.calls.map((c) => c.req.prompt), GOLDEN_SAMPLE_6.map((i) => judgePrompt(pairs.get(i))));
  assert.match(path.basename(x.r.outPath), /^\d{4}-\d{2}-\d{2}-hf-judge-precheck-opus\.json$/);
});

test('I4 start and end rows carry promptVersion, set and the prompt sha; a legacy row reads as v0 and sample', async () => {
  // Breaks when: a row drops promptVersion, set or promptSha256, or a row with no promptVersion stops counting as v0.
  const v1 = await exec({ sample: 1, prompt: 'v1' }, [yesRow('t1')]);
  for (const l of ledgerLines(v1.ledgerPath)) {
    assert.equal(l.promptVersion, 'v1');
    assert.equal(l.set, 'sample');
    assert.equal(l.promptSha256, JUDGE_PROMPT_V1_SHA256);
  }
  const v0 = await exec({ sample: 1 }, [yesRow('t1')]);
  const [start, end] = ledgerLines(v0.ledgerPath);
  assert.deepEqual([start.promptVersion, end.promptVersion, end.set], ['v0', 'v0', 'sample']);
  assert.equal(end.promptSha256, sha256(judgePrompt(EMPTY_PAIR)));
  const legacy = writeLedger([endRow('t1', 'yes', 'yes', { model: 'opus' })]);
  assert.equal((await exec({ sample: 1 }, [yesRow('t1')], { ledgerPath: legacy })).v.calls.length, 0, 'v0 reads the legacy row');
  assert.equal((await exec({ sample: 1, prompt: 'v1' }, [yesRow('t1')], { ledgerPath: legacy })).v.calls.length, 1, 'v1 does not');
});

test('I5 one score per model and prompt: a v1 run sees v0 rows as pending and a v0 run sees v1 rows as pending', async () => {
  // Breaks when: judgedMap or the summary ignores promptVersion, so a v1 score mixes in v0 verdicts or the reverse.
  const data = [yesRow('t1'), yesRow('t2')];
  const v0Rows = writeLedger([endRow('t1', 'yes', 'no', { model: 'opus' }), endRow('t2', 'yes', 'no', { model: 'opus', promptVersion: 'v0' })]);
  const a = await exec({ sample: 2, prompt: 'v1' }, data, { ledgerPath: v0Rows });
  assert.equal(a.v.calls.length, 2);
  assert.deepEqual([a.r.out.summary.n, a.r.out.summary.agree], [2, 2], 'only the v1 verdicts (yes) count, not the v0 ones (no)');
  const v1Rows = writeLedger([endRow('t1', 'yes', 'no', { model: 'opus', promptVersion: 'v1', set: 'sample' }), endRow('t2', 'yes', 'no', { model: 'opus', promptVersion: 'v1', set: 'sample' })]);
  const b = await exec({ sample: 2 }, data, { ledgerPath: v1Rows });
  assert.equal(b.v.calls.length, 2);
  assert.deepEqual([b.r.out.summary.n, b.r.out.summary.agree], [2, 2]);
});

test('I6 the report compares the other prompt on the same model and set when both exist, and null when it does not; the model compare stays', async () => {
  // Breaks when: the cross-prompt block pairs another model or set, is missing when both prompts exist, or replaces out.compare.
  const data = [yesRow('t1'), yesRow('t2')];
  const ledgerPath = writeLedger([endRow('t1', 'yes', 'yes', { model: 'opus' }), endRow('t2', 'yes', 'no', { model: 'opus' })]);
  const x = await exec({ sample: 2, prompt: 'v1' }, data, { ledgerPath });
  assert.equal(x.r.out.comparePrompt.promptVersion, 'v0');
  assert.equal(x.r.out.comparePrompt.summary.n, 2);
  assert.deepEqual(x.r.out.comparePrompt.paired, { n: 2, bothAgree: 1, onlyThis: 1, onlyOther: 0, bothWrong: 0 });
  assert.equal(x.r.out.compare.model, 'sonnet');
  assert.ok(x.c.lines.some((l) => /^compare prompt v0: n 2; agreement 1\/2/.test(l)));
  assert.match(x.c.lines.at(-1), /^external-judge \[opus @/, 'the final line stays last');
  assert.equal((await exec({ sample: 2, prompt: 'v1' }, data)).r.out.comparePrompt, null);
});

test('I7 --set outside is every decisive pair outside the default sample, in the seeded order, stable, and never non-decisive rows', async () => {
  // Breaks when: a sample id leaks into outside, a decisive pair is lost, the order depends on call or --sample, or a no-action or uncertain row gets in.
  const decisive = rows(80);
  const extra = [row(900, 'Uncertain'), yesRow('nopair', { human_matched_action_id: 'zzz' }), noRow('noact', { developer_actions: '[]' })];
  const dry = (o) => exec({ dryRun: true, showPrompts: 0, set: 'outside', ...o }, [...extra, ...decisive]);
  const first = (await dry({ sample: 20 })).r.ids;
  const all = decisive.map((r) => r.task_id);
  const sample = new Set(sampleIds(all, 50, 7));
  assert.equal(first.length, 30);
  assert.ok(first.every((i) => !sample.has(i)), 'no sample id');
  assert.deepEqual([...first].sort(), all.filter((i) => !sample.has(i)).sort(), 'every other decisive pair');
  assert.deepEqual((await dry({ sample: 20 })).r.ids, first, 'second call');
  assert.deepEqual((await dry({ sample: 5 })).r.ids, first, 'not moved by --sample');
  assert.deepEqual(first, sampleIds(all, 80, 7).filter((i) => !sample.has(i)), 'the order of the sample code');
  assert.ok(!first.some((i) => ['nopair', 'noact', 't900'].includes(i)));
});

test('I8 a v1 outside run writes -opus-v1-outside.json with promptSha256 and the passRule, and rows carry set outside', async () => {
  // Breaks when: the report name ignores prompt or set (a v1 report would overwrite another), or the header drops the frozen sha or the pass rule.
  const data = rows(55);
  const x = await exec({ dailyShare: 100, set: 'outside', prompt: 'v1' }, data);
  assert.match(path.basename(x.r.outPath), /^\d{4}-\d{2}-\d{2}-hf-judge-precheck-opus-v1-outside\.json$/);
  const o = JSON.parse(readFileSync(x.r.outPath, 'utf8'));
  assert.deepEqual([o.model, o.effort, o.promptVersion, o.set], ['opus', 'high', 'v1', 'outside']);
  assert.equal(o.promptSha256, JUDGE_PROMPT_V1_SHA256);
  assert.equal(o.passRule, 'pass = kappa >= 0.60 on this set for this model and prompt; written before the run; no second prompt on the outside set after a fail');
  assert.equal(o.summary.n, 5);
  assert.ok(ledgerLines(x.ledgerPath).every((l) => l.set === 'outside'));
  const v0 = await exec({ dailyShare: 100, set: 'outside' }, data);
  assert.match(path.basename(v0.r.outPath), /-opus-v0-outside\.json$/);
  assert.equal(v0.r.out.promptSha256, sha256(judgePrompt(EMPTY_PAIR)));
  assert.match(path.basename((await exec({ sample: 1, prompt: 'v1' }, data)).r.outPath), /-opus-v1-sample\.json$/);
});

test('I9 a v1 run whose prompt sha differs from the sha on paid v1 rows for that model and set is refused before any call or ledger write', async () => {
  // Breaks when: the freeze check is dropped, runs after the first call, compares across models or sets, or reads only end rows.
  const data = rows(55);
  const other = 'f'.repeat(64);
  for (const phase of ['end', 'start']) {
    const ledgerPath = writeLedger([JSON.stringify({ ts: new Date(NOW - 1000).toISOString(), phase, dataset: DS, pairId: 'z1', ...OPUS_V1_OUTSIDE, promptSha256: other })]);
    const before = readFileSync(ledgerPath, 'utf8');
    const x = await exec({ dailyShare: 100, set: 'outside', prompt: 'v1' }, data, { ledgerPath });
    assert.equal(x.r.code, 2, `${phase} row`);
    assert.equal(x.v.calls.length, 0);
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, 'no new ledger line');
  }
  const same = writeLedger([endRow('z1', 'yes', 'yes', { ...OPUS_V1_OUTSIDE, promptSha256: JUDGE_PROMPT_V1_SHA256 })]);
  assert.equal((await exec({ dailyShare: 100, set: 'outside', prompt: 'v1' }, data, { ledgerPath: same })).r.code, 0, 'the same sha goes on');
  const unrelated = writeLedger([
    endRow('z1', 'yes', 'yes', { ...OPUS_V1_OUTSIDE, set: 'sample', promptSha256: other }),
    endRow('z2', 'yes', 'yes', { ...OPUS_V1_OUTSIDE, model: 'sonnet', promptSha256: other }),
    endRow('z3', 'yes', 'yes', { model: 'opus', promptVersion: 'v0', set: 'outside', promptSha256: other }),
  ]);
  assert.equal((await exec({ dailyShare: 100, set: 'outside', prompt: 'v1' }, data, { ledgerPath: unrelated })).r.code, 0, 'another set, model or prompt does not freeze this one');
});

test('I10 an interrupted run resumes: judged pairs are skipped, and no pair is counted twice, even with a repeated end row', async () => {
  // Breaks when: resume ignores (model, prompt, set) rows, re-judges a pair, or the summary counts every end row instead of one per pair.
  const data = rows(55);
  const ledgerPath = path.join(tmp(), 'l.jsonl');
  const step = (share, v = verdictRun('yes')) => exec({ dailyShare: share, set: 'outside', prompt: 'v1' }, data, { ledgerPath, v });
  const calls = [(await step(2)).v.calls.length, (await step(4)).v.calls.length];
  const last = await step(10);
  calls.push(last.v.calls.length);
  assert.deepEqual(calls, [2, 2, 1]);
  assert.equal(last.r.out.summary.n, 5);
  const ends = ledgerLines(ledgerPath).filter((l) => l.phase === 'end');
  assert.equal(new Set(ends.map((l) => l.pairId)).size, 5);
  writeFileSync(ledgerPath, `${readFileSync(ledgerPath, 'utf8')}${JSON.stringify(ends[0])}\n`);
  const again = await step(20);
  assert.equal(again.v.calls.length, 0);
  assert.equal(again.r.out.summary.n, 5, 'a repeated end row counts once');
});

test('I11 a dry run with --set outside --prompt v1 --show-prompts 0 prints the pair counts, makes 0 calls and writes nothing', async () => {
  // Breaks when: the plan hides the set size, judged or pending counts, a dry run prints prompts or calls claude, or it counts rows of another prompt as judged.
  const data = rows(80);
  const ids = (await exec({ dryRun: true, showPrompts: 0, set: 'outside', prompt: 'v1' }, data)).r.ids;
  const ledgerPath = writeLedger([
    doneRow(data, ids[0], OPUS_V1_OUTSIDE),
    doneRow(data, ids[1], OPUS_V1_OUTSIDE),
    doneRow(data, ids[2], { model: 'opus', promptVersion: 'v0', set: 'outside' }),
  ]);
  const before = readFileSync(ledgerPath, 'utf8');
  const x = await exec({ dryRun: true, showPrompts: 0, set: 'outside', prompt: 'v1' }, data, { ledgerPath });
  assert.equal(x.v.calls.length, 0);
  assert.equal(x.r.headlessCalls, 0);
  assert.match(x.c.lines[0], /prompt v1 set outside/);
  assert.match(x.c.lines[0], /pairs in set 30/);
  assert.match(x.c.lines[0], /already judged 2, pending 28/);
  assert.ok(!x.c.lines.some((l) => l.includes('UNTRUSTED DATA')), 'no prompt printed');
  assert.equal(readFileSync(ledgerPath, 'utf8'), before);
  assert.deepEqual([x.r.pairsInSet, x.r.judged, x.r.pending], [30, 2, 28]);
});

test('I12 a v1 call maps a thrown runner to timeout and a cap to a stop, as the v0 judge does', async () => {
  // Breaks when: the v1 path lets a runner throw escape, or reads a cap as a timeout so a capped batch keeps spending calls.
  const thrown = await exec({ sample: 2, prompt: 'v1' }, [yesRow('t1'), yesRow('t2')], { v: { fn: async () => { throw new Error('boom'); }, calls: [] } });
  assert.equal(thrown.r.code, 0);
  const errs = ledgerLines(thrown.ledgerPath).filter((l) => l.phase === 'end').map((l) => l.error);
  assert.deepEqual(errs, ['timeout', 'timeout']);
  let n = 0;
  const capped = await exec({ sample: 3, prompt: 'v1' }, [yesRow('t1'), yesRow('t2'), yesRow('t3')], { v: { fn: async () => { n += 1; return { ok: false, reason: 'cap' }; }, calls: [] } });
  assert.equal(n, 1);
  assert.equal(capped.r.code, 2);
  assert.equal(ledgerLines(capped.ledgerPath).find((l) => l.phase === 'end').error, 'cap');
});

test('I13 the v1 freeze also checks the filled-field sha: rows carry it, a different one is refused, and a row without it is not', async () => {
  // Breaks when: a change to the clip limits or field labels (the filled text) passes the freeze, or the paid rows from before the filled sha are refused.
  const data = rows(55);
  const x = await exec({ dailyShare: 100, set: 'outside', prompt: 'v1' }, data);
  assert.ok(ledgerLines(x.ledgerPath).every((l) => l.promptFilledSha256 === JUDGE_PROMPT_V1_FILLED_SHA256));
  assert.equal(x.r.out.promptFilledSha256, JUDGE_PROMPT_V1_FILLED_SHA256);
  const moved = writeLedger([endRow('z1', 'yes', 'yes', { ...OPUS_V1_OUTSIDE, promptSha256: JUDGE_PROMPT_V1_SHA256, promptFilledSha256: 'f'.repeat(64) })]);
  const r = await exec({ dailyShare: 100, set: 'outside', prompt: 'v1' }, data, { ledgerPath: moved });
  assert.equal(r.r.code, 2);
  assert.equal(r.v.calls.length, 0);
  const legacy = writeLedger([endRow('z1', 'yes', 'yes', { ...OPUS_V1_OUTSIDE, promptSha256: JUDGE_PROMPT_V1_SHA256 })]);
  assert.equal((await exec({ dailyShare: 100, set: 'outside', prompt: 'v1' }, data, { ledgerPath: legacy })).r.code, 0);
});

test('I14 a v1 verdict counts only when its recorded shas are the current ones, from any set', async () => {
  // Breaks when: a v1 verdict made with another prompt text (for example on the sample set) is reused and counted under the current sha.
  const data = rows(55);
  const ids = (await exec({ dryRun: true, showPrompts: 0, set: 'outside', prompt: 'v1' }, data)).r.ids;
  const old = { model: 'opus', promptVersion: 'v1', set: 'sample' };
  const cases = [
    [{ promptSha256: 'f'.repeat(64) }, 5],
    [{ promptSha256: JUDGE_PROMPT_V1_SHA256, promptFilledSha256: 'f'.repeat(64) }, 5],
    [{ promptSha256: JUDGE_PROMPT_V1_SHA256, promptFilledSha256: JUDGE_PROMPT_V1_FILLED_SHA256 }, 4],
    [{ promptSha256: JUDGE_PROMPT_V1_SHA256 }, 4],
  ];
  for (const [shas, calls] of cases) {
    const ledgerPath = writeLedger([doneRow(data, ids[0], { ...old, ...shas })]);
    const x = await exec({ dailyShare: 100, set: 'outside', prompt: 'v1' }, data, { ledgerPath });
    assert.equal(x.v.calls.length, calls, JSON.stringify(shas));
    assert.equal(x.r.out.summary.n, 5);
  }
});