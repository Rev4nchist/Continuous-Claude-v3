// Tests for scripts/github/pr-spend.mjs (card prflow-spend-line). Contract note: .claudedocs/e2e-prflow-spend-line/2026-11-12-contract-note.md.
// Every test runs the real main() against ledgers in a temp folder. The head lookup runs the real `git cat-file --batch-check`
// against a temp repo with one commit: its sha is "in the CCv3 store", a made-up sha is not. No test touches ~/.claude, the
// network or a model. Paths use / and node:path only, so the file also runs on ubuntu CI.
//
// How the script can fail, one test each below (the change that breaks each test is named in its comment):
//   T1  a row that names another repo is joined to a CCv3 PR
//   T2  a CodeRabbit row whose head is not in the CCv3 store lands on a PR instead of notProven
//   T3  an eval-* ref counts as PR spend
//   P1  a trex-, range-, eval- ref or a purpose other than review counts (the branch- allowlist)
//   T4  two equal CodeRabbit rows are deduplicated
//   T5  one bad line kills the run, or is dropped without a count
//   T6  a missing ledger shows 0 instead of null / "absent"
//   T7  a CodeRabbit CLI row or a headless row is put on a PR, or headless dollars reach a total
//   T8  the file holds a session id, branch, ref, path, head or finding text
//   T9  spend is joined on pr + head instead of pr alone
// plus: the git lookup (one process, 8-char head, junk head, git failure, time-out), the land row, null usage, and the write path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CCV3 = 'Rev4nchist/Continuous-Claude-v3';
const RANDOM = 'deadbeef'.repeat(5); // a 40-hex sha that no repo here has
const MERGE = '1234abcd'.repeat(5); // a merge sha that differs from every head in the fixtures
const load = () => import('./pr-spend.mjs'); // imported inside each test: a missing module fails each test by name

let repoDir;
let SHA; // the one commit of the temp repo
const scratch = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'ccv3-pr-spend-')); scratch.push(d); return d; };

before(() => {
  repoDir = mk();
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repoDir, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  SHA = git('rev-parse', 'HEAD');
});
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------- fixtures

const TS = '2026-11-05T12:00:00.000Z';
const crRow = (o = {}) => ({ ts: TS, date: '2026-11-05', pr: 1, head: SHA, files: 1, cost: 0.25, session: 'SESSION-SECRET-CR', ...o });
const crCli = (o = {}) => ({ ts: TS, date: '2026-11-05', kind: 'cli', branch: 'feat/secret-branch', head: SHA, files: 2, cost: 0.5, session: 'SESSION-SECRET-CR', ...o });
const USAGE = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 };

/** A cursor start row and its end row. `over.start` and `over.end` add or replace fields (undefined removes one). */
function pair(base, over = {}) {
  const { id, pr, head = SHA, ref = 'branch-secret-ref', purpose = 'review', repo = CCV3, usage = USAGE, timedOut = false, mode = 'full' } = base;
  const start = { ts: TS, phase: 'start', id, ref, model: 'composer-2.5', band: 'MID', sessionId: 'SESSION-SECRET-CU', repo, purpose, ...over.start };
  const end = {
    ts: TS, phase: 'end', id, ref, model: 'composer-2.5', band: 'MID', sessionId: 'SESSION-SECRET-CU', durationMs: 5, exit: 0, timedOut, usage,
    pr, head, mode, engineSha: 'ENGINE-SHA', findingCount: 2, recordPath: 'C:/secret/path/record.json', recordSha256: 'REC-SHA', repo, purpose,
    message: 'FINDING-TEXT-SECRET', ...over.end,
  };
  for (const row of [start, end]) for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  return [start, end];
}

function writeLines(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}

/** Run main() on temp ledgers. A ledger left out of `spec` is not written (its path still points into the temp folder). */
async function run(spec = {}, { deps = {}, args = [] } = {}) {
  const { main } = await load();
  const dir = mk();
  const f = { coderabbit: join(dir, 'cr.jsonl'), cursor: join(dir, 'cursor.jsonl'), land: join(dir, 'land.jsonl'), headless: join(dir, 'headless.jsonl') };
  for (const k of Object.keys(f)) if (spec[k]) writeLines(f[k], spec[k]);
  const out = join(dir, 'out');
  if (spec.open) writeLines(join(out, 'open-prs.json'), [{ schema: 1, rows: spec.open.map((pr) => ({ pr })) }]);
  const argv = ['--out', out, '--coderabbit', f.coderabbit, '--cursor', f.cursor, '--land', f.land, '--headless', f.headless, ...args];
  const lines = [];
  const errs = [];
  const code = main(argv, { home: join(dir, 'home'), primaryRoot: repoDir, now: () => new Date('2026-11-12T10:00:00Z'), log: (m) => lines.push(m), err: (m) => errs.push(m), ...deps });
  const file = join(out, 'pr-spend.json');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
  return { code: await code, lines, errs, text, doc: text ? JSON.parse(text) : null, dir, out, f };
}
const keys = (r) => r.doc.rows.map((x) => x.pr);
const rowOf = (r, pr) => r.doc.rows.find((x) => x.pr === pr);

// ---------------------------------------------------------------- the design rules

test('T1 a row that names another repo is not joined (CCv3 and its short name are)', async () => {
  // Breaks when the repo filter is removed: PR 7 would carry spend although its repo is another one (its head even resolves).
  const r = await run({
    cursor: [
      ...pair({ id: 'a1', pr: 7, head: SHA, repo: 'Other/elsewhere' }),
      ...pair({ id: 'a2', pr: 8, head: RANDOM, repo: CCV3 }),
      ...pair({ id: 'a3', pr: 9, head: RANDOM, repo: 'continuous-claude' }),
    ],
    land: [{ schema: 1, pr: 11, repo: 'Other/elsewhere', mergeSha: MERGE, mergeCall: 'ok', reviewers: ['engine'], crRounds: 0 }],
  });
  assert.equal(r.code, 0);
  assert.deepEqual(keys(r), [9, 8]);
  assert.equal(r.doc.excluded.engineOtherRepo, 1);
  assert.equal(r.doc.excluded.landOtherRepo, 1);
  assert.equal(r.doc.reconcile.engine.prEndRows, 3);
});

test('T2 a CodeRabbit row whose head is not in the CCv3 store goes to notProven, not on a PR', async () => {
  // Breaks when a row with no repo field is trusted without the head lookup.
  const r = await run({ coderabbit: [crRow({ pr: 20, head: SHA, cost: 0.25 }), crRow({ pr: 21, head: RANDOM, cost: 0.75, files: 3 })] });
  assert.deepEqual(keys(r), [20]);
  assert.deepEqual(r.doc.notProven.coderabbit, { rows: 1, usd: 0.75, files: 3 });
  assert.equal(r.doc.notProven.git, 'ok');
  assert.equal(rowOf(r, 20).coderabbit.usd, 0.25);
});

test('a CodeRabbit head of 8 characters resolves by prefix', async () => {
  // Breaks when the lookup needs a full 40-hex head: real CodeRabbit rows hold 8-char heads.
  const r = await run({ coderabbit: [crRow({ pr: 22, head: SHA.slice(0, 8) })] });
  assert.deepEqual(keys(r), [22]);
  assert.deepEqual(r.doc.notProven.coderabbit, { rows: 0, usd: 0, files: 0 });
});

test('a head that is not a 7 to 40 hex id is never sent to git and does not prove a row (HEAD resolves in any repo)', async () => {
  // Breaks when the hex check before git is removed: `HEAD^{commit}` resolves in any repo, so the name must never reach git.
  const { gitBatchCheck } = await load();
  const sent = [];
  const recording = (heads, cwd) => { sent.push(...heads); return gitBatchCheck(heads, cwd); };
  const r = await run({ coderabbit: [crRow({ pr: 23, head: 'HEAD' }), crRow({ pr: 24, head: 'main' }), crRow({ pr: 25, head: SHA })] }, { deps: { runGit: recording } });
  assert.deepEqual(keys(r), [25]);
  assert.equal(r.doc.notProven.coderabbit.rows, 2);
  assert.deepEqual(sent, [SHA], 'only the real sha reaches git');
  assert.ok(sent.every((h) => /^[0-9a-f]{7,40}$/i.test(h)));
});

test('with no primary root given, the head lookup runs in the checkout the script is in (no second git call to find a primary)', async () => {
  // Breaks when the default folder is looked up by another git process, or is the current folder instead of the script's checkout.
  const cwds = [];
  const recording = (heads, cwd) => { cwds.push(cwd); return { status: 0, stdout: heads.map(() => 'x missing').join('\n') + '\n' }; };
  const before = process.cwd();
  process.chdir(mk()); // the run starts from another folder, as a scheduled task does
  try { await run({ coderabbit: [crRow({ pr: 26, head: SHA })] }, { deps: { primaryRoot: undefined, runGit: recording } }); } finally { process.chdir(before); }
  assert.deepEqual(cwds, [join(dirname(fileURLToPath(import.meta.url)), '..', '..')].map((p) => resolve(p)));
});

test('one git process serves every head, and none starts when no row needs a proof', async () => {
  // Breaks when the lookup runs once per head, or runs with an empty list.
  const { gitBatchCheck } = await load();
  let calls = 0;
  const counting = (...a) => { calls++; return gitBatchCheck(...a); };
  const rows = [crRow({ pr: 30, head: SHA }), crRow({ pr: 31, head: RANDOM }), crRow({ pr: 32, head: SHA.slice(0, 10) }), crRow({ pr: 33, head: SHA })];
  await run({ coderabbit: rows }, { deps: { runGit: counting } });
  assert.equal(calls, 1);
  calls = 0;
  await run({ cursor: pair({ id: 'g1', pr: 34, head: RANDOM, repo: CCV3 }) }, { deps: { runGit: counting } });
  assert.equal(calls, 0);
});

test('git failure and git time-out: every unproven row goes to notProven and the file is still written', async () => {
  // Breaks when a failed lookup throws, drops the file, or trusts the rows.
  const rows = { coderabbit: [crRow({ pr: 40, cost: 1 }), crRow({ pr: 41, cost: 2, head: RANDOM })], cursor: pair({ id: 'f1', pr: 42, repo: undefined, head: SHA }, { start: { repo: undefined }, end: { repo: undefined } }) };
  const nonRepo = mk();
  const a = await run(rows, { deps: { primaryRoot: nonRepo } });
  assert.equal(a.code, 0);
  assert.deepEqual(keys(a), []);
  assert.equal(a.doc.notProven.git, 'failed');
  assert.equal(a.doc.notProven.coderabbit.rows, 2);
  assert.equal(a.doc.notProven.coderabbit.usd, 3);
  assert.equal(a.doc.notProven.engine.rows, 1);
  const b = await run(rows, { deps: { runGit: () => ({ error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null }) } });
  assert.equal(b.code, 0);
  assert.equal(b.doc.notProven.git, 'failed');
  assert.equal(b.doc.notProven.coderabbit.rows, 2);
  const c = await run(rows, { deps: { runGit: () => ({ status: 0, stdout: 'only one line\n' }) } });
  assert.equal(c.doc.notProven.git, 'failed', 'a line count that differs from the heads sent is a failure');
});

test('T3 an eval-* ref is not PR spend', async () => {
  // Breaks when the ref check is removed: an eval run carries pr and purpose review too.
  const r = await run({ cursor: [...pair({ id: 'e1', pr: 50, ref: 'eval-50-abcd1234' }), ...pair({ id: 'e2', pr: 51, ref: 'branch-real' })] });
  assert.deepEqual(keys(r), [51]);
  assert.equal(r.doc.excluded.engineNotReview, 1);
});

test('P1 only a review run on a branch ref counts: trex-, range-, eval- refs and purpose verify are out, delta and no purpose are in', async () => {
  // Breaks when the branch- allowlist is removed, or the purpose check is removed, or the ref is read from the end row only.
  const none = { purpose: undefined };
  const r = await run({
    cursor: [
      ...pair({ id: 'p30', pr: 30, ref: 'branch-a' }),
      ...pair({ id: 'p31', pr: 31, ref: 'branch-b' }, { start: none, end: none }),
      ...pair({ id: 'p32', pr: 32, ref: 'branch-c', mode: 'delta' }),
      ...pair({ id: 'p33', pr: 33 }, { start: { ref: 'branch-d' }, end: { ref: undefined } }),
      ...pair({ id: 'p34', pr: 34, ref: 'trex-p1' }),
      ...pair({ id: 'p35', pr: 35, ref: 'eval-35-abcd1234' }),
      ...pair({ id: 'p36', pr: 36, ref: 'branch-e', purpose: 'verify' }),
      ...pair({ id: 'p37', pr: 37, ref: 'eval-37-abcd1234' }, { start: { ref: 'branch-f' } }),
      ...pair({ id: 'p38', pr: 38, ref: 'range-aaa..bbb' }),
      ...pair({ id: 'p39', pr: 39, ref: 'plan-x' }),
      ...pair({ id: 'p40', pr: 40, ref: 'linktype-x' }),
    ],
  });
  assert.deepEqual(keys(r), [33, 32, 31, 30], 'rows sort by pr, highest first');
  assert.equal(r.doc.excluded.engineNotReview, 7);
  assert.equal(r.doc.reconcile.engine.prEndRows, 11);
  assert.equal(r.doc.reconcile.engine.counted, 4);
});

test('an end row with no matching start row still counts when its own ref is a branch ref', async () => {
  // Breaks when the start row is required.
  const [, end] = pair({ id: 's1', pr: 55 });
  const r = await run({ cursor: [end] });
  assert.deepEqual(keys(r), [55]);
});

test('a start row and an end row that name two different branch refs are out (CodeRabbit CLI finding, pre-pr 7a93a87)', async () => {
  // Breaks when the ref check tests only the branch- prefix of each row and not that both rows name the same ref.
  const r = await run({ cursor: [...pair({ id: 'd1', pr: 60 }, { start: { ref: 'branch-a' }, end: { ref: 'branch-b' } }), ...pair({ id: 'd2', pr: 61 })] });
  assert.deepEqual(keys(r), [61]);
  assert.equal(r.doc.excluded.engineNotReview, 1);
});

test('a run is another repo when its start row or its end row names another repo, in either order (CodeRabbit CLI finding, pre-pr 7a93a87)', async () => {
  // Breaks when the end row's repo hides a different repo on the start row (repo = end ?? start).
  const r = await run({
    cursor: [
      ...pair({ id: 'r1', pr: 62 }, { start: { repo: 'Other/elsewhere' }, end: { repo: CCV3 } }),
      ...pair({ id: 'r2', pr: 63 }, { start: { repo: CCV3 }, end: { repo: 'Other/elsewhere' } }),
      ...pair({ id: 'r3', pr: 64 }, { start: { repo: CCV3 }, end: { repo: undefined } }),
    ],
  });
  assert.deepEqual(keys(r), [64]);
  assert.equal(r.doc.excluded.engineOtherRepo, 2);
});

test('engine spend is tokens and run counts only; a null usage adds no tokens but still counts the run', async () => {
  // Breaks when a null usage throws, drops the run, or a dollar field appears.
  const r = await run({
    cursor: [
      ...pair({ id: 'u1', pr: 60 }),
      ...pair({ id: 'u2', pr: 60, usage: null, timedOut: true }),
      ...pair({ id: 'u3', pr: 60, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } }),
    ],
  });
  assert.deepEqual(rowOf(r, 60).engine, { runs: 3, timedOut: 1, tokens: { in: 11, out: 22, cacheRead: 33, cacheWrite: 44 } });
  assert.ok(!/usd|dollar|cost/i.test(JSON.stringify(rowOf(r, 60).engine)));
});

test('T4 two equal CodeRabbit rows count as two rounds', async () => {
  // Breaks when CodeRabbit rows are deduplicated on pr + head (they have no id).
  const same = crRow({ pr: 70, cost: 0.5, files: 2 });
  const r = await run({ coderabbit: [same, { ...same }] });
  assert.deepEqual(rowOf(r, 70).coderabbit, { usd: 1, rounds: 2, files: 4 });
});

test('T5 a bad line is skipped and counted, and the rest is kept (BOM, CRLF, truncated, non-object lines)', async () => {
  // Breaks when one bad line throws (cr-paid readLedger does), or a skip is not counted.
  const { main } = await load();
  const dir = mk();
  const file = join(dir, 'cr.jsonl');
  const good = (pr) => JSON.stringify(crRow({ pr }));
  writeFileSync(file, `\uFEFF${good(81)}\r\n{"ts":"truncated\r\n[1,2]\r\nnull\r\n42\r\n\r\n${good(82)}\r\n`);
  const lines = [];
  const code = await main(['--out', join(dir, 'out'), '--coderabbit', file, '--cursor', join(dir, 'no1'), '--land', join(dir, 'no2'), '--headless', join(dir, 'no3')],
    { home: join(dir, 'home'), primaryRoot: repoDir, now: () => new Date('2026-11-12T10:00:00Z'), log: (m) => lines.push(m), err: () => {} });
  assert.equal(code, 0);
  const doc = JSON.parse(readFileSync(join(dir, 'out', 'pr-spend.json'), 'utf8'));
  assert.deepEqual(doc.rows.map((x) => x.pr), [82, 81]);
  assert.deepEqual(doc.sources.coderabbit, { state: 'ok', rows: 2, skipped: 4 });
});

test('a CodeRabbit row with no usable pr or cost is skipped and counted, not summed as 0', async () => {
  // Breaks when a row with a bad cost adds NaN or 0 to a PR.
  const r = await run({ coderabbit: [crRow({ pr: 90 }), crRow({ pr: 91, cost: 'abc' }), crRow({ pr: 'x' }), { ts: TS, head: SHA, cost: 1 }] });
  assert.deepEqual(keys(r), [90]);
  assert.equal(r.doc.sources.coderabbit.skipped, 3);
});

test('T6 a missing ledger is "absent" and its part is null, never 0; a present ledger with no rows for a PR shows 0', async () => {
  // Breaks when an absent source is read as an empty one.
  const none = await run({});
  assert.equal(none.code, 0);
  assert.deepEqual(none.doc.rows, []);
  for (const name of ['coderabbit', 'cursor', 'land', 'headless']) assert.deepEqual(none.doc.sources[name], { state: 'absent', rows: 0, skipped: 0 }, name);
  assert.equal(none.doc.unattributed.headless, null);
  assert.equal(none.doc.unattributed.coderabbitCli, null);
  assert.equal(none.doc.notProven.coderabbit, null, 'an absent ledger has no notProven dollars either');
  assert.equal(none.doc.notProven.engine, null);
  assert.equal(none.lines.length, 1);
  assert.match(none.lines[0], /coderabbit absent, engine absent, not proven coderabbit absent and engine absent/);
  assert.ok(!/\$0\.00/.test(none.lines[0].replace(/cli absent/, '')), `no $0.00 for an absent ledger: ${none.lines[0]}`);

  const onlyCursor = await run({ cursor: pair({ id: 'm1', pr: 100 }) });
  assert.equal(rowOf(onlyCursor, 100).coderabbit, null, 'CodeRabbit ledger absent: null');
  assert.equal(rowOf(onlyCursor, 100).landed, null);
  assert.equal(rowOf(onlyCursor, 100).engine.runs, 1);

  const both = await run({ cursor: pair({ id: 'm2', pr: 100 }), coderabbit: [crRow({ pr: 101 })] });
  assert.deepEqual(rowOf(both, 100).coderabbit, { usd: 0, rounds: 0, files: 0 }, 'ledger present, no round for this PR: zero');
  assert.deepEqual(rowOf(both, 101).engine, { runs: 0, timedOut: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } });
});

test('T7 a CodeRabbit CLI row and every headless row are unattributed; headless dollars are in no total', async () => {
  // Breaks when a CLI row or a headless row lands on a PR, or the headless sum reaches the console total.
  const hl = [
    { ts: TS, day: '2026-11-05', phase: 'start', id: 'h1', purpose: 'eval-judge', model: 'm', sessionId: 'SESSION-SECRET-HL' },
    { ts: TS, phase: 'end', id: 'h1', exit: 0, durationMs: 1, timedOut: false, costUsd: 3.5, usage: {}, keyStripped: true },
    { ts: TS, phase: 'end', id: 'h2', exit: 0, durationMs: 1, timedOut: false, costUsd: 4.27, usage: {}, keyStripped: true },
  ];
  const r = await run({ coderabbit: [crRow({ pr: 110, cost: 0.25 }), crCli({ cost: 0.4 }), crCli({ cost: 0.6 })], headless: hl });
  assert.deepEqual(keys(r), [110]);
  assert.deepEqual(r.doc.unattributed.coderabbitCli, { rows: 2, usd: 1 });
  assert.equal(r.doc.unattributed.headless.runs, 2);
  assert.equal(r.doc.unattributed.headless.nominalUsd, 7.77);
  assert.match(r.doc.unattributed.headless.note, /nominal/i);
  assert.equal(rowOf(r, 110).headless, 'not shown');
  assert.equal(rowOf(r, 110).sessionTokens, 'not shown');
  assert.equal(rowOf(r, 110).coderabbit.usd, 0.25);
  const line = r.lines.join('\n');
  assert.ok(!line.includes('7.77'), `the console line must not hold the headless dollars: ${line}`);
  assert.match(line, /coderabbit \$0\.25/);
});

test('T8 the file holds no session id, branch, ref, path, head, record field or finding text', async () => {
  // Breaks when a ledger row is spread into the output, or a field is added for a head, ref, branch or session.
  const r = await run({
    coderabbit: [crRow({ pr: 120 }), crCli()],
    cursor: pair({ id: 'k1', pr: 120 }),
    land: [{ schema: 1, ts: TS, pr: 120, repo: CCV3, headSha: SHA, mergeSha: MERGE, mergeCall: 'ok', method: 'squash', band: null, labels: ['SECRET-LABEL'], reviewers: ['coderabbit'], engineRecord: 'secret-slug/aaaa/run.json', crRounds: 1, ignoreReview: null, waiver: null }],
    headless: [{ ts: TS, day: '2026-11-05', phase: 'start', id: 'h1', purpose: 'x', model: 'm', sessionId: 'SESSION-SECRET-HL' }],
  });
  assert.ok(r.text.length > 50 && r.doc.rows.length === 1);
  const banned = ['SESSION-SECRET', 'secret-branch', 'secret-ref', 'branch-', 'secret/path', 'record.json', 'ENGINE-SHA', 'REC-SHA', 'FINDING-TEXT', SHA, SHA.slice(0, 8), RANDOM,
    'SECRET-LABEL', 'secret-slug', 'headSha', 'engineRecord', 'recordPath', 'sessionId', 'branch', r.dir.replace(/\\/g, '/'), r.dir.replace(/\\/g, '\\\\')];
  for (const s of banned) assert.ok(!r.text.includes(s), `the file must not hold "${s}"`);
  assert.equal(rowOf(r, 120).landed.mergeSha, MERGE);
});

test('T9 spend is summed across heads: the join is on pr alone', async () => {
  // Breaks when the join key is pr + head.
  const r = await run({
    coderabbit: [crRow({ pr: 130, head: SHA, cost: 0.5, files: 2 }), crRow({ pr: 130, head: SHA, cost: 0.25, files: 1 })],
    cursor: [...pair({ id: 'n1', pr: 130, head: SHA }), ...pair({ id: 'n2', pr: 130, head: RANDOM })],
  });
  assert.equal(r.doc.rows.length, 1);
  const row = rowOf(r, 130);
  assert.deepEqual(row.coderabbit, { usd: 0.75, rounds: 2, files: 3 });
  assert.deepEqual(row.engine.tokens, { in: 20, out: 40, cacheRead: 60, cacheWrite: 80 });
  assert.equal(row.engine.runs, 2);
  assert.equal(row.heads, 2, 'a count of heads, never the heads');
});

// ---------------------------------------------------------------- the land row and the write path

test('land row: mergeSha, mergeCall, reviewers, crRounds; merged-elsewhere has a null mergeSha; a landed PR with no spend still has a row; the last row of a PR wins', async () => {
  // Breaks when the land row is dropped, mergeSha is faked, or an earlier row wins.
  const land = [
    { schema: 1, pr: 140, repo: CCV3, headSha: SHA, mergeSha: RANDOM, mergeCall: 'ok', reviewers: ['engine'], crRounds: 0 },
    { schema: 1, pr: 140, repo: CCV3, headSha: SHA, mergeSha: MERGE, mergeCall: 'ok', reviewers: ['coderabbit', 'engine'], crRounds: 2 },
    { schema: 1, pr: 141, repo: CCV3, headSha: SHA, mergeSha: null, mergeCall: 'merged-elsewhere', reviewers: ['none'], crRounds: 0 },
  ];
  const r = await run({ land, cursor: pair({ id: 'l1', pr: 140 }) });
  assert.deepEqual(rowOf(r, 140).landed, { mergeSha: MERGE, mergedAt: null, mergeCall: 'ok', reviewers: ['coderabbit', 'engine'], crRounds: 2 });
  assert.deepEqual(rowOf(r, 141).landed, { mergeSha: null, mergedAt: null, mergeCall: 'merged-elsewhere', reviewers: ['none'], crRounds: 0 });
  assert.equal(rowOf(r, 141).engine.runs, 0);
});

test('P2 the land ledger is read while another handle holds it open for append', async () => {
  // Breaks when the reader opens the land ledger for write or with a lock: a land would be blocked, or the read would fail.
  const { main } = await load();
  const dir = mk();
  const land = join(dir, 'land.jsonl');
  writeLines(land, [{ schema: 1, pr: 150, repo: CCV3, mergeSha: MERGE, mergeCall: 'ok', reviewers: [], crRounds: 0 }]);
  const fd = openSync(land, 'a');
  try {
    writeSync(fd, '');
    const code = await main(['--out', join(dir, 'out'), '--coderabbit', join(dir, 'a'), '--cursor', join(dir, 'b'), '--land', land, '--headless', join(dir, 'c')],
      { home: dir, primaryRoot: repoDir, log: () => {}, err: () => {} });
    assert.equal(code, 0);
  } finally { closeSync(fd); }
  assert.equal(JSON.parse(readFileSync(join(dir, 'out', 'pr-spend.json'), 'utf8')).rows[0].pr, 150);
});

test('write: envelope fields, a temp file renamed under a lock that is gone afterwards, and exit 1 when the lock is held or the folder is not writable', async () => {
  // Breaks when the file is written in place, the lock is left behind, or a write failure exits 0.
  const r = await run({ coderabbit: [crRow({ pr: 160 })] });
  assert.equal(r.code, 0);
  assert.equal(r.doc.schema, 1);
  assert.equal(r.doc.exportedAt, '2026-11-12T10:00:00.000Z');
  assert.deepEqual(Object.keys(r.doc.sources).sort(), ['coderabbit', 'cursor', 'headless', 'land']);
  assert.ok(!existsSync(join(r.out, 'pr-spend.json.tmp')));
  assert.ok(!existsSync(join(r.out, '.pr-spend.lock')));
  assert.equal(r.lines.at(-1).includes('\n'), false, 'one summary line');
  assert.equal(r.errs.length, 0);

  const { main } = await load();
  const dir = mk();
  const out = join(dir, 'out');
  mkdirSync(out);
  writeFileSync(join(out, '.pr-spend.lock'), '1');
  const errs = [];
  const held = await main(['--out', out, '--coderabbit', join(dir, 'a'), '--cursor', join(dir, 'b'), '--land', join(dir, 'c'), '--headless', join(dir, 'd')],
    { home: dir, primaryRoot: repoDir, log: () => {}, err: (m) => errs.push(m) });
  assert.equal(held, 1);
  assert.equal(errs.length, 1);
  assert.ok(!existsSync(join(out, 'pr-spend.json')));

  const blocker = join(dir, 'file-not-folder');
  writeFileSync(blocker, 'x');
  const bad = await main(['--out', join(blocker, 'sub'), '--coderabbit', join(dir, 'a'), '--cursor', join(dir, 'b'), '--land', join(dir, 'c'), '--headless', join(dir, 'd')],
    { home: dir, primaryRoot: repoDir, log: () => {}, err: (m) => errs.push(m) });
  assert.equal(bad, 1);
  assert.equal(errs.length, 2);
});

test('an unknown argument exits 2 and writes nothing', async () => {
  // Breaks when a typo in a flag is ignored and the real default folder is written.
  const { main } = await load();
  const errs = [];
  assert.equal(await main(['--nope'], { home: mk(), err: (m) => errs.push(m), log: () => {} }), 2);
  assert.equal(errs.length, 1);
});

// ---------------------------------------------------------------- merge time and non-repo PR numbers (card agentic-os-feeds-truth, C3 and C15)

test('M1 C3 the land row carries mergedAt, the ts of the ledger row, as an ISO time; a missing or bad ts gives null', async () => {
  // Breaks when mergedAt is dropped, copied as text without a check, or taken from the run time.
  const land = [
    { schema: 1, ts: '2026-11-24T01:06:58Z', pr: 710, repo: CCV3, headSha: SHA, mergeSha: MERGE, mergeCall: 'ok', reviewers: [], crRounds: 0 },
    { schema: 1, pr: 711, repo: CCV3, headSha: SHA, mergeSha: MERGE, mergeCall: 'ok', reviewers: [], crRounds: 0 },
    { schema: 1, ts: 'last night', pr: 712, repo: CCV3, headSha: SHA, mergeSha: MERGE, mergeCall: 'ok', reviewers: [], crRounds: 0 },
  ];
  const r = await run({ land });
  assert.equal(rowOf(r, 710).landed.mergedAt, '2026-11-24T01:06:58.000Z');
  assert.equal(rowOf(r, 711).landed.mergedAt, null);
  assert.equal(rowOf(r, 712).landed.mergedAt, null);
});

test('M2 C15 a row whose PR number is far above every landed PR is not a PR of this repo: dropped, counted, never named', async () => {
  // Breaks when the bound is removed: the rows of the fixture numbers would sit in the file and in its totals.
  const land = [{ schema: 1, ts: TS, pr: 700, repo: CCV3, headSha: SHA, mergeSha: MERGE, mergeCall: 'ok', reviewers: [], crRounds: 0 }];
  const cr = [crRow({ pr: 705 }), crRow({ pr: 715 }), crRow({ pr: 1001 }), crRow({ pr: 1007 })];
  const r = await run({ land, coderabbit: cr, cursor: pair({ id: 'f1', pr: 1003 }) });
  assert.deepEqual(keys(r).sort((a, b) => a - b), [700, 705, 715]);
  assert.equal(r.doc.excluded.nonRepoPr, 3, 'two CodeRabbit PRs and one engine PR, counted by PR');
  assert.ok(!r.text.includes('1001') && !r.text.includes('1007') && !r.text.includes('1003'), 'the numbers are not written');
  assert.ok(![...r.lines, ...r.errs].join('\n').match(/100[137]/), 'nor logged');
});

test('M3 C15 the open-prs.json beside the output raises the bound; with no landed PR and no open file nothing is dropped', async () => {
  // Breaks when the bound ignores the open feed (a new PR above the last landed one would be dropped) or invents a bound from nothing.
  const land = [{ schema: 1, ts: TS, pr: 700, repo: CCV3, headSha: SHA, mergeSha: MERGE, mergeCall: 'ok', reviewers: [], crRounds: 0 }];
  const withOpen = await run({ land, open: [730], coderabbit: [crRow({ pr: 745 }), crRow({ pr: 1001 })] });
  assert.deepEqual(keys(withOpen).sort((a, b) => a - b), [700, 745]);
  const none = await run({ coderabbit: [crRow({ pr: 1001 })] });
  assert.deepEqual(keys(none), [1001]);
  assert.equal(none.doc.excluded.nonRepoPr, 0);
});
