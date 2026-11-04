// Tests for rerate.mjs. Every test imports the real functions. No model is called: a stub runner or a stub `claude` script stands in.
// Failure modes, each named with the source change that breaks its test:
//  F1  a call without --live            -> main passes opts.live ignoring the flag, or calls runClaudeFn in the dry path
//  F2  the S4 rule                      -> rerateDecision compares ranks the wrong way, raises, drops two levels, or ignores the null input
//  F3  major -> minor keeps confidence  -> newConfidence not set to 2 on the major -> minor move
//  F4  the wrong hunk                   -> selectHunks keeps every hunk, or none, or tests overlap on the old side
//  F5  the scope                        -> a blocked row enters the plan, group C goes before B, the cap grows on resume
//  F6  resume                           -> an answered pid is asked again
//  F7  shared cap                       -> --live starts with fewer calls left than planned
//  F8  model 1 leaks to model 2         -> the prompt carries the severity, confidence or fixPrompt of the finding
//  F9  unusable model answer            -> a bad answer counts as agreement-with-evidence or deletes the finding
//  F10 C2 shape                         -> a probe-set pid is missing from verdicts.json
//  F11 the real call path               -> purpose is not 'rerate', or --json-schema is not on the argv, or the key is not stripped
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../../lib/headless.mjs';
import { defaultBaselineDir, loadBaseline } from './probe-set.mjs';
import {
  MAX_CALLS, SCHEMA, buildPrompt, buildVerdicts, capHeadroom, findFinding, loadRaws, main, parseAnswer, planCalls, promptDocument,
  promptForRow, rerateDecision, scopeRows, selectHunks, sourceWindow, validateAnswer,
} from './rerate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'rerate-'));
const ans = (severity, concreteFailingInput = 'x=1', reason = 'because') => ({ severity, concreteFailingInput, reason });
const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

// ---------- F2, F3: the S4 rule ----------

test('F2/F3 rerateDecision: the S4 rule, one case per branch', () => {
  const major = { severity: 'major', confidence: 5 };
  const critical = { severity: 'critical', confidence: 5 };
  const cases = [
    ['major rated minor with an input: down to minor, confidence 2', major, ans('minor'), 'rerate_down', 'minor', 2],
    ['major rated info: still ONE level (minor), not two', major, ans('info'), 'rerate_down', 'minor', 2],
    ['major rated major with an input: kept', major, ans('major'), 'rerate_keep', 'major', 5],
    ['major rated major with NO input: down', major, ans('major', null), 'rerate_down', 'minor', 2],
    ['an empty-string input is no input', major, ans('major', '   '), 'rerate_down', 'minor', 2],
    ['major rated critical with an input: never raised', major, ans('critical'), 'rerate_keep', 'major', 5],
    ['major rated critical with no input: down (not raised)', major, ans('critical', null), 'rerate_down', 'minor', 2],
    ['critical rated major: down to major, confidence unchanged', critical, ans('major'), 'rerate_down', 'major', 5],
    ['critical rated critical with no input: down to major', critical, ans('critical', null), 'rerate_down', 'major', 5],
    ['critical rated trivial: ONE level (major)', critical, ans('trivial'), 'rerate_down', 'major', 5],
    ['critical rated critical with an input: kept', critical, ans('critical'), 'rerate_keep', 'critical', 5],
  ];
  for (const [name, orig, a, verdict, sev, conf] of cases) {
    const d = rerateDecision(orig, a);
    assert.deepEqual([d.verdict, d.newSeverity, d.newConfidence], [verdict, sev, conf], name);
  }
});

test('F3 a Major at confidence 3 or 4 also lands on confidence 2 when it goes to minor', () => {
  assert.equal(rerateDecision({ severity: 'major', confidence: 3 }, ans('minor')).newConfidence, 2);
  assert.equal(rerateDecision({ severity: 'major', confidence: 4 }, ans('minor')).newConfidence, 2);
});

test('F2 a finding below major has nothing to lose: it is kept', () => {
  const d = rerateDecision({ severity: 'minor', confidence: 4 }, ans('trivial', null));
  assert.deepEqual([d.verdict, d.newSeverity, d.newConfidence], ['rerate_keep', 'minor', 4]);
});

test('F9 an unusable answer keeps the finding and says why (never a delete, never a lower)', () => {
  for (const bad of [null, undefined, 'major', { severity: 'huge', concreteFailingInput: null, reason: 'x' }, { severity: 'major', reason: 'x' }, { severity: 'major', concreteFailingInput: 3, reason: 'x' }]) {
    const d = rerateDecision({ severity: 'major', confidence: 5 }, bad);
    assert.deepEqual([d.verdict, d.newSeverity, d.newConfidence], ['rerate_keep', 'major', 5]);
    assert.match(d.reason, /^unusable model answer/);
  }
});

test('validateAnswer: trims to the three keys and rejects a wrong type', () => {
  assert.deepEqual(validateAnswer({ ...ans('major', null), extra: 1 }), { ok: true, value: ans('major', null) });
  assert.equal(validateAnswer([]).ok, false);
  assert.equal(validateAnswer({ severity: 'major', concreteFailingInput: null }).ok, false);
});

// ---------- F4: hunks ----------

const DIFF = [
  'diff --git a/f.mjs b/f.mjs', 'index 1..2 100644', '--- a/f.mjs', '+++ b/f.mjs',
  '@@ -1,4 +1,5 @@', ' a', ' b', '+NEW-AT-3', ' c', ' d',
  '@@ -100,5 +101,4 @@', ' p', '-GONE', ' q', ' r', '+ADDED-AT-104', '\\ No newline at end of file',
].join('\n');

test('F4 selectHunks keeps only the hunk whose new-side range overlaps the cited lines', () => {
  const first = selectHunks(DIFF, 3, 3);
  assert.equal(first.length, 1);
  assert.match(first[0], /NEW-AT-3/);
  assert.doesNotMatch(first[0], /ADDED-AT-104/);
  const second = selectHunks(DIFF, 104, 104);
  assert.equal(second.length, 1);
  assert.match(second[0], /ADDED-AT-104/);
  assert.equal(selectHunks(DIFF, 50, 60).length, 0, 'no overlap gives no hunk');
  assert.equal(selectHunks(DIFF, 1, 200).length, 2);
});

test('F4 selectHunks numbers lines on the new side, blanks a deleted line, and an old-side-only match does not count', () => {
  const [h] = selectHunks(DIFF, 104, 104);
  const lines = h.split('\n');
  assert.ok(lines.some((l) => /^\s*101  p$/.test(l)), 'context line p is line 101');
  assert.ok(lines.some((l) => /^\s+-GONE$/.test(l)), 'a deleted line has no number');
  assert.ok(lines.some((l) => /^\s*102  q$/.test(l)), 'line q follows the deletion at 102');
  assert.ok(lines.some((l) => /^\s*104 \+ADDED-AT-104$/.test(l)));
  // Old-side range of hunk 2 is 100-104; new side is 101-104. Line 100 is outside the new side.
  assert.equal(selectHunks(DIFF, 100, 100).length, 0);
});

test('F4 a hunk over the line limit is trimmed to the lines near the cited range', () => {
  const body = Array.from({ length: 400 }, (_, i) => `+L${i + 1}`).join('\n');
  const [h] = selectHunks(`@@ -0,0 +1,400 @@\n${body}`, 200, 201, { ctx: 5, maxLines: 50 });
  assert.match(h, /trimmed/);
  assert.match(h, /\+L200\b/);
  assert.match(h, /\+L206\b/);
  assert.doesNotMatch(h, /\+L100\b/);
  assert.doesNotMatch(h, /\+L300\b/);
});

test('sourceWindow clamps at the file edges and numbers the lines', () => {
  const src = Array.from({ length: 30 }, (_, i) => `row${i + 1}`).join('\n');
  const w = sourceWindow(src, 3, 4, 20).split('\n');
  assert.match(w[0], /^\s*1  row1$/);
  assert.match(w.at(-1), /^\s*24  row24$/);
});

// ---------- F8: the prompt ----------

const FINDING = {
  id: 'p1', file: 'x/y.mjs', startLine: 3, endLine: 3, bucket: 'actionable', severity: 'major', category: 'correctness', effort: 'heavy_lift',
  title: 'Title-T', body: 'Body-B', suggestion: null, fixPrompt: 'FIXPROMPT-LEAK', confidence: 5, evidence: ['x/y.mjs:3'], status: 'open', firstSeenSha: 'SEEN-LEAK',
};

test('F8 the prompt carries the finding but not model 1 (severity, confidence, fixPrompt)', () => {
  const p = buildPrompt({ finding: FINDING, file: 'x/y.mjs', head: SHA, mergeBase: BASE, hunks: ['@@ -1 +1 @@\n    3 +x'] });
  assert.match(p, /Title-T/);
  assert.match(p, /Body-B/);
  assert.match(p, /x\/y\.mjs:3/);
  assert.doesNotMatch(p, /FIXPROMPT-LEAK/);
  assert.doesNotMatch(p, /"severity"/);
  assert.doesNotMatch(p, /"confidence"/);
  assert.doesNotMatch(p, /"bucket"/);
  assert.match(p, /untrusted data/);
  assert.match(p, /concreteFailingInput/);
});

test('the prompt says so when no hunk overlaps and shows the head source window instead', () => {
  const p = buildPrompt({ finding: FINDING, file: 'x/y.mjs', head: SHA, mergeBase: BASE, hunks: [], windowText: '    3  WINDOW-LINE' });
  assert.match(p, /No diff hunk overlaps/);
  assert.match(p, /WINDOW-LINE/);
});

// ---------- F5, F6: the plan ----------

const mk = (n, group, row, extra = {}) => ({ pid: `p${String(n).padStart(2, '0')}`, row, group, file: 'x/y.mjs', startLine: 3, endLine: 3, title: `T${n}`, severity: 'major', confidence: 5, head: SHA, mergeBase: BASE, blocked: null, ...extra });

test('F5 scopeRows: blocked rows are out, and group order is A, B, C whatever the input order', () => {
  const rows = [mk(1, 'C', 'S3'), mk(2, 'B', 'N3', { blocked: 'mods-host' }), mk(3, 'B', 'N4'), mk(4, 'A', 'S1'), mk(5, 'C', 'S9', { blocked: 'windows-only' })];
  assert.deepEqual(scopeRows(rows).map((r) => r.pid), ['p04', 'p03', 'p01']);
});

test('F5 planCalls: the scope is the first 16 unblocked rows; the cap does not grow after answers', () => {
  const rows = [...Array.from({ length: 3 }, (_, i) => mk(i, 'A', 'S1')), ...Array.from({ length: 13 }, (_, i) => mk(10 + i, 'B', 'N3')), ...Array.from({ length: 5 }, (_, i) => mk(30 + i, 'C', 'S3'))];
  const fresh = planCalls(rows);
  assert.equal(fresh.scope.length, 16);
  assert.equal(fresh.pending.length, 16);
  assert.equal(fresh.scope.filter((r) => r.group === 'C').length, 0, 'group C gets no call while 16 scored findings exist');
  const raws = new Map(rows.slice(0, 5).map((r) => [r.pid, { ok: true, attempts: 1 }]));
  const resumed = planCalls(rows, raws);
  assert.equal(resumed.pending.length, 11, 'answered pids are skipped');
  assert.ok(resumed.pending.every((r) => r.group !== 'C'), 'answers do not pull group C into the scope');
});

test('F5 planCalls: --limit, failed pids retried once, and the total attempts never pass the cap', () => {
  const rows = Array.from({ length: 20 }, (_, i) => mk(i, 'B', 'N3'));
  assert.equal(planCalls(rows, new Map(), { limit: 1 }).pending.length, 1);
  const failedOnce = new Map([['p00', { ok: false, attempts: 1 }]]);
  assert.ok(planCalls(rows, failedOnce).pending.some((r) => r.pid === 'p00'), 'a pid that failed once is asked again');
  const failedTwice = new Map([['p00', { ok: false, attempts: 2 }]]);
  assert.ok(!planCalls(rows, failedTwice).pending.some((r) => r.pid === 'p00'), 'a pid that failed twice is not asked a third time');
  const spent = new Map(rows.slice(0, 14).map((r) => [r.pid, { ok: true, attempts: 1 }]));
  spent.set('p14', { ok: false, attempts: 1 });
  const plan = planCalls(rows, spent);
  assert.equal(plan.spent, 15);
  assert.equal(plan.firstCalls, 15);
  assert.equal(plan.pending.filter((r) => !spent.has(r.pid)).length, 1, 'only 1 first call left of 16');
  assert.equal(plan.pending.filter((r) => spent.has(r.pid)).length, 1, 'the retry of p14 is on top of the 16 first calls');
});

// Fix 7 (minor). Breaks if: retries draw on the 16-call pool (a retry then leaves a scored pid never asked), or the retry budget is not 3.
test('retries are a separate budget: 16 first calls plus at most 3 retries', () => {
  const rows = Array.from({ length: 20 }, (_, i) => mk(i, 'B', 'N3'));
  const sixteen = new Map(rows.slice(0, 16).map((r, i) => [r.pid, { ok: i >= 2, attempts: 1 }]));
  const plan = planCalls(rows, sixteen);
  assert.deepEqual(plan.pending.map((r) => r.pid).sort(), ['p00', 'p01'], 'all 16 asked once: only the 2 retries remain, nothing beyond the scope');
});

test('retries: after 3 retries are spent no failed pid is asked again, with 2 left it is', () => {
  const rows = Array.from({ length: 16 }, (_, i) => mk(i, 'B', 'N3'));
  const raws = (retried) => new Map(rows.map((r, i) => [r.pid, i < retried ? { ok: true, attempts: 2 } : i === 10 ? { ok: false, attempts: 1 } : { ok: true, attempts: 1 }]));
  assert.deepEqual(planCalls(rows, raws(3)).pending, [], '3 retries spent: p10 (failed once) is not retried');
  assert.deepEqual(planCalls(rows, raws(2)).pending.map((r) => r.pid), ['p10'], '2 retries spent: one more is allowed');
});

// ---------- F10: C2 ----------

// Fix 1 (critic major 1). Breaks if: buildVerdicts has no dryRun marker, no partial flag or no attemptedPids, so score-arms cannot tell a dry run from a run.
test('Fix 1: buildVerdicts says dryRun, partial and which scored pids got a usable answer', () => {
  const rows = [mk(1, 'A', 'S1'), mk(2, 'B', 'N3'), mk(3, 'B', 'N4'), mk(4, 'B', 'N7', { blocked: 'mods-host' })];
  const raws = new Map([['p01', { ok: true, answer: ans('minor'), path: 'r/p01.json' }], ['p02', { ok: false, answer: null, path: 'r/p02.json' }]]);
  const dry = buildVerdicts(rows, raws, { max: 16 });
  assert.equal(dry.dryRun, true, 'the default is a dry file');
  const live = buildVerdicts(rows, raws, { max: 16, live: true });
  assert.equal(live.dryRun, false);
  assert.deepEqual(live.attemptedPids, ['p01'], 'a failed call is not a usable answer; the blocked row is not in scope');
  assert.equal(live.partial, true, 'p02 and p03 have no usable answer');
  const done = buildVerdicts(rows, new Map(['p01', 'p02', 'p03'].map((p) => [p, { ok: true, answer: ans('major'), path: `r/${p}.json` }])), { max: 16, live: true });
  assert.deepEqual([done.partial, done.attemptedPids.length], [false, 3]);
});

// Fix 1. Breaks if: a dry run writes verdicts.json (it then replaces or imitates a live control file).
test('Fix 1: a dry run writes verdicts.dry-run.json with dryRun true and never touches verdicts.json', async () => {
  const w = world();
  mkdirSync(path.join(w.outDir, 'rerate'), { recursive: true });
  writeFileSync(path.join(w.outDir, 'rerate', 'verdicts.json'), '{"keep":"me"}');
  assert.equal(await main([...w.base], w.deps({ runClaudeFn: stubRunner() })), 0);
  assert.equal(readFileSync(path.join(w.outDir, 'rerate', 'verdicts.json'), 'utf8'), '{"keep":"me"}');
  const dry = JSON.parse(readFileSync(path.join(w.outDir, 'rerate', 'verdicts.dry-run.json'), 'utf8'));
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.attemptedPids, []);
});

// Breaks if: a live run does not write dryRun false, or marks a finished run partial, or lists a pid that was not answered.
test('Fix 1: a live run writes verdicts.json with dryRun false, partial false and every scoped pid in attemptedPids', async () => {
  const w = world({ n: 4 });
  assert.equal(await main([...w.base, '--live'], w.deps({ runClaudeFn: stubRunner() })), 0);
  const v = JSON.parse(readFileSync(path.join(w.outDir, 'rerate', 'verdicts.json'), 'utf8'));
  assert.deepEqual([v.dryRun, v.partial], [false, false]);
  assert.deepEqual(v.attemptedPids.sort(), ['p00', 'p01', 'p02', 'p03', 'p91']);
});

test('Fix 1: a live run that stops early is partial and does not list the failed pids', async () => {
  const w = world({ n: 6 });
  const bad = async () => ({ ok: true, id: 'x', result: 'not json' });
  assert.equal(await main([...w.base, '--live'], w.deps({ runClaudeFn: bad })), 1);
  const v = JSON.parse(readFileSync(path.join(w.outDir, 'rerate', 'verdicts.json'), 'utf8'));
  assert.equal(v.partial, true);
  assert.deepEqual(v.attemptedPids, []);
});

// Fix 7 (minor). Breaks if: --max-calls above the approved 16 is accepted (only the shared 30/day headroom would stop it).
test('--max-calls above 16 is refused with exit 2 and no call; 16 and below are accepted', async () => {
  const w = world({ n: 4 });
  const runner = stubRunner();
  for (const n of ['17', '30', '100']) {
    assert.equal(await main([...w.base, '--live', '--max-calls', n], w.deps({ runClaudeFn: runner })), 2, n);
  }
  assert.equal(runner.calls.length, 0);
  assert.match(w.err.join('\n'), /--max-calls .*16/);
  assert.equal(await main([...w.base, '--live', '--max-calls', '16'], w.deps({ runClaudeFn: runner })), 0);
  assert.equal(await main([...w.base, '--max-calls', '2'], w.deps({ runClaudeFn: runner })), 0);
});

test('F10 buildVerdicts: one row per probe-set pid, blocked and out-of-scope rows carry their reason', () => {
  const rows = [mk(1, 'A', 'S1'), mk(2, 'B', 'N3', { blocked: 'mods-host' }), mk(3, 'B', 'N4'), mk(4, 'B', 'N4')];
  const raws = new Map([['p01', { ok: true, answer: ans('minor'), path: 'raw/p01.json' }], ['p03', { ok: false, answer: null, path: 'raw/p03.json' }]]);
  const v = buildVerdicts(rows, raws, { max: 3 });
  assert.equal(v.arm, 'rerate');
  assert.deepEqual(v.rows.map((r) => r.pid), ['p01', 'p02', 'p03', 'p04']);
  const by = Object.fromEntries(v.rows.map((r) => [r.pid, r]));
  assert.deepEqual([by.p01.verdict, by.p01.newSeverity, by.p01.newConfidence, by.p01.evidencePath], ['rerate_down', 'minor', 2, 'raw/p01.json']);
  assert.equal(by.p02.verdict, 'blocked:mods-host');
  assert.equal(by.p02.newSeverity, 'major');
  assert.equal(by.p03.verdict, 'rerate_keep');
  assert.match(by.p03.reason, /unusable/);
  assert.equal(by.p04.verdict, 'not_attempted');
  assert.match(by.p04.reason, /in scope, not asked yet/);
  for (const r of v.rows) assert.deepEqual(Object.keys(r).sort(), ['evidencePath', 'falseConfirm', 'group', 'newConfidence', 'newSeverity', 'originalConfidence', 'originalSeverity', 'pid', 'reason', 'row', 'verdict']);
  const over = buildVerdicts(rows, new Map(), { max: 1 });
  assert.match(over.rows[3].reason, /outside the first 1 unblocked/);
});

// ---------- the model reply ----------

test('parseAnswer: plain JSON, fenced JSON, structured_output fallback, and a bad reply', () => {
  const a = ans('minor', null);
  assert.deepEqual(parseAnswer({ result: JSON.stringify(a) }), { ok: true, value: a });
  assert.deepEqual(parseAnswer({ result: `\`\`\`json\n${JSON.stringify(a)}\n\`\`\`` }), { ok: true, value: a });
  const stdout = `${JSON.stringify({ type: 'system' })}\n${JSON.stringify({ type: 'result', result: '', structured_output: a })}\n`;
  assert.deepEqual(parseAnswer({ result: '', stdout }), { ok: true, value: a });
  assert.equal(parseAnswer({ result: 'I think it is minor.' }).ok, false);
  const bad = parseAnswer({ result: JSON.stringify({ severity: 'huge', concreteFailingInput: null, reason: 'x' }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /severity "huge"/);
});

// ---------- main: a synthetic world ----------

function world({ n = 6, ledgerRows = 0, rowsExtra = [] } = {}) {
  const dir = tmp();
  const rows = [mk(0, 'A', 'S11', { startLine: 3, endLine: 3 }), ...Array.from({ length: n - 1 }, (_, i) => mk(i + 1, 'B', 'N16', { startLine: 3, endLine: 3 })), mk(90, 'B', 'N7', { blocked: 'mods-host' }), mk(91, 'C', 'S3'), ...rowsExtra];
  const probe = path.join(dir, 'probe-set.json');
  writeFileSync(probe, JSON.stringify({ schema: 1, rows }));
  const byRow = new Map();
  for (const r of rows) byRow.set(r.row, [...(byRow.get(r.row) ?? []), { ...FINDING, id: r.pid, file: r.file, title: r.title }]);
  const records = [...byRow].map(([id, findings]) => ({ id, record: { findings } }));
  const ledger = path.join(dir, 'ledger.jsonl');
  const now = Date.parse('2026-11-03T18:00:00Z');
  const lines = Array.from({ length: ledgerRows }, (_, i) => JSON.stringify({ ts: new Date(now).toISOString(), phase: 'start', id: `old-${i}`, purpose: 'other' }));
  writeFileSync(ledger, lines.length ? `${lines.join('\n')}\n` : '');
  const git = (args) => (args[0] === 'diff' ? DIFF.replace('f.mjs', 'y.mjs') : 'l1\nl2\nl3\nl4\n');
  const out = [];
  const err = [];
  const base = ['--probe-set', probe, '--out', path.join(dir, 'out'), '--ledger', ledger];
  const deps = (extra = {}) => ({ records, git, now: () => now, stdout: (s) => out.push(s), stderr: (s) => err.push(s), ...extra });
  return { dir, rows, probe, records, ledger, base, deps, out, err, outDir: path.join(dir, 'out'), now };
}

const stubRunner = (fn = () => ans('major')) => {
  const calls = [];
  const f = async (spec, hd) => { calls.push({ spec, hd }); const a = fn(spec, calls.length); return { ok: true, id: `id-${calls.length}`, result: JSON.stringify(a), exit: 0, costUsd: 0.01, durationMs: 5 }; };
  f.calls = calls;
  return f;
};

test('F1 without --live the runner is never called, the sample prompts print, the doc is written, verdicts.json has every row', async () => {
  const w = world();
  const runner = stubRunner();
  const doc = path.join(w.dir, 'prompt.md');
  const code = await main([...w.base, '--prompt-doc', doc], w.deps({ runClaudeFn: runner }));
  assert.equal(code, 0);
  assert.equal(runner.calls.length, 0);
  const text = w.out.join('\n');
  assert.match(text, /dry run \(no model call\)/);
  assert.match(text, /===== PROMPT S11 p00 =====/);
  assert.match(text, /===== PROMPT N16 p01 =====/);
  assert.match(text, /===== SCHEMA =====/);
  const md = readFileSync(doc, 'utf8');
  assert.match(md, /## S11 p00/);
  assert.match(md, /"required"/);
  const v = JSON.parse(readFileSync(path.join(w.outDir, 'rerate', 'verdicts.dry-run.json'), 'utf8'));
  assert.equal(v.rows.length, w.rows.length);
  assert.ok(v.rows.every((r) => r.verdict === 'not_attempted' || r.verdict.startsWith('blocked:')));
  assert.equal(existsSync(path.join(w.outDir, 'rerate', 'raw')), false, 'a dry run writes no raw answers');
});

test('F1 --dry-run and no flag at all behave the same; only the exact --live flag calls', async () => {
  const w = world();
  const runner = stubRunner();
  assert.equal(await main([...w.base, '--dry-run'], w.deps({ runClaudeFn: runner })), 0);
  assert.equal(await main([...w.base, '--liv'], w.deps({ runClaudeFn: runner })), 2, 'an unknown flag is refused');
  assert.equal(runner.calls.length, 0);
});

test('F1 --live does call the runner (the stub is wired), blocked rows are never sent, scope order is A then B then C', async () => {
  const w = world({ n: 4 });
  const runner = stubRunner();
  const code = await main([...w.base, '--live'], w.deps({ runClaudeFn: runner }));
  assert.equal(code, 0);
  const prompts = runner.calls.map((c) => c.spec.prompt);
  assert.equal(runner.calls.length, 5, '1 A + 3 B + 1 C; the blocked row is not sent');
  assert.match(prompts[0], /"title": "T0"/);
  assert.ok(runner.calls.every((c) => c.spec.purpose === 'rerate' && c.spec.model === 'sonnet'));
  assert.ok(runner.calls.every((c) => c.hd.prefixArgs.includes('--json-schema') && JSON.parse(c.hd.prefixArgs.at(-1)).required.includes('concreteFailingInput')));
  assert.equal(prompts.some((p) => p.includes('T90')), false, 'the mods-host row T90 is never sent');
  const v = JSON.parse(readFileSync(path.join(w.outDir, 'rerate', 'verdicts.json'), 'utf8'));
  assert.equal(v.rows.find((r) => r.pid === 'p90').verdict, 'blocked:mods-host');
  assert.equal(v.rows.find((r) => r.pid === 'p00').verdict, 'rerate_keep');
  assert.equal(readdirSync(path.join(w.outDir, 'rerate', 'raw')).length, 5);
});

test('F6 resume: pids with an ok answer in raw/ are skipped', async () => {
  const w = world({ n: 4 });
  const first = stubRunner();
  await main([...w.base, '--live', '--limit', '2'], w.deps({ runClaudeFn: first }));
  assert.equal(first.calls.length, 2);
  const second = stubRunner();
  await main([...w.base, '--live'], w.deps({ runClaudeFn: second }));
  assert.equal(second.calls.length, 3, '5 in scope - 2 answered');
  const asked = new Set([...first.calls, ...second.calls].map((c) => c.spec.prompt));
  assert.equal(asked.size, 5, 'no prompt was sent twice');
  const third = stubRunner();
  await main([...w.base, '--live'], w.deps({ runClaudeFn: third }));
  assert.equal(third.calls.length, 0);
});

test('F7 --live refuses when fewer calls are left under the shared cap than planned, and prints the number', async () => {
  const w = world({ n: 18, ledgerRows: 20 });
  const runner = stubRunner();
  const code = await main([...w.base, '--live'], w.deps({ runClaudeFn: runner }));
  assert.equal(code, 3);
  assert.equal(runner.calls.length, 0);
  assert.match(w.out.join('\n'), /10 calls left/);
  assert.match(w.err.join('\n'), /16 calls planned, 10 left/);
  const ok = world({ n: 18, ledgerRows: 14 });
  const r2 = stubRunner();
  assert.equal(await main([...ok.base, '--live'], ok.deps({ runClaudeFn: r2 })), 0);
  assert.equal(r2.calls.length, 16, '30 - 14 = 16 left, 16 planned: allowed');
});

test('F7 capHeadroom counts every purpose on the Chicago day', () => {
  const w = world({ ledgerRows: 7 });
  assert.deepEqual(capHeadroom(w.ledger, w.now), { used: 7, headroom: 23, cap: 30 });
  assert.deepEqual(capHeadroom(path.join(w.dir, 'none.jsonl'), w.now), { used: 0, headroom: 30, cap: 30 });
});

test('a run stops after 2 failed calls in a row, and the failed pid is kept in raw/ with attempts 1', async () => {
  const w = world({ n: 6 });
  const calls = [];
  const bad = async (spec) => { calls.push(spec); return { ok: true, id: 'x', result: 'not json' }; };
  const code = await main([...w.base, '--live'], w.deps({ runClaudeFn: bad }));
  assert.equal(code, 1);
  assert.equal(calls.length, 2);
  const raws = loadRaws(path.join(w.outDir, 'rerate', 'raw'));
  assert.deepEqual([...raws.values()].map((x) => [x.ok, x.attempts]), [[false, 1], [false, 1]]);
  const v = JSON.parse(readFileSync(path.join(w.outDir, 'rerate', 'verdicts.json'), 'utf8'));
  assert.equal(v.rows.find((r) => r.pid === 'p00').verdict, 'rerate_keep');
});

test('a cap refusal from the runner stops the run with exit 3 and keeps the earlier answers', async () => {
  const w = world({ n: 4 });
  let n = 0;
  const runner = async () => (++n <= 2 ? { ok: true, id: 'x', result: JSON.stringify(ans('minor')) } : { ok: false, reason: 'cap', count: 30 });
  const code = await main([...w.base, '--live'], w.deps({ runClaudeFn: runner }));
  assert.equal(code, 3);
  assert.equal(readdirSync(path.join(w.outDir, 'rerate', 'raw')).length, 2);
});

test('a missing finding fails the run before any call (exit 2)', async () => {
  const w = world({ n: 3 });
  const runner = stubRunner();
  const code = await main([...w.base, '--live'], w.deps({ runClaudeFn: runner, records: [] }));
  assert.equal(code, 2);
  assert.equal(runner.calls.length, 0);
  assert.match(w.err.join('\n'), /finding not found/);
});

test('a down answer lowers the verdict row and the raw file is its evidence', async () => {
  const w = world({ n: 2 });
  const runner = stubRunner((_s, i) => (i === 1 ? ans('minor') : ans('major', null)));
  await main([...w.base, '--live'], w.deps({ runClaudeFn: runner }));
  const v = JSON.parse(readFileSync(path.join(w.outDir, 'rerate', 'verdicts.json'), 'utf8'));
  for (const pid of ['p00', 'p01']) {
    const r = v.rows.find((x) => x.pid === pid);
    assert.deepEqual([r.verdict, r.newSeverity, r.newConfidence], ['rerate_down', 'minor', 2]);
    assert.ok(existsSync(r.evidencePath));
  }
});

// ---------- F11: the real runClaude with a stub `claude` ----------

test('F11 through the real runClaude: purpose rerate in the ledger, --json-schema on the argv, key stripped, answer read', async () => {
  const w = world({ n: 2 });
  const stub = path.join(w.dir, 'stub-claude.mjs');
  writeFileSync(stub, `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const answer = { severity: 'minor', concreteFailingInput: null, reason: JSON.stringify({ hasKey: 'ANTHROPIC_API_KEY' in process.env, argv: process.argv.slice(2).filter((a) => a.startsWith('--json-schema') || a.startsWith('--setting-sources') || a === 'project' || a.startsWith('{')), stdinLen: input.length }) };
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: answer, total_cost_usd: 0.01 }) + '\\n');
});
`);
  const headlessDeps = {
    ledgerPath: w.ledger, now: () => w.now, command: process.execPath, prefixArgs: [stub], skipConfigFiles: true, env: { ...process.env, ANTHROPIC_API_KEY: 'sk-should-not-pass' },
    agentDeps: { gateEnv: { CCV3_GROK_GATE: 'off' }, preflight: async () => ({ ok: true }), spacer: async () => {} },
  };
  const code = await main([...w.base, '--live', '--limit', '1'], w.deps({ runClaudeFn: runClaude, headlessDeps }));
  assert.equal(code, 0, w.err.join('\n'));
  const ledger = readFileSync(w.ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const start = ledger.find((l) => l.phase === 'start');
  assert.equal(start.purpose, 'rerate');
  assert.equal(start.model, 'sonnet');
  const raw = JSON.parse(readFileSync(path.join(w.outDir, 'rerate', 'raw', 'p00.json'), 'utf8'));
  assert.equal(raw.ok, true);
  assert.equal(raw.answer.severity, 'minor');
  const seen = JSON.parse(raw.answer.reason);
  assert.equal(seen.hasKey, false);
  assert.ok(seen.argv.includes('--json-schema'));
  // Coordinator item: user-level settings, rules and lane notes must not reach the rerate model.
  const at = seen.argv.indexOf('--setting-sources');
  assert.ok(at >= 0 && seen.argv[at + 1] === 'project', `argv holds --setting-sources project: ${JSON.stringify(seen.argv)}`);
  assert.ok(seen.stdinLen > 500, 'the prompt arrived on stdin');
});

// Coordinator item. Breaks if: the rerate prompt names a record (S1..S18, N3..N16), the pid or the words seeded / negative / hit, so model 2
// could read which findings are the seeded bugs and which are negatives.
test('the rerate prompt scaffold holds no record id and none of the words seeded, negative, hit', () => {
  const finding = { file: 'src/a.mjs', startLine: 3, endLine: 3, category: 'logic', title: 'Neutral title', body: 'Neutral body.', suggestion: 'Neutral fix.' };
  const withHunk = buildPrompt({ finding, file: 'src/a.mjs', head: SHA, mergeBase: BASE, hunks: ['@@ -1 +1 @@\n    3 +x'], windowText: '' });
  const noHunk = buildPrompt({ finding, file: 'src/a.mjs', head: SHA, mergeBase: BASE, hunks: [], windowText: '    3  x' });
  for (const p of [withHunk, noHunk]) {
    assert.doesNotMatch(p, /\b[SN]\d{1,2}\b/);
    assert.doesNotMatch(p, /seeded|negative|\bhits?\b/i);
  }
  const w = world({ n: 2 });
  const row = w.rows[0];
  const p = promptForRow(row, w.records, w.deps().git);
  assert.ok(!p.includes(row.pid) && !p.includes(row.row), 'neither the pid nor the record id is in the prompt');
});

// ---------- the real probe set and the real baseline (read only) ----------

const REAL_SET = JSON.parse(readFileSync(path.join(HERE, 'probe-set.json'), 'utf8'));
const hasBaseline = existsSync(path.join(defaultBaselineDir(), 'results.json'));
const hasHistory = spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${REAL_SET.rows[0].head}^{commit}`]).status === 0;

test('the real probe set: scope is the 3 group A + 13 group B unblocked findings; no group C, no blocked', () => {
  const plan = planCalls(REAL_SET.rows);
  assert.equal(MAX_CALLS, 16);
  assert.equal(plan.scope.length, 16);
  assert.deepEqual(['A', 'B', 'C'].map((g) => plan.scope.filter((r) => r.group === g).length), [3, 13, 0]);
  assert.deepEqual(plan.scope.filter((r) => r.group === 'A').map((r) => r.row).sort(), ['S1', 'S11', 'S8']);
  assert.ok(plan.scope.every((r) => !r.blocked));
  const v = buildVerdicts(REAL_SET.rows, new Map());
  assert.equal(v.rows.length, 44);
  assert.equal(new Set(v.rows.map((r) => r.pid)).size, 44);
  assert.equal(v.rows.filter((r) => r.verdict.startsWith('blocked:')).length, 9);
});

test('the real probe set: every scoped prompt builds from the baseline records and git, and the S11 prompt holds the cited lines', { skip: !(hasBaseline && hasHistory) && 'baseline records or bench history not in this clone' }, () => {
  const { records } = loadBaseline(defaultBaselineDir());
  const git = (args) => { const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }); return r.status === 0 ? r.stdout : null; };
  const plan = planCalls(REAL_SET.rows);
  for (const row of plan.scope) {
    const f = findFinding(records, row);
    assert.ok(f, `${row.pid} has a finding`);
    const p = promptForRow(row, records, git);
    assert.ok(p.includes(f.title), `${row.pid} prompt has the title`);
    assert.ok(!p.includes(f.fixPrompt ?? '\u0000no-fix-prompt'), `${row.pid} prompt has no fixPrompt`);
    assert.ok(p.length < 60_000, `${row.pid} prompt is ${p.length} chars`);
    assert.doesNotMatch(p, /\b[SN]\d{1,2}\b/, `${row.pid} prompt names a record id`);
    assert.ok(!p.includes(row.pid), `${row.pid} prompt holds the pid`);
  }
  const s11 = REAL_SET.rows.find((r) => r.pid === 'dd440119c9b87d61');
  const p = promptForRow(s11, records, git);
  assert.match(p, /\n\s*18[2-9]/, 'a numbered line from the cited range 182-197');
  assert.match(promptDocument([{ row: s11, prompt: p }]), /sha256/);
});
