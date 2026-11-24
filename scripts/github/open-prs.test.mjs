// Tests for scripts/github/open-prs.mjs (card prflow-open-prs). Design: .claudedocs/e2e-prflow-open-prs/2026-11-13-design-note.md, section 6.
// RED step: the script does not exist yet, so every test fails on the missing module. Each test imports the module itself, so a missing
// module fails each test by name. No test calls GitHub, a model or a database; gh and review-status are injected fakes. Paths use /
// and node:path only (CI runs this file on ubuntu too). The real child processes are the Q1 import probe, the contract test 17 and the runChild tests 18 and 18b.
//
// The dependency contract these tests pin (the writer builds to it):
//   main(argv, deps) -> Promise<exit code>.  argv: --out <dir> (the folder of open-prs.json), --cap <n> (default 20).
//   deps.now()                        -> Date (the injected clock; the run budget is 420 s of it)
//   deps.home                         -> a home folder (the script writes nothing under it)
//   deps.runGh(args, { timeoutMs })   -> { status, stdout, stderr } (async or sync). args are the gh arguments after `gh`:
//                                        ['api', 'repos/<repo>/pulls?state=open&per_page=100&page=<n>']
//                                        ['api', '--paginate', '--slurp', 'repos/<repo>/pulls/<n>/files?per_page=100']  (slurp: an array of pages)
//   deps.runStatus(pr, { repo, timeoutMs }) -> { status, stdout, stderr, timedOut?, pid? }  (review-status.mjs <pr> --json as a child;
//                                        timedOut true means the 60 s timer fired: the script then calls deps.killTree(pid))
//   deps.killTree(pid), deps.readConfig() -> the parsed review-router.config.json, deps.rename(from, to), deps.log(line), deps.err(line)
// Exit codes: 0 written (or skipped by a live lock), 10 gh abort with the old file kept, 1 write failure.
//
// How the script can fail, one test each (the source change that breaks each test is named in its comment):
//   1  list call fails         2  rate-limit text from review-status      3  files call fails      4  review-status exit 2
//   5  review-status time-out  6  cap and capped rows                    7  run budget ends      8  privacy (no title, no body, no reasons)
//   9  reason mapping          10 head moved                              11 live lock            12 dead lock / stale lock
//   13 rename failure          14 writes outside --out                    15 tap lookup           16 static import guard
//   17 contract with the real review-status
// plus Q1 (import starts nothing), C1 (token masking), C2 (labels), Q3 (header text), the envelope, pages, wiring.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bandOf } from './review-router.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = join(HERE, 'open-prs.mjs');
const REVIEW_STATUS = join(HERE, 'review-status.mjs');
const REPO = 'Rev4nchist/Continuous-Claude-v3';
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'review-router.config.json'), 'utf8'));
const load = () => import('./open-prs.mjs');

const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const sha = (n) => n.toString(16).padStart(40, '0');
const scratch = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'ccv3-open-prs-')); scratch.push(d); return d; };
// The store path is the one the real decisions lib reads. Every test points it at a temp path, so no test reads the real store.
const STORE_FILE = join(mkdtempSync(join(tmpdir(), 'ccv3-open-prs-store-')), 'store.json');
before(() => { scratch.push(dirname(STORE_FILE)); process.env.CCV3_DECISIONS_FILE = STORE_FILE; });
after(() => { delete process.env.CCV3_DECISIONS_FILE; for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------- fixtures

/** One item of the gh list response, with the fields the script must NOT copy (title, body, user, html_url) filled with sentinels. */
const item = (n, over = {}) => ({
  number: n,
  title: 'TITLE-SENTINEL',
  body: 'BODY-SENTINEL',
  user: { login: 'USER-SENTINEL' },
  html_url: 'https://github.com/URL-SENTINEL',
  draft: false,
  labels: [],
  updated_at: new Date(T0 - n * 60_000).toISOString(), // PR 1 is the newest: the processing order is 1, 2, 3, ...
  head: { ref: `feat/p${n}`, sha: sha(n) },
  ...over,
});
const items = (count, over = () => ({})) => Array.from({ length: count }, (_, k) => item(k + 1, over(k + 1)));

/** The review-status --json result for one PR (a fake of the real shape). */
const statusDoc = (pr, { head = sha(pr), ready = true, reasons = [], extra = {} } = {}) => ({ pr, head, headShort: head.slice(0, 7), ready, reasons, labels: [], isDraft: false, ...extra });
const okStatus = (pr, o = {}) => { const doc = statusDoc(pr, o); return { status: doc.ready ? 0 : 1, stdout: `${JSON.stringify(doc)}\n`, stderr: '' }; };

const tap = (step, key, head, at, label = 'Tap') => ({ id: `${step}\n${key}\n${head}`, row: { label, at, tree: 'TREE-SENTINEL', nonce: 'NONCE-SENTINEL' } });
const storeOf = (taps) => ({ version: 1, offers: {}, decisions: Object.fromEntries(taps.map((t) => [t.id, t.row])), misses: {} });

/**
 * Runs main() in a temp folder. spec: prs (list items), files {pr: [names]}, listFail, filesFail {pr: result}, status {pr: result or fn},
 * statusStep (ms the fake clock moves per review-status call), old (text of an existing open-prs.json), store (store object or raw text),
 * lock (text of an existing lock), lockMtimeMs, args, deps (override any dep),
 * onStatus({ out, pr }) (runs inside each review-status call), onLine(line, out) (runs on each log line).
 */
async function run(spec = {}) {
  const { main } = await load();
  const dir = mk();
  const out = join(dir, 'out');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  if (spec.ledger !== undefined) {
    mkdirSync(join(home, '.claude', 'state'), { recursive: true });
    writeFileSync(join(home, '.claude', 'state', 'land-outcomes.jsonl'), spec.ledger.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
  const outFile = join(out, 'open-prs.json');
  if (spec.old !== undefined || spec.lock !== undefined) mkdirSync(out, { recursive: true });
  if (spec.old !== undefined) writeFileSync(outFile, spec.old);
  if (spec.lock !== undefined) writeFileSync(join(out, '.open-prs.lock'), spec.lock);
  if (spec.lockMtimeMs !== undefined) utimesSync(join(out, '.open-prs.lock'), spec.lockMtimeMs / 1000, spec.lockMtimeMs / 1000);
  if (spec.store !== undefined) {
    const text = typeof spec.store === 'string' ? spec.store : JSON.stringify(spec.store);
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    writeFileSync(STORE_FILE, text);
  } else rmSync(STORE_FILE, { force: true });
  const prs = spec.prs ?? items(3);
  const clock = { t: spec.start ?? T0 };
  const calls = { gh: [], status: [], kill: [], lockDuring: [] };
  const lines = [];
  const errs = [];
  const runGh = (args, opts) => {
    calls.gh.push({ args, opts });
    const line = args.join(' ');
    let m = /pulls\?state=open&per_page=100&page=(\d+)/.exec(line);
    if (m) {
      if (spec.listFail) return spec.listFail;
      const page = Number(m[1]);
      return { status: 0, stdout: JSON.stringify(prs.slice((page - 1) * 100, page * 100)), stderr: '' };
    }
    if (/pulls\?state=closed&sort=updated&direction=desc&per_page=15/.test(line)) {
      if (spec.closedFail) return spec.closedFail;
      return { status: 0, stdout: JSON.stringify(spec.closed ?? []), stderr: '' };
    }
    m = /pulls\/(\d+)\/files/.exec(line);
    if (m) {
      const pr = Number(m[1]);
      if (spec.filesFail?.[pr]) return spec.filesFail[pr];
      const names = spec.files?.[pr] ?? [`docs/note-${pr}.md`];
      return { status: 0, stdout: JSON.stringify([names.map((filename) => ({ filename, status: 'modified', patch: 'PATCH-SENTINEL' }))]), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected gh call: ${line}` };
  };
  const runStatus = (pr, opts) => {
    calls.status.push({ pr, opts });
    calls.lockDuring.push(existsSync(join(out, '.open-prs.lock')));
    clock.t += spec.statusStep ?? 0;
    spec.onStatus?.({ out, pr });
    const given = spec.status?.[pr];
    if (typeof given === 'function') return given(pr);
    return given ?? okStatus(pr);
  };
  const argv = ['--out', out, ...(spec.args ?? [])];
  const deps = {
    now: () => new Date(clock.t), home, runGh, runStatus, readConfig: () => CONFIG,
    killTree: (pid) => calls.kill.push(pid), log: (m) => { lines.push(m); spec.onLine?.(m, out); }, err: (m) => errs.push(m), ...spec.deps,
  };
  const code = await main(argv, deps);
  const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : null;
  // The OLD sentinel file is not JSON (tests 1, 2, 3, 11, 13 compare its bytes), so a parse failure gives doc null.
  const parsed = (() => { try { return text ? JSON.parse(text) : null; } catch { return null; } })();
  return { code, lines, errs, calls, text, doc: parsed, dir, out, outFile, lock: join(out, '.open-prs.lock'), home, clock };
}
const rowOf = (r, pr) => r.doc.rows.find((x) => x.pr === pr);
const prsOf = (r) => r.doc.rows.map((x) => x.pr);
const statusPrs = (r) => r.calls.status.map((c) => c.pr);
const filesPrs = (r) => r.calls.gh.map((c) => /pulls\/(\d+)\/files/.exec(c.args.join(' '))?.[1]).filter(Boolean).map(Number);
const leftovers = (r) => (existsSync(r.out) ? readdirSync(r.out).filter((f) => f !== 'open-prs.json') : []);
const OLD = 'OLD-FILE-CONTENT-must-stay\n';

// Token shapes are built at run time: no secret-looking literal sits in this file.
const TOK = { ghp: `ghp${'_'}${'Aa1'.repeat(12)}`, gho: `gho${'_'}${'Bb2'.repeat(12)}`, ghs: `ghs${'_'}${'Cc3'.repeat(12)}`, pat: `github${'_'}pat${'_'}${'Dd4'.repeat(15)}`, bearer: `Bearer ${'Ee5Zz9'.repeat(6)}` };
const tokenTails = ['Aa1Aa1Aa1', 'Bb2Bb2Bb2', 'Cc3Cc3Cc3', 'Dd4Dd4Dd4', 'Ee5Zz9Ee5Zz9'];

// ---------------------------------------------------------------- the abort rule (condition d)

test('1 the list call fails: old file byte-equal, one err line, exit 10, runGh called once, no lock left', async () => {
  // Breaks when a failed list call is ignored (empty list written), retried, or returns a code other than 10.
  const r = await run({ old: OLD, listFail: { status: 1, stdout: '', stderr: 'gh: HTTP 500 server error' } });
  assert.equal(r.code, 10);
  assert.equal(readFileSync(r.outFile, 'utf8'), OLD);
  assert.equal(r.errs.length, 1, r.errs.join('\n'));
  assert.match(r.errs[0], /^open-prs: gh failed \(.*\), old file kept$/);
  assert.equal(r.calls.gh.length, 1, 'no retry');
  assert.deepEqual(leftovers(r), [], 'no tmp file and no lock');
});

test('1b a list call that answers with text that is not JSON aborts the same way (exit 10, old file kept)', async () => {
  // Breaks when JSON.parse of the list answer is not guarded: the run would crash with a stack and exit 1, or write an empty file.
  const r = await run({ old: OLD, listFail: { status: 0, stdout: '<html>not json</html>', stderr: '' } });
  assert.equal(r.code, 10);
  assert.equal(readFileSync(r.outFile, 'utf8'), OLD);
  assert.deepEqual(leftovers(r), []);
});

test('2 rate-limit text on the review-status stderr of PR 2 aborts: no write, PR 3 never started, exit 10', async () => {
  // Breaks when only the exit code of review-status is read (exit 2 would become a per-PR row) or the run goes on after the limit.
  for (const text of ['gh: API rate limit exceeded (HTTP 403)', 'You have exceeded a secondary rate limit', 'gh: HTTP 429 Too Many Requests']) {
    const r = await run({ old: OLD, status: { 2: { status: 2, stdout: '', stderr: `review-status: could not determine (${text})\n` } } });
    assert.equal(r.code, 10, text);
    assert.equal(readFileSync(r.outFile, 'utf8'), OLD, text);
    assert.deepEqual(statusPrs(r), [1, 2], `no runStatus call for PR 3 (${text})`);
    assert.ok(!filesPrs(r).includes(3), `no files call for PR 3 (${text})`);
    assert.equal(r.errs.length, 1);
    assert.match(r.errs[0], /old file kept/);
    assert.deepEqual(leftovers(r), []);
  }
});

test('2b with no old file, an abort writes nothing at all', async () => {
  // Breaks when the abort path writes a partial or empty open-prs.json.
  const r = await run({ status: { 1: { status: 2, stdout: '', stderr: 'gh: HTTP 403' } } });
  assert.equal(r.code, 10);
  assert.equal(r.text, null);
  assert.deepEqual(leftovers(r), []);
});

test('4b a 403 line on the stderr of a review-status that answered (exit 0 or 1) does not abort: the row is kept', async () => {
  // Breaks when the rate rule reads the stderr of a child that gave an answer: one side-call 403 would freeze the whole file.
  const side = (doc, line) => ({ ...doc, stderr: `${line}\n` });
  const r = await run({ status: {
    2: side(okStatus(2), 'gh: Resource not accessible by integration (HTTP 403)'),
    3: side(okStatus(3, { ready: false }), 'warning: a side call said HTTP 403'),
  } });
  assert.equal(r.code, 0, r.errs.join('\n'));
  assert.deepEqual(statusPrs(r), [1, 2, 3]);
  assert.deepEqual([rowOf(r, 2).status, rowOf(r, 2).ready, rowOf(r, 3).status, rowOf(r, 3).ready], ['ok', true, 'ok', false]);
});

test('5a the abort line holds the first stderr line that matches the rate rule, not the first line', async () => {
  // Breaks when maskTail keeps its first-non-empty-line rule for a rate-limit abort: the log would name an unrelated line.
  const viaStatus = await run({ old: OLD, status: { 1: { status: 2, stdout: '', stderr: 'review-status: first line is noise\ngh: API rate limit exceeded\n' } } });
  assert.equal(viaStatus.code, 10);
  assert.match(viaStatus.errs[0], /API rate limit exceeded/);
  assert.doesNotMatch(viaStatus.errs[0], /noise/);
  const viaList = await run({ old: OLD, listFail: { status: 1, stdout: '', stderr: 'gh: first line is noise\ngh: HTTP 429 Too Many Requests\n' } });
  assert.equal(viaList.code, 10);
  assert.match(viaList.errs[0], /HTTP 429/);
  assert.doesNotMatch(viaList.errs[0], /noise/);
});

test('3 a files call that answers HTTP 403, or fails for any reason, aborts: no write, nothing after it, exit 10', async () => {
  // Breaks when a failed files call gives a row with band null instead of an abort.
  for (const stderr of ['gh: Resource not accessible (HTTP 403)', 'boom: connection reset']) {
    const r = await run({ old: OLD, filesFail: { 2: { status: 1, stdout: '', stderr } } });
    assert.equal(r.code, 10, stderr);
    assert.equal(readFileSync(r.outFile, 'utf8'), OLD);
    assert.deepEqual(filesPrs(r), [1, 2], 'no files call for PR 3');
    assert.deepEqual(statusPrs(r), [1], 'review-status for PR 2 and 3 never starts');
    assert.equal(r.errs.length, 1);
    assert.deepEqual(leftovers(r), []);
  }
});

// ---------------------------------------------------------------- per-PR failures (condition d, per-PR rows)

test('4 review-status exit 2 with plain stderr gives a review-status-failed row, ready null; the file is written, exit 0', async () => {
  // Breaks when one broken PR aborts the whole run (the file would freeze), or the row reads ready false instead of null.
  const r = await run({ status: { 2: { status: 2, stdout: '', stderr: 'review-status: could not determine (head moved during the read)\n' } } });
  assert.equal(r.code, 0);
  assert.deepEqual(prsOf(r), [1, 2, 3]);
  assert.equal(rowOf(r, 2).status, 'review-status-failed');
  assert.equal(rowOf(r, 2).ready, null);
  assert.equal(rowOf(r, 1).status, 'ok');
  assert.equal(rowOf(r, 3).status, 'ok');
  assert.deepEqual(statusPrs(r), [1, 2, 3], 'the run goes on after the failed PR');
  assert.ok(r.lines.includes('open-prs: 3 rows, ok 2, capped 0, deadline 0, failed 1'), r.lines.join('\n'));
});

test('5 review-status that hangs past its timer gives review-status-timeout, and killTree gets the child pid', async () => {
  // Breaks when a timed-out child is not killed (an orphan gh lives on), the pid is not passed, or the timeout aborts the run.
  const r = await run({ status: { 2: { status: null, stdout: '', stderr: '', timedOut: true, pid: 4242 } } });
  assert.equal(r.code, 0);
  assert.equal(rowOf(r, 2).status, 'review-status-timeout');
  assert.equal(rowOf(r, 2).ready, null);
  assert.deepEqual(r.calls.kill, [4242]);
  assert.deepEqual(statusPrs(r), [1, 2, 3]);
  assert.ok(r.calls.status.every((c) => c.opts.timeoutMs > 0 && c.opts.timeoutMs <= 60_000), 'the per-child limit is at most 60 s');
  assert.ok(r.calls.status.every((c) => c.opts.repo === REPO));
});

test('5b a review-status child that times out after it printed rate-limit text is killed first, then the run aborts with exit 10', async () => {
  // Breaks when the rate-limit check runs before the timeout kill: the abort would leave the gh tree of the hung child alive.
  const r = await run({ old: OLD, status: { 2: { status: null, stdout: '', stderr: 'gh: API rate limit exceeded', timedOut: true, pid: 4242 } } });
  assert.equal(r.code, 10);
  assert.deepEqual(r.calls.kill, [4242]);
  assert.equal(readFileSync(r.outFile, 'utf8'), OLD);
  assert.deepEqual(statusPrs(r), [1, 2], 'PR 3 never starts');
});

test('10 a review-status head that differs from the list head gives head-moved', async () => {
  // Breaks when the status head is trusted without the compare with the list head.
  const r = await run({ status: { 2: okStatus(2, { head: sha(999) }) } });
  assert.equal(r.code, 0);
  assert.equal(rowOf(r, 2).status, 'head-moved');
  assert.equal(rowOf(r, 2).head, sha(2), 'the row keeps the list head');
  assert.equal(rowOf(r, 1).status, 'ok');
});

// ---------------------------------------------------------------- cap and budget (conditions c, Q6, Q5)

test('6 25 open PRs, default cap: 20 full rows, 5 capped rows with list fields only, one capped log line', async () => {
  // Breaks when the cap is removed or is not 20, or a capped row carries band, ready or a tap.
  const store = storeOf([tap('land', `${REPO}#25`, sha(25), '2026-11-13T10:00:00.000Z')]);
  const r = await run({ prs: items(25), store });
  assert.equal(r.code, 0);
  assert.equal(r.doc.rows.length, 25);
  assert.equal(r.doc.listed, 25);
  assert.equal(r.doc.kept, 20);
  assert.equal(r.doc.capped, true);
  assert.deepEqual(statusPrs(r), Array.from({ length: 20 }, (_, k) => k + 1));
  for (let n = 21; n <= 25; n++) {
    const row = rowOf(r, n);
    assert.equal(row.status, 'capped');
    assert.equal(row.band, null);
    assert.equal(row.ready, null);
    assert.equal(row.lastTap, null, 'a stored tap does not reach a capped row');
    assert.equal(row.head, sha(n));
    assert.equal(row.headRef, `feat/p${n}`);
  }
  assert.equal(r.doc.rows.filter((x) => x.status === 'ok').length, 20);
  assert.ok(r.lines.includes('open-prs: capped, listed 25, kept 20'), r.lines.join('\n'));
  assert.ok(r.lines.includes('open-prs: 25 rows, ok 20, capped 5, deadline 0, failed 0'), r.lines.join('\n'));
});

test('6b the cap keeps the newest updated_at, not the lowest numbers; --cap overrides it', async () => {
  // Breaks when the cut is by PR number or by list order instead of newest updated_at first.
  const prs = items(5, (n) => ({ updated_at: new Date(T0 + n * 60_000).toISOString() })); // PR 5 is the newest
  const r = await run({ prs, args: ['--cap', '3'] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.status.map((c) => c.pr).sort((a, b) => a - b), [3, 4, 5]);
  assert.deepEqual(r.doc.rows.filter((x) => x.status === 'capped').map((x) => x.pr), [1, 2]);
  assert.equal(r.doc.kept, 3);
  assert.ok(r.lines.includes('open-prs: capped, listed 5, kept 3'), r.lines.join('\n'));
});

test('6c at or under the cap there is no capped line and capped is false', async () => {
  // Breaks when the capped line or flag is written on every run.
  const r = await run({ prs: items(3) });
  assert.equal(r.doc.capped, false);
  assert.equal(r.doc.kept, 3);
  assert.ok(!r.lines.some((l) => /capped, listed/.test(l)));
});

test('7 the run budget ends after 3 PRs: deadline rows, deadlineHit true, no further runStatus or files call', async () => {
  // Breaks when the budget (420 s, stop below 100 s left) is not checked before each PR. The fake clock moves 150 s per review-status call.
  const r = await run({ prs: items(5), statusStep: 150_000 });
  assert.equal(r.code, 0);
  assert.equal(r.doc.deadlineHit, true);
  assert.deepEqual(statusPrs(r), [1, 2, 3]);
  assert.deepEqual(filesPrs(r), [1, 2, 3]);
  for (const n of [4, 5]) {
    const row = rowOf(r, n);
    assert.equal(row.status, 'deadline');
    assert.equal(row.band, null);
    assert.equal(row.ready, null);
    assert.equal(row.lastTap, null);
  }
  assert.equal(r.doc.rows.filter((x) => x.status === 'ok').length, 3);
  assert.ok(r.lines.includes('open-prs: 5 rows, ok 3, capped 0, deadline 2, failed 0'), r.lines.join('\n'));
  const fast = await run({ prs: items(5) });
  assert.equal(fast.doc.deadlineHit, false);
});

test('pages: a full page of 100 asks for page 2; the list ends on a short page', async () => {
  // Breaks when only the first page is read (a PR beyond the 100th would be missing from listed).
  const r = await run({ prs: items(103), args: ['--cap', '2'] });
  assert.equal(r.code, 0);
  assert.equal(r.doc.listed, 103);
  const pages = r.calls.gh.map((c) => /state=open&per_page=100&page=(\d+)/.exec(c.args.join(' '))?.[1]).filter(Boolean);
  assert.deepEqual(pages, ['1', '2']);
});

test('pages 10: a full tenth page logs one line that the list may be longer; a short list logs none', async () => {
  // Breaks when the 10-page stop is silent: PRs beyond number 1000 would vanish with no trace in the log.
  const full = await run({ prs: items(1000), args: ['--cap', '2'] });
  assert.equal(full.code, 0);
  assert.equal(full.doc.listed, 1000);
  assert.equal(full.lines.filter((l) => /page 10/.test(l)).length, 1, full.lines.join('\n'));
  const short = await run({ prs: items(103), args: ['--cap', '2'] });
  assert.ok(!short.lines.some((l) => /page 10/.test(l)));
});

// ---------------------------------------------------------------- the file: shape, privacy, labels

test('envelope and row shape: fixed key sets, rows sorted by pr, bands from bandOf, gh call shapes', async () => {
  // Breaks when a row is built by spreading a response object (an extra key appears), the sort is dropped, or bandOf is not used.
  const low = bandOf(['docs/note-1.md'], CONFIG, { labels: [] }).band;
  const crit = bandOf(['scripts/github/lib/proc.mjs'], CONFIG, { labels: [] }).band;
  assert.notEqual(low, crit, 'the fixture needs two different bands');
  const prs = [item(3), item(1, { draft: true, labels: [{ name: 'review:coderabbit' }] }), item(2)];
  const r = await run({ prs, files: { 1: ['docs/note-1.md'], 2: ['scripts/github/lib/proc.mjs'], 3: ['docs/note-3.md'] } });
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.doc).sort(), ['capped', 'deadlineHit', 'exportedAt', 'kept', 'landed', 'listed', 'repo', 'rows', 'schema']);
  assert.equal(r.doc.schema, 1);
  assert.equal(r.doc.repo, REPO);
  assert.equal(r.doc.exportedAt, new Date(T0).toISOString());
  assert.equal(r.doc.listed, 3);
  assert.deepEqual(prsOf(r), [1, 2, 3]);
  for (const row of r.doc.rows) assert.deepEqual(Object.keys(row).sort(), ['band', 'ci', 'draft', 'head', 'headRef', 'labels', 'lastTap', 'pr', 'ready', 'status']);
  const one = rowOf(r, 1);
  assert.deepEqual({ headRef: one.headRef, head: one.head, draft: one.draft, labels: one.labels, band: one.band, ready: one.ready, ci: one.ci, lastTap: one.lastTap, status: one.status },
    { headRef: 'feat/p1', head: sha(1), draft: true, labels: ['review:coderabbit'], band: low, ready: true, ci: [], lastTap: null, status: 'ok' });
  assert.equal(rowOf(r, 2).band, crit);
  const list = r.calls.gh[0];
  assert.equal(list.args[0], 'api');
  assert.ok(list.args.some((a) => a === `repos/${REPO}/pulls?state=open&per_page=100&page=1`), list.args.join(' '));
  const files = r.calls.gh.find((c) => /\/files/.test(c.args.join(' ')));
  assert.ok(files.args.includes('--paginate') && files.args.includes('--slurp'), files.args.join(' '));
  assert.ok(files.args.some((a) => a === `repos/${REPO}/pulls/${filesPrs(r)[0]}/files?per_page=100`), files.args.join(' '));
  assert.ok(r.calls.gh.every((c) => c.opts.timeoutMs > 0 && c.opts.timeoutMs <= 30_000), 'each gh call has a limit of at most 30 s');
});

/** Every key at any depth of a parsed JSON value. */
const keysDeep = (v, acc = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); keysDeep(x, acc); }
  return acc;
};

test('8 privacy: no PR title, body, reason text, Greptile summary, proof problem, login, url, check name or tap internals in the file', async () => {
  // Breaks when any response field is copied into a row: the sentinels sit in the list item, the files answer, and the review-status JSON.
  const status = okStatus(2, {
    ready: false,
    reasons: ['check "NAME-SENTINEL" is completed/failure', 'REASON-SENTINEL free text from the PR body'],
    extra: { title: 'TITLE-SENTINEL', body: 'BODY-SENTINEL', greptileSummary: 'GREPTILE-SENTINEL', proof: { problems: ['PROOF-SENTINEL'] }, user: { login: 'USER-SENTINEL' } },
  });
  const store = storeOf([tap('land', `${REPO}#2`, sha(2), '2026-11-13T09:00:00.000Z', 'Land it')]);
  const r = await run({ status: { 2: status }, store });
  assert.equal(r.code, 0);
  assert.deepEqual(rowOf(r, 2).ci.sort(), ['check-failure', 'other']);
  for (const s of ['TITLE-SENTINEL', 'BODY-SENTINEL', 'REASON-SENTINEL', 'NAME-SENTINEL', 'GREPTILE-SENTINEL', 'PROOF-SENTINEL', 'USER-SENTINEL', 'URL-SENTINEL', 'PATCH-SENTINEL', 'TREE-SENTINEL', 'NONCE-SENTINEL']) {
    assert.ok(!r.text.includes(s), `${s} must not be in the file`);
  }
  const keys = keysDeep(r.doc);
  for (const k of ['title', 'body', 'reasons', 'greptileSummary', 'proof', 'problems', 'user', 'login', 'html_url', 'url', 'tree', 'nonce']) assert.ok(!keys.has(k), `key ${k}`);
  assert.ok(!r.text.includes(basename(r.dir)), 'no file path in the file');
});

test('C2 labels: at most 20, each clipped to 50 characters, printable ASCII only', async () => {
  // Breaks when the label list is copied whole, or a non-ASCII or control character reaches the file.
  const many = Array.from({ length: 25 }, (_, k) => ({ name: `l${String(k).padStart(2, '0')}` }));
  const odd = [{ name: 'x'.repeat(80) }, { name: 'café-☃-label' }, { name: 'bell\u0007\nline' }];
  const r = await run({ prs: [item(1, { labels: many }), item(2, { labels: odd })] });
  assert.equal(r.code, 0);
  const a = rowOf(r, 1).labels;
  assert.equal(a.length, 20);
  assert.deepEqual(a.slice(0, 3), ['l00', 'l01', 'l02']);
  const b = rowOf(r, 2).labels;
  assert.ok(b.includes('x'.repeat(50)), `a long label is clipped to 50: ${JSON.stringify(b)}`);
  for (const label of [...a, ...b]) {
    assert.ok(label.length <= 50, label);
    assert.match(label, /^[\x20-\x7e]*$/, JSON.stringify(label));
  }
  assert.ok(!r.text.includes('é') && !r.text.includes('☃') && !r.text.includes('\\u0007'), 'no non-ASCII or control character in the file text');
});

test('C2b a risk:high label still reaches bandOf (the clip is for the file, not for the band)', async () => {
  // Breaks when labels are dropped before bandOf: CRITICAL would read LOW.
  const want = bandOf(['docs/note-1.md'], CONFIG, { labels: ['risk:high'] }).band;
  assert.equal(want, 'CRITICAL');
  const r = await run({ prs: [item(1, { labels: [{ name: 'risk:high' }] })] });
  assert.equal(rowOf(r, 1).band, 'CRITICAL');
});

// ---------------------------------------------------------------- reason mapping (test 9)

const CASES = [
  [['status "ci/x" is failure'], ['status-failure']],
  [['status "ci/x" is error'], ['status-error']],
  [['status "ci/x" is pending'], ['status-pending']],
  [['check "ratchets" is completed/failure'], ['check-failure']],
  [['check "a b" is completed/timed_out'], ['check-timed_out']],
  [['check "a" is in_progress/null'], ['check-in_progress']],
  [['required checks not started on head aaaaaaa: ratchets, hooks. Wait for them'], ['required-not-started']],
  [['required checks missing on head aaaaaaa: ratchets. GitHub may have lost the runs; push a new commit'], ['required-missing']],
  [['required checks ended skipped or neutral on head aaaaaaa: trivy. A required job must end success'], ['required-ended-skipped']],
  [['mergeable_state is "dirty"'], ['mergeable-dirty']],
  [['Greptile has not reviewed this head'], ['other']],
  [['status "x" is FAILURE!'], ['other']], // a state outside [a-z_]
  [['mergeable_state is "has hooks"'], ['other']], // a space is outside [a-z_]
  [['check "x" is completed/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], ['other']], // a state of 30 characters
  [['PR body proof: status "x" is failure'], ['other']], // the text sits mid-line: not a review-status prefix
  [['Unknown one', 'Unknown two'], ['other']], // counted once
  [['status "a" is failure', 'mergeable_state is "dirty"', 'something else'], ['mergeable-dirty', 'other', 'status-failure']],
];
for (const [reasons, want] of CASES) {
  test(`9 reason mapping: ${JSON.stringify(reasons).slice(0, 70)} -> ${want.join(',')}`, async () => {
    // Breaks when the prefix match is loosened (unanchored, state charset or length not checked) or other is not counted once.
    const r = await run({ prs: [item(1)], status: { 1: okStatus(1, { ready: false, reasons }) } });
    assert.equal(r.code, 0);
    assert.deepEqual([...rowOf(r, 1).ci].sort(), [...want].sort());
    for (const reason of reasons) assert.ok(!r.text.includes(reason), 'reason text never reaches the file');
  });
}

// ---------------------------------------------------------------- lock (tests 11, 12)

const iso = (ms) => new Date(ms).toISOString();

test('11 a lock with a live pid and a young start: exit 0, one log line, no gh call, the lock and the old file stay', async () => {
  // Breaks when the lock is ignored (two runs overlap), the skip returns nonzero, or the skipping run removes the other run's lock.
  const content = `${process.pid} ${iso(T0 - 60_000)}`;
  const r = await run({ old: OLD, lock: content });
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ['open-prs: another run holds the lock']);
  assert.deepEqual(r.errs, []);
  assert.equal(r.calls.gh.length, 0);
  assert.equal(readFileSync(r.lock, 'utf8'), content);
  assert.equal(readFileSync(r.outFile, 'utf8'), OLD);
});

test('12 a lock whose pid is dead is taken over; no lock is left after the run', async () => {
  // Breaks when a dead holder blocks every later run (a wrapper kill skips the finally, so this case is real).
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  assert.throws(() => process.kill(dead, 0), 'the pid must be dead');
  const r = await run({ lock: `${dead} ${iso(T0 - 60_000)}` });
  assert.equal(r.code, 0);
  assert.equal(r.doc.rows.length, 3);
  assert.deepEqual(leftovers(r), []);
});

test('12b a live pid does not keep a lock older than 20 minutes: 19 minutes holds, 21 minutes is taken over', async () => {
  // Breaks when the 20-minute rule is missing (a recycled pid would hold the lock for ever) or is shorter than the 10-minute task limit.
  const held = await run({ lock: `${process.pid} ${iso(T0 - 19 * 60_000)}` });
  assert.equal(held.code, 0);
  assert.equal(held.text, null, 'the 19-minute lock holds: nothing is written');
  assert.equal(held.calls.gh.length, 0);
  const taken = await run({ lock: `${process.pid} ${iso(T0 - 21 * 60_000)}` });
  assert.equal(taken.code, 0);
  assert.equal(taken.doc.rows.length, 3);
  assert.deepEqual(leftovers(taken), []);
});

test('12d an empty lock (a run between create and pid write) holds until its mtime is 20 minutes old', async () => {
  // Breaks when an empty or invalid pid counts as dead: a second run would delete a fresh lock and overlap the first.
  const held = await run({ lock: '', lockMtimeMs: T0 - 60_000 });
  assert.equal(held.code, 0);
  assert.equal(held.text, null, 'the fresh empty lock holds: nothing is written');
  assert.equal(held.calls.gh.length, 0);
  const taken = await run({ lock: '', lockMtimeMs: T0 - 21 * 60_000 });
  assert.equal(taken.code, 0);
  assert.equal(taken.doc.rows.length, 3);
  assert.deepEqual(leftovers(taken), []);
});

test('12c a normal run holds the lock while it works and leaves none, and no tmp file', async () => {
  // Breaks when the lock is not created (no overlap guard) or is released only on success.
  const r = await run();
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.lockDuring, [true, true, true]);
  assert.deepEqual(leftovers(r), []);
});

const OTHER = (ms) => `${process.pid} ${iso(ms)} OTHER-OWNER-TOKEN`;

test('12e a lock replaced by another owner during the run is not deleted by this run', async () => {
  // Breaks when the finally block unlinks the lock without checking that the lock text is still this run's token.
  const replaceLock = ({ out }) => writeFileSync(join(out, '.open-prs.lock'), OTHER(T0 - 1000));
  const r = await run({ onStatus: replaceLock });
  assert.equal(r.code, 0);
  assert.equal(r.doc.rows.length, 3);
  assert.equal(readFileSync(r.lock, 'utf8'), OTHER(T0 - 1000));
});

test('12f a stale lock that another run replaces between the stale judgement and the unlink is not deleted', async () => {
  // Breaks when the takeover unlinks with no re-read: it would delete the live lock of the run that just took it.
  const swap = (line, out) => { if (/taking over a stale lock/.test(line)) writeFileSync(join(out, '.open-prs.lock'), OTHER(T0 - 1000)); };
  const r = await run({ lock: `${process.pid} ${iso(T0 - 21 * 60_000)}`, onLine: swap });
  assert.equal(r.code, 0);
  assert.ok(r.lines.includes('open-prs: another run holds the lock'), r.lines.join('\n'));
  assert.equal(r.calls.gh.length, 0);
  assert.equal(readFileSync(r.lock, 'utf8'), OTHER(T0 - 1000));
});

test('12g a lock dated in the future is stale: it is taken over and the run writes the file', async () => {
  // Breaks when a clock jump or a bad date lets a lock with a live pid hold for ever (the 20-minute age test never fires on a negative age).
  const r = await run({ lock: `${process.pid} ${iso(T0 + 3 * 3600_000)}`, lockMtimeMs: T0 - 60_000 });
  assert.equal(r.code, 0);
  assert.equal(r.doc.rows.length, 3);
  assert.ok(r.lines.includes('open-prs: taking over a stale lock'), r.lines.join('\n'));
  assert.deepEqual(leftovers(r), []);
});

test('12h judgeLock: an unreadable lock follows its mtime age; a future date and a young live lock', async () => {
  // Breaks when an unreadable lock (null text) holds for ever, or a lock dated ahead of the clock counts as held.
  const { judgeLock } = await load();
  assert.equal(judgeLock(null, T0 - 21 * 60_000, T0), 'stale', 'unreadable and old');
  assert.equal(judgeLock(null, T0 - 60_000, T0), 'held', 'unreadable and young');
  assert.equal(judgeLock(`${process.pid} ${iso(T0 + 3 * 3600_000)}`, T0, T0), 'stale', 'dated in the future');
  assert.equal(judgeLock(`${process.pid} ${iso(T0 - 60_000)} TOKEN`, T0, T0), 'held', 'young, live pid, with a token');
  assert.equal(judgeLock(`${process.pid} ${iso(T0 - 21 * 60_000)}`, T0, T0), 'stale', 'live pid, 21 minutes old');
});

// ---------------------------------------------------------------- write path (tests 13, 14)

test('13 a rename that throws: old file intact, no tmp file, no lock, one err line, exit 1', async () => {
  // Breaks when the file is written in place (the old file is torn), the tmp file or lock is not cleaned in finally, or the code is not 1.
  const r = await run({ old: OLD, deps: { rename: () => { throw new Error('EPERM: rename blocked'); } } });
  assert.equal(r.code, 1);
  assert.equal(readFileSync(r.outFile, 'utf8'), OLD);
  assert.deepEqual(leftovers(r), []);
  assert.equal(r.errs.length, 1, r.errs.join('\n'));
});

const walk = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  return e.isDirectory() ? [relative(base, p).replace(/\\/g, '/') + '/', ...walk(p, base)] : [`${relative(base, p).replace(/\\/g, '/')}:${statSync(p).size}`];
});

test('14 writes only under --out: the temp home and its folders are unchanged, new files are in --out only', async () => {
  // Breaks when the script writes a cache, a log or a state file next to the store or under the home folder.
  const { main } = await load();
  const dir = mk();
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude', 'state', 'ccv3-mods'), { recursive: true });
  writeFileSync(join(home, '.claude', 'state', 'ccv3-mods', 'keep.txt'), 'keep');
  const before1 = walk(dir);
  const out = join(dir, 'out');
  const prs = items(2);
  const runGh = (args) => (/state=open/.test(args.join(' '))
    ? { status: 0, stdout: JSON.stringify(prs), stderr: '' }
    : { status: 0, stdout: JSON.stringify([[{ filename: 'docs/a.md' }]]), stderr: '' });
  const code = await main(['--out', out], { now: () => new Date(T0), home, runGh, runStatus: (pr) => okStatus(pr), readConfig: () => CONFIG, killTree() {}, log() {}, err() {} });
  assert.equal(code, 0);
  const after1 = walk(dir);
  const added = after1.filter((p) => !before1.includes(p));
  assert.ok(added.length > 0 && added.every((p) => p === 'out/' || p.startsWith('out/')), added.join(', '));
  assert.deepEqual(before1.filter((p) => !after1.includes(p)), [], 'nothing removed or resized');
  assert.deepEqual(walk(out).map((p) => p.split(':')[0]), ['open-prs.json'], 'only the file is left in --out');
});

// ---------------------------------------------------------------- the tap lookup (test 15, Q3)

test('15 tap lookup: newest at wins, an old head gives headMatches false, a branch key counts only for ship and open-pr, rows hold step,label,at,headMatches', async () => {
  // Breaks when the oldest row wins, headMatches is not compared, a branch-key land row counts, another repo's key is read, or tree/nonce leak.
  const b = (n) => `${REPO}@feat/p${n}`;
  const pr = (n) => `${REPO}#${n}`;
  const store = storeOf([
    tap('review', pr(7), sha(7), '2026-11-12T08:00:00.000Z', 'Old'),
    tap('land', pr(7), sha(7), '2026-11-12T09:00:00.000Z', 'New'),
    tap('land', pr(8), sha(800), '2026-11-12T09:00:00.000Z', 'Stale head'),
    tap('ship', b(9), sha(9), '2026-11-12T10:00:00.000Z', 'S'),
    tap('open-pr', b(9), sha(9), '2026-11-12T11:00:00.000Z', 'O'),
    tap('land', b(9), sha(9), '2026-11-12T12:00:00.000Z', 'L'),
    tap('land', b(10), sha(10), '2026-11-12T10:00:00.000Z', 'L'),
    tap('review', b(10), sha(10), '2026-11-12T10:00:00.000Z', 'R'),
    tap('paid-round', b(10), sha(10), '2026-11-12T10:00:00.000Z', 'P'),
    tap('land', 'Other/repo#11', sha(11), '2026-11-12T10:00:00.000Z', 'Elsewhere'),
    tap('land', pr(12), sha(12), '2026-11-12T10:00:00.000Z', 'ByPr'),
    tap('ship', b(12), sha(12), '2026-11-12T11:00:00.000Z', 'ByBranch'),
  ]);
  const r = await run({ prs: items(12).filter((x) => x.number >= 7), store });
  assert.equal(r.code, 0);
  assert.deepEqual(rowOf(r, 7).lastTap, { step: 'land', label: 'New', at: '2026-11-12T09:00:00.000Z', headMatches: true });
  assert.deepEqual(rowOf(r, 8).lastTap, { step: 'land', label: 'Stale head', at: '2026-11-12T09:00:00.000Z', headMatches: false });
  assert.deepEqual(rowOf(r, 9).lastTap, { step: 'open-pr', label: 'O', at: '2026-11-12T11:00:00.000Z', headMatches: true });
  assert.equal(rowOf(r, 10).lastTap, null, 'branch-key rows of land, review and paid-round do not count');
  assert.equal(rowOf(r, 11).lastTap, null, 'another repo');
  assert.deepEqual(rowOf(r, 12).lastTap, { step: 'ship', label: 'ByBranch', at: '2026-11-12T11:00:00.000Z', headMatches: true }, 'newest across both key forms');
  assert.ok(!r.text.includes('TREE-SENTINEL') && !r.text.includes('NONCE-SENTINEL'));
});

test('15b a corrupt store, or a store with a section that is not an object, gives lastTap null for every row and exit 0', async () => {
  // Breaks when a bad store file crashes the run, or its good-looking rows are read from a store the lib would call empty.
  const good = storeOf([tap('land', `${REPO}#1`, sha(1), '2026-11-12T09:00:00.000Z', 'X')]);
  for (const store of ['not json {{{', JSON.stringify({ ...good, offers: [] }), JSON.stringify([1, 2]), '']) {
    const r = await run({ prs: items(2), store });
    assert.equal(r.code, 0, store.slice(0, 20));
    assert.deepEqual(r.doc.rows.map((x) => x.lastTap), [null, null], store.slice(0, 20));
  }
  const ok = await run({ prs: items(2), store: good });
  assert.equal(rowOf(ok, 1).lastTap?.label, 'X', 'a good store is read');
});

// ---------------------------------------------------------------- C1 token masking

test('C1 the logged stderr tail masks ghp_, gho_, ghs_, github_pat_ and Bearer tokens (list failure)', async () => {
  // Breaks when the tail is logged raw: the sentinel tokens would reach the err line or the log.
  const stderr = `gh: HTTP 500 ${TOK.ghp} ${TOK.gho} ${TOK.ghs} ${TOK.pat} Authorization: ${TOK.bearer}`;
  const r = await run({ old: OLD, listFail: { status: 1, stdout: '', stderr } });
  assert.equal(r.code, 10);
  const all = [...r.errs, ...r.lines].join('\n');
  for (const tail of tokenTails) assert.ok(!all.includes(tail), `token tail ${tail} leaked: ${all}`);
  assert.match(r.errs[0], /old file kept/);
});

test('C1b the same masking holds for the tail of a review-status rate-limit abort', async () => {
  // Breaks when only the list-call path is masked.
  const stderr = `review-status: could not determine (gh: API rate limit exceeded for ${TOK.ghp} ${TOK.bearer})\n`;
  const r = await run({ old: OLD, status: { 1: { status: 2, stdout: '', stderr } } });
  assert.equal(r.code, 10);
  const all = [...r.errs, ...r.lines].join('\n');
  for (const tail of tokenTails) assert.ok(!all.includes(tail), `token tail ${tail} leaked: ${all}`);
});

test('C1c a token glued to a word or an underscore is masked too', async () => {
  // Breaks when the token pattern keeps a leading word boundary: x_ghp_... and tokenghp_... would leak.
  const stderr = `gh: HTTP 500 x_${TOK.ghp} token${TOK.pat}`;
  const r = await run({ old: OLD, listFail: { status: 1, stdout: '', stderr } });
  assert.equal(r.code, 10);
  const all = [...r.errs, ...r.lines].join('\n');
  for (const tail of tokenTails) assert.ok(!all.includes(tail), `token tail ${tail} leaked: ${all}`);
});

test('C1d "token <x>" and "Basic <x>" are masked; a 40-hex head sha is not', async () => {
  // Breaks when only the gh token shapes and Bearer are masked (an Authorization: token line would leak), or the mask eats a head sha.
  const stderr = `gh: HTTP 500 Authorization: token Tk7Tk7Tk7Tk7 Basic Qm9Qm9Qm9Qm9 head ${sha(7)} ${TOK.bearer}`;
  const r = await run({ old: OLD, listFail: { status: 1, stdout: '', stderr } });
  assert.equal(r.code, 10);
  assert.ok(r.errs[0].includes(sha(7)), `the sha must survive: ${r.errs[0]}`);
  for (const tail of ['Tk7Tk7', 'Qm9Qm9', ...tokenTails]) assert.ok(!r.errs[0].includes(tail), `leaked ${tail}: ${r.errs[0]}`);
  assert.ok(r.errs[0].includes(`gh: HTTP 500 Authorization: token <token> Basic <token> head ${sha(7)} Bearer <token>)`), `exact masked line: ${r.errs[0]}`);
});

test('C1e plain words after "token" or "Basic" stay readable: only a value-shaped word is masked', async () => {
  // Breaks when the token/Basic rule masks any next word: the log would lose its reason text.
  const stderr = 'gh: HTTP 403 personal access token (HTTP 403) lacks scope; Basic auth is off';
  const r = await run({ old: OLD, listFail: { status: 1, stdout: '', stderr } });
  assert.equal(r.code, 10);
  assert.ok(r.errs[0].includes('personal access token (HTTP 403) lacks scope; Basic auth is off'), `reason text lost: ${r.errs[0]}`);
});

// ---------------------------------------------------------------- runChild: the real review-status timer and pid hand-off

const gone = async (pid, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

test('18 runChild: a hung child gives timedOut and its pid at the timer; killTree then removes it', async () => {
  // Breaks when the timer does not fire, the pid is not handed back, or the child is spawned so that killTree cannot reach it.
  const { runChild } = await load();
  const { killTree } = await import('./lib/proc.mjs');
  const res = await runChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 300);
  try {
    assert.equal(res.timedOut, true);
    assert.equal(res.status, null);
    assert.ok(Number.isInteger(res.pid) && res.pid > 0, `pid ${res.pid}`);
    assert.doesNotThrow(() => process.kill(res.pid, 0), 'the child is still alive at the timer');
    killTree(res.pid);
    assert.ok(await gone(res.pid, 30_000), 'killTree must remove the child');
  } finally {
    try { process.kill(res.pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

test('18b runChild: a child that exits in time returns its code and output with no timedOut', async () => {
  // Breaks when the exit path drops stdout, stderr or the code, or the timer still marks the run as timed out.
  const { runChild } = await load();
  const res = await runChild(process.execPath, ['-e', "console.log('out-line'); console.error('err-line'); process.exit(3)"], 20_000);
  assert.equal(res.status, 3);
  assert.match(res.stdout, /out-line/);
  assert.match(res.stderr, /err-line/);
  assert.notEqual(res.timedOut, true);
});

// ---------------------------------------------------------------- Q1 import probe, test 16 static guard, Q3 header

const CHILD = `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const calls = [];
for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[k] = (...a) => { calls.push(k + ':' + String(a[0])); throw new Error('blocked ' + k); };
syncBuiltinESMExports();
const m = await import(process.argv[2]);
console.log(JSON.stringify({ calls, hasMain: typeof m.main }));
`;

test('Q1 importing open-prs.mjs starts no child process and no gh call, and runs no main', () => {
  // Breaks when the module runs main() or any spawn at import time (a missing isMain guard, or a top-level gh read).
  const dir = mk();
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, CHILD);
  const r = spawnSync(process.execPath, [probe, pathToFileURL(SRC).href], { encoding: 'utf8', windowsHide: true, timeout: 60_000, cwd: dir, env: { ...process.env, CCV3_DECISIONS_FILE: join(dir, 'none.json') } });
  assert.equal(r.status, 0, `import failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.deepEqual(out.calls, [], 'no child process at import');
  assert.equal(out.hasMain, 'function', 'main is exported');
  assert.equal(r.stdout.trim().split('\n').length, 1, 'import prints nothing');
});

test('16 static guard: no import of review-status.mjs, only { bandOf } from review-router.mjs, no land lock', () => {
  // Breaks when the script imports review-status (it must run as a child), imports more than bandOf, or touches the land lock or mutex.
  const src = readFileSync(SRC, 'utf8');
  const specs = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(specs.length > 0, 'the source has imports');
  assert.deepEqual(specs.filter((s) => /review-status/.test(s)), [], 'no review-status import');
  const router = [...src.matchAll(/import\s*([^;]*?)\s*from\s*['"]([^'"]*review-router[^'"]*)['"]/g)];
  assert.equal(router.length, 1, 'exactly one import of review-router');
  assert.match(router[0][1], /^\{\s*bandOf\s*\}$/);
  assert.deepEqual(specs.filter((s) => /review-router/.test(s)), [router[0][2]], 'no dynamic or second import of review-router');
  assert.doesNotMatch(src, /land\.lock/);
  assert.doesNotMatch(src, /ccv3-land-lock/i);
  assert.match(src, /review-status\.mjs/, 'review-status is still run as a child');
});

test('Q3 the header says lastTap is a pending or unused tap', () => {
  // Breaks when the file header drops the meaning of lastTap (a used tap is deleted from the store, so null is common).
  const head = readFileSync(SRC, 'utf8').split('\n').slice(0, 40).join('\n');
  assert.match(head, /pending or unused tap/i);
});

// ---------------------------------------------------------------- 17 contract with the real review-status

test('17 contract: the real review-status (--fixture, no network) with one failed check gives check-failure and a fixed code set', async () => {
  // Breaks when review-status changes its reason text (the mod keys on it too) or our parser stops reading the real output.
  const dir = mk();
  const head = sha(111);
  const fixture = {
    pull: { number: 111, state: 'open', merged: false, mergeable_state: 'dirty', body: 'BODY-SENTINEL', head: { sha: head, ref: 'feat/p111' }, base: { ref: 'main' }, labels: [{ name: 'risk:normal' }] },
    combined: { statuses: [{ context: 'ctx1', state: 'failure' }] },
    checkRuns: [
      { id: 200, name: 'NAME-SENTINEL', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'failure', started_at: '2026-11-13T00:31:00Z' },
      { id: 201, name: 'other-check', app: { slug: 'github-actions' }, status: 'in_progress', conclusion: null, started_at: '2026-11-13T00:31:00Z' },
    ],
    threads: [],
    bodyEdits: [],
  };
  const file = join(dir, 'in.json');
  writeFileSync(file, JSON.stringify(fixture));
  const real = spawnSync(process.execPath, [REVIEW_STATUS, '--fixture', file, '--json'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(real.status, 1, real.stdout + real.stderr);
  const r = await run({ prs: [item(111, { head: { ref: 'feat/p111', sha: head } })], status: { 111: { status: real.status, stdout: real.stdout, stderr: real.stderr } } });
  assert.equal(r.code, 0);
  const row = rowOf(r, 111);
  assert.equal(row.status, 'ok');
  assert.equal(row.ready, false);
  assert.deepEqual([...row.ci].sort(), ['check-failure', 'check-in_progress', 'mergeable-dirty', 'other', 'required-missing', 'status-failure']);
  for (const code of row.ci) assert.match(code, /^(?:(?:status|check|mergeable)-[a-z_]{1,20}|required-(?:not-started|missing|ended-skipped)|other)$/);
  assert.ok(!r.text.includes('NAME-SENTINEL') && !r.text.includes('BODY-SENTINEL'));
});

// ---------------------------------------------------------------- wiring (done-when)

test('wiring: package.json test:scripts and the ccv3-checks workflow name the new tests', () => {
  // Breaks when either test file is left out of npm run test:scripts, or the CI step for the script test is missing.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:scripts'], /scripts\/github\/open-prs\.test\.mjs/);
  assert.match(pkg.scripts['test:scripts'], /scripts\/scheduled\/scheduled-open-prs\.test\.mjs/);
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'ccv3-checks.yml'), 'utf8');
  assert.match(yml, /- name: open-prs unit tests\r?\n\s+timeout-minutes: 5\r?\n\s+run: node --test scripts\/github\/open-prs\.test\.mjs/);
});

// ---------------------------------------------------------------- the landed list (card agentic-os-feeds-truth, C3)

const closedItem = (n, mergedAt, over = {}) => ({ number: n, state: 'closed', merged_at: mergedAt, merge_commit_sha: sha(n), title: 'TITLE-SENTINEL', user: { login: 'LOGIN-SENTINEL' }, ...over });
const LANDED_KEYS = ['mergedAt', 'pr', 'sha'];

test('L1 the landed list comes from one closed-PR call: merged only, newest 3 by merge time, not by PR number', async () => {
  // Breaks when the list is sorted by PR number (711 would lead), a closed-unmerged PR is kept, or more than 3 rows are written.
  const closed = [
    closedItem(711, '2026-11-24T01:04:16Z'), closedItem(710, '2026-11-24T01:06:58Z'), closedItem(709, '2026-11-24T01:05:00Z'),
    closedItem(708, null), closedItem(707, '2026-11-23T20:00:00Z'),
  ];
  const r = await run({ closed });
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.doc.landed).sort(), ['rows', 'source']);
  assert.equal(r.doc.landed.source, 'github');
  assert.deepEqual(r.doc.landed.rows.map((x) => x.pr), [710, 709, 711]);
  assert.deepEqual(r.doc.landed.rows[0], { pr: 710, mergedAt: '2026-11-24T01:06:58.000Z', sha: sha(710) });
  for (const row of r.doc.landed.rows) assert.deepEqual(Object.keys(row).sort(), LANDED_KEYS);
  const call = r.calls.gh.find((c) => /state=closed/.test(c.args.join(' ')));
  assert.ok(call.args.includes(`repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=15`), call.args.join(' '));
  assert.ok(call.opts.timeoutMs > 0 && call.opts.timeoutMs <= 30_000);
});

test('L1b the landed rows hold no title, login or url, and the call is made once per run, after the open list', async () => {
  // Breaks when a row is spread from the response, or the closed call runs a second time.
  const r = await run({ closed: [closedItem(710, '2026-11-24T01:06:58Z')] });
  assert.ok(!r.text.includes('TITLE-SENTINEL') && !r.text.includes('LOGIN-SENTINEL'));
  const closedCalls = r.calls.gh.filter((c) => /state=closed/.test(c.args.join(' ')));
  assert.equal(closedCalls.length, 1);
  const order = r.calls.gh.map((c) => c.args.join(' '));
  assert.ok(order.findIndex((l) => /state=open/.test(l)) < order.findIndex((l) => /state=closed/.test(l)));
});

test('L2 a closed call that fails does not abort the run: the landed list falls back to the land ledger and says so', async () => {
  // Breaks when the failure aborts (exit 10), the fallback is not marked, or a row of another repo or a bad time is used.
  const ledger = [
    { schema: 1, ts: '2026-11-24T01:04:16.000Z', pr: 711, repo: REPO, mergeSha: sha(711), mergeCall: 'ok' },
    { schema: 1, ts: '2026-11-24T01:06:58.000Z', pr: 710, repo: REPO, mergeSha: sha(710), mergeCall: 'ok' },
    { schema: 1, ts: '2026-11-24T01:05:00.000Z', pr: 709, repo: REPO, mergeSha: null, mergeCall: 'merged-elsewhere' },
    { schema: 1, ts: '2026-11-24T02:00:00.000Z', pr: 5, repo: 'someone/else', mergeSha: sha(5), mergeCall: 'ok' },
    { schema: 1, ts: 'soon', pr: 6, repo: REPO, mergeSha: sha(6), mergeCall: 'ok' },
    'not json',
  ];
  const r = await run({ closedFail: { status: 1, stdout: '', stderr: 'HTTP 502' }, ledger });
  assert.equal(r.code, 0);
  assert.equal(r.doc.landed.source, 'ledger');
  assert.deepEqual(r.doc.landed.rows, [
    { pr: 710, mergedAt: '2026-11-24T01:06:58.000Z', sha: sha(710) },
    { pr: 709, mergedAt: '2026-11-24T01:05:00.000Z', sha: null },
    { pr: 711, mergedAt: '2026-11-24T01:04:16.000Z', sha: sha(711) },
  ]);
});

test('L3 a rate-limit answer on the closed call is not an abort; with no ledger the list is empty and the source is none', async () => {
  // Breaks when the closed call goes through the abort rule (exit 10, old file kept) or a missing ledger throws.
  const r = await run({ closedFail: { status: 1, stdout: '', stderr: 'API rate limit exceeded for user' } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.doc.landed, { source: 'none', rows: [] });
  assert.equal(r.doc.rows.length, 3, 'the open rows are still written');
});

test('L4 an answer that is not an array falls back the same way', async () => {
  // Breaks when a non-array answer is read as rows.
  const r = await run({ closed: { message: 'Not Found' }, ledger: [{ schema: 1, ts: '2026-11-24T01:06:58.000Z', pr: 710, repo: REPO, mergeSha: sha(710), mergeCall: 'ok' }] });
  assert.equal(r.code, 0);
  assert.equal(r.doc.landed.source, 'ledger');
  assert.deepEqual(r.doc.landed.rows.map((x) => x.pr), [710]);
});
