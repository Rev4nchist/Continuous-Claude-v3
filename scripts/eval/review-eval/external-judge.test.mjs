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
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadRows, rowToPair, run, sampleIds, wilson } from './external-judge.mjs';
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
const verdictRun = (sameIssue = 'yes') => {
  const calls = [];
  const fn = async (req, deps) => { calls.push({ req, deps }); return { ok: true, stdout: JSON.stringify({ type: 'result', result: JSON.stringify({ sameIssue, real: 'unclear', confidence: 5, reason: 'r' }) }) }; };
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
    assert.equal(c.req.model, 'sonnet');
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

test('F9 an unmatched row falls back to all actions and records it', async () => {
  // Breaks when: the candidate source is not recorded, or the fallback is dropped.
  const r = rowToPair({ ...row(1, 'No'), judge_matched_action_id: null });
  assert.equal(r.candidateSource, 'all');
  assert.match(r.pair.eng.body, /fixed it/);
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
