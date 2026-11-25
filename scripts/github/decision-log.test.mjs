// Tests for the append-only decision log of lib/decisions.mjs (card decision-append-log, design note 01-design-note.md).
// Run: node --test scripts/github/decision-log.test.mjs
// Every test points CCV3_DECISIONS_FILE at a temp folder. The log path follows the store folder, so the live log under ~/.claude/state is never written.
//
// How the unit can fail, and the test that catches it:
//   the default log path ignores the store folder (a test or a probe then writes the LIVE log)                      -> AL0
//   a matched tap writes no line, or a line misses a field, or a field holds the wrong value                         -> AL1
//   a tap that matched nothing (no offer, no label match, closed offer) still writes a line                          -> AL2
//   a consume, a new offer, a drop or a second tap rewrites or removes an earlier line                               -> AL3
//   the line time differs from the tap time of the stored decision (the two cannot be joined)                        -> AL4
//   a failed append blocks the tap, or is not reported (fail open and say so)                                        -> AL5
//   a torn last line (no LF) swallows the next line                                                                   -> AL6
//   the reader throws or stops at a corrupt, non-object or newer-version line, or hides how many it skipped         -> AL7
//   a full log is truncated, deleted or compressed, or the reader loses a line across a rotation                      -> AL8
//   the head keeps its case, or repo, pr and branch parse wrong from a PR key, a branch key or a pick key            -> AL9
//   the session or lane argument is trusted as given (a wrong type, an over-long list or string reaches the line)    -> AL10
//   the merge sha join takes a row it must not (another head, merged-elsewhere) or misses one it must take           -> AL11
//   a line carries the question text, the option text or any field outside the design list                          -> AL12
//   the CLI prints nothing useful, hides the skipped count, or exits non-zero for a missing log                      -> AL13
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, 'lib', 'decisions.mjs');
const CLI = path.join(HERE, 'decision-log.mjs');
const load = () => import(pathToFileURL(MODULE).href);

const REPO = 'Rev4nchist/Continuous-Claude-v3';
const HEAD = 'a'.repeat(40);
const KEY = `${REPO}#714`;
const OPTIONS = [{ label: 'Land now (Recommended)', description: 'Runs land-pr.ps1.' }, { label: 'Keep open', description: 'Nothing runs.' }];
const spec = () => ({ header: 'Land', question: 'Land it?', options: OPTIONS });
const triple = (over = {}) => ({ step: 'land', key: KEY, head: HEAD, ...over });

/** A fresh temp folder; the store and the log live in it. Both env overrides that could point elsewhere are cleared. */
function fresh() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'decision-log-'));
  process.env.CCV3_DECISIONS_FILE = path.join(dir, 'decisions.json');
  delete process.env.CCV3_DECISION_LOG_FILE;
  delete process.env.CCV3_DECISION_LOG_MAX_BYTES;
  return { dir, log: path.join(dir, 'decision-log.jsonl') };
}
const offer = (d, over = {}) => d.offerWrite({ ...triple(over), spec: spec(), tree: 't'.repeat(40), cwd: '/x' });
const tap = (d, over = {}, extra = {}) => d.decisionRecord({ ...triple(over), label: 'Land now (Recommended)', entry: 'cli', ...extra });
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l !== '') : []);
const rows = (file) => lines(file).map((l) => JSON.parse(l));

test('AL0: the default log path is beside the store file; an env var overrides it', async () => {
  const { dir } = fresh();
  const d = await load();
  assert.equal(d.decisionLogPath(), path.join(dir, 'decision-log.jsonl'), 'beside the store, so a temp store means a temp log');
  assert.equal(d.decisionLogPath({ CCV3_DECISION_LOG_FILE: path.join(dir, 'other.jsonl'), CCV3_DECISIONS_FILE: path.join(dir, 'decisions.json') }), path.join(dir, 'other.jsonl'));
  assert.equal(d.DECISION_LOG_ENV, 'CCV3_DECISION_LOG_FILE');
});

test('AL1: a matched tap appends exactly one line with every field of the design', async () => {
  const { log } = fresh();
  const d = await load();
  assert.equal(offer(d).ok, true);
  const r = tap(d, {}, { audit: { session: '72de71 Status band', lane: ['decision-append-log'] } });
  assert.deepEqual(r, { ok: true }, 'a good append leaves the old result shape');
  const [line, ...more] = rows(log);
  assert.equal(more.length, 0, 'one line');
  assert.equal(line.v, 1);
  assert.equal(line.kind, 'tap');
  assert.match(line.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(!Number.isNaN(Date.parse(line.at)));
  assert.equal(line.step, 'land');
  assert.equal(line.key, KEY);
  assert.equal(line.repo, REPO);
  assert.equal(line.pr, 714);
  assert.equal(line.branch, null);
  assert.equal(line.head, HEAD);
  assert.equal(line.label, 'Land now (Recommended)');
  assert.equal(line.entry, 'cli');
  assert.equal(line.session, '72de71 Status band');
  assert.deepEqual(line.lane, ['decision-append-log']);
  assert.equal(line.tree, 't'.repeat(40));
});

test('AL2: a call that records nothing appends no line', async () => {
  const { log } = fresh();
  const d = await load();
  assert.equal(tap(d).ok, false, 'no offer at all');
  offer(d);
  assert.equal(d.decisionRecord({ ...triple(), label: 'land now (Recommended)' }).ok, false, 'a label that is not exact');
  assert.equal(d.decisionRecord({ ...triple({ head: 'b'.repeat(40) }), label: 'Keep open' }).ok, false, 'another head');
  assert.equal(lines(log).length, 0, 'no line for a miss');
  assert.equal(tap(d).ok, true);
  assert.equal(tap(d).ok, false, 'the offer is closed after the tap');
  assert.equal(lines(log).length, 1, 'still one line');
});

test('AL3: a use, a new offer, a drop and a second tap leave every earlier line in place byte for byte', async () => {
  const { log } = fresh();
  const d = await load();
  offer(d);
  tap(d);
  const first = readFileSync(log, 'utf8');
  assert.equal(d.decisionUse(triple()).ok, true, 'the tap is used up');
  assert.equal(readFileSync(log, 'utf8'), first, 'a use leaves the log alone');
  offer(d);
  assert.equal(readFileSync(log, 'utf8'), first, 'a new offer leaves the log alone');
  tap(d);
  assert.equal(d.dropKey({ steps: ['land'], key: KEY }).ok, true, 'a drop of the key');
  const after = readFileSync(log, 'utf8');
  assert.ok(after.startsWith(first), 'the first line is still the first bytes');
  assert.equal(lines(log).length, 2, 'the second tap is a second line');
  offer(d);
  tap(d);
  assert.ok(readFileSync(log, 'utf8').startsWith(after), 'a third tap of the same triple only appends');
  assert.equal(lines(log).length, 3);
});

test('AL4: the line time equals the tap time of the stored decision', async () => {
  const { log } = fresh();
  const d = await load();
  offer(d);
  tap(d);
  const stored = d.decisionRowRead(triple());
  assert.equal(rows(log)[0].at, stored.tapAt, 'one clock read for both, so a reader can join the two');
});

test('AL5: a failed append still records the tap and says so', async () => {
  const { dir, log } = fresh();
  mkdirSync(log); // a folder where the log file goes: the append cannot work
  const d = await load();
  offer(d);
  const r = tap(d);
  assert.equal(r.ok, true, 'fail open: the tap records');
  assert.equal(r.log?.ok, false);
  assert.equal(typeof r.log?.reason, 'string');
  assert.equal(d.decisionRead(triple()).label, 'Land now (Recommended)', 'the decision row is in the store');
  assert.ok(existsSync(path.join(dir, 'decisions.json')));
});

test('AL6: a torn last line (no LF) does not swallow the next line', async () => {
  const { log } = fresh();
  writeFileSync(log, '{"v":1,"kind":"tap","id":"cut-sho');
  const d = await load();
  offer(d);
  tap(d);
  const text = readFileSync(log, 'utf8');
  assert.ok(text.endsWith('\n'));
  const got = d.decisionLogRead({ file: log });
  assert.equal(got.rows.length, 1, 'the new line parses alone');
  assert.equal(got.skipped, 1, 'the torn line is counted, not rewritten');
  assert.ok(text.startsWith('{"v":1,"kind":"tap","id":"cut-sho\n'), 'the torn bytes are untouched');
});

test('AL7: the reader skips and counts what it cannot use, never throws, tells a missing file from an empty one', async () => {
  const { log } = fresh();
  const d = await load();
  const missing = d.decisionLogRead({ file: log });
  assert.deepEqual({ exists: missing.exists, rows: missing.rows, skipped: missing.skipped }, { exists: false, rows: [], skipped: 0 });
  const good = JSON.stringify({ v: 1, kind: 'tap', id: 'x', at: '2026-11-24T21:00:00.000Z', step: 'land', key: KEY, repo: REPO, pr: 714, branch: null, head: HEAD, label: 'Land now (Recommended)' });
  writeFileSync(log, ['not json', '[1,2]', '"text"', 'null', JSON.stringify({ v: 2, kind: 'tap' }), JSON.stringify({ v: 1 }), '', good, ''].join('\n'));
  const got = d.decisionLogRead({ file: log });
  assert.equal(got.exists, true);
  assert.equal(got.rows.length, 1);
  assert.equal(got.skipped, 6, 'bad json, array, string, null, newer version and no kind are counted; a blank line is not a line');
});

test('AL8: a full log is renamed to a dated archive, never cut, and the reader returns every line in order', async () => {
  const { dir, log } = fresh();
  process.env.CCV3_DECISION_LOG_MAX_BYTES = '900';
  const d = await load();
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    const head = String(i).repeat(40);
    offer(d, { head });
    assert.equal(tap(d, { head }).ok, true);
    seen.push(head);
  }
  const archives = readdirSync(dir).filter((f) => /^decision-log\.\d{8}T\d{6}Z(-\d+)?\.jsonl$/.test(f));
  assert.ok(archives.length >= 1, 'at least one archive');
  const all = d.decisionLogRead({ file: log });
  assert.deepEqual(all.rows.map((r) => r.head), seen, 'every tap, in order, across the archives and the current file');
  assert.equal(all.skipped, 0);
  const joined = [...archives.sort(), 'decision-log.jsonl'].map((f) => readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.equal(joined.split('\n').filter(Boolean).length, 6, 'no byte lost: six lines in all the files');
  assert.ok(readFileSync(path.join(dir, archives.sort()[0]), 'utf8').includes(`"head":"${seen[0]}"`), 'the oldest line sits whole in the oldest archive');
});

test('AL9: the head is stored in lower case; repo, pr and branch parse from the three key forms', async () => {
  const { log } = fresh();
  const d = await load();
  const cases = [
    { key: `${REPO}#12`, want: { repo: REPO, pr: 12, branch: null } },
    { key: `${REPO}@feat/x@y`, want: { repo: REPO, pr: null, branch: 'feat/x@y' } },
    { key: `${REPO}#12!pick:coderabbit`, want: { repo: REPO, pr: 12, branch: null } },
  ];
  for (const [i, c] of cases.entries()) {
    const head = `ABCDEF${i}`.padEnd(40, 'F');
    offer(d, { key: c.key, head });
    assert.equal(tap(d, { key: c.key, head }).ok, true, c.key);
  }
  const got = rows(log);
  for (const [i, c] of cases.entries()) {
    assert.deepEqual({ repo: got[i].repo, pr: got[i].pr, branch: got[i].branch }, c.want, c.key);
    assert.equal(got[i].head, got[i].head.toLowerCase());
    assert.equal(got[i].key, c.key, 'the key is kept whole');
  }
});

test('AL10: a bad session or lane argument becomes null; an over-long one is cut', async () => {
  const { log } = fresh();
  const d = await load();
  const heads = ['1', '2', '3', '4'].map((c) => c.repeat(40));
  const audits = [
    { session: 42, lane: 'not-a-list' },
    { session: 'x'.repeat(500), lane: Array.from({ length: 9 }, (_, i) => `lane-${i}`) },
    { session: 'ok name', lane: [1, null, 'good'] },
    undefined,
  ];
  for (const [i, audit] of audits.entries()) {
    offer(d, { head: heads[i] });
    assert.equal(tap(d, { head: heads[i] }, { audit }).ok, true);
  }
  const got = rows(log);
  assert.deepEqual([got[0].session, got[0].lane], [null, null]);
  assert.ok(got[1].session.length <= 80, 'the session text is cut');
  assert.equal(got[1].lane.length, 5, 'at most 5 lanes');
  assert.deepEqual([got[2].session, got[2].lane], ['ok name', ['good']], 'only text lane ids stay');
  assert.deepEqual([got[3].session, got[3].lane], [null, null], 'no audit argument');
});

test('AL11: the merge sha is joined on read from the land ledger, for the same repo, PR and head, for a real merge only', async () => {
  const { dir, log } = fresh();
  const d = await load();
  const ledger = path.join(dir, 'land-outcomes.jsonl');
  const heads = ['1', '2', '3', '4'].map((c) => c.repeat(40));
  for (const [i, head] of heads.entries()) {
    offer(d, { head, key: `${REPO}#${700 + i}` });
    tap(d, { head, key: `${REPO}#${700 + i}` });
  }
  const mk = (pr, headSha, mergeSha, mergeCall) => JSON.stringify({ schema: 1, ts: '2026-11-24T21:48:46.632Z', pr, repo: REPO, headSha, mergeSha, mergeCall });
  writeFileSync(ledger, [
    mk(700, heads[0].toUpperCase(), 'c'.repeat(40), 'ok'),
    mk(701, heads[1], 'd'.repeat(40), 'merged-elsewhere'),
    mk(702, 'f'.repeat(40), 'e'.repeat(40), 'ok'),
    'torn line',
    mk(703, heads[3], '9'.repeat(40), 'failed-but-merged'),
  ].join('\n') + '\n');
  const joined = d.decisionLogJoin(d.decisionLogRead({ file: log }).rows, { ledger });
  assert.deepEqual(joined.map((r) => r.mergeSha), ['c'.repeat(40), null, null, '9'.repeat(40)]);
  assert.equal(readFileSync(log, 'utf8').includes('mergeSha'), false, 'the join never writes into the log');
  assert.deepEqual(d.decisionLogJoin(joined.slice(0, 1), { ledger: path.join(dir, 'missing.jsonl') })[0].mergeSha, null, 'no ledger, no sha, no throw');
});

test('AL12: a line holds only the designed fields; no question text, option text or free text', async () => {
  const { log } = fresh();
  const d = await load();
  offer(d);
  tap(d, {}, { audit: { session: 's', lane: ['l'] } });
  const keys = Object.keys(rows(log)[0]).sort();
  assert.deepEqual(keys, ['at', 'branch', 'entry', 'head', 'id', 'key', 'kind', 'label', 'lane', 'pr', 'repo', 'session', 'step', 'tree', 'v']);
  assert.equal(readFileSync(log, 'utf8').includes('Land it?'), false, 'the question text is not in the log');
  assert.equal(readFileSync(log, 'utf8').includes('Runs land-pr.ps1.'), false, 'the option description is not in the log');
});

test('AL13: the CLI shows a PR with its merge sha, counts skipped lines, and a missing log is not an error', async () => {
  const { dir, log } = fresh();
  const d = await load();
  offer(d);
  tap(d);
  appendTorn(log);
  const ledger = path.join(dir, 'land-outcomes.jsonl');
  writeFileSync(ledger, `${JSON.stringify({ pr: 714, repo: REPO, headSha: HEAD, mergeSha: 'b'.repeat(40), mergeCall: 'ok' })}\n`);
  const run = (...args) => spawnSync(process.execPath, [CLI, 'show', ...args], { encoding: 'utf8', env: { ...process.env, CCV3_DECISIONS_FILE: path.join(dir, 'decisions.json') } });
  const ok = run('--pr', '714', '--file', log, '--ledger', ledger);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Land now \(Recommended\)/);
  assert.match(ok.stdout, new RegExp('b'.repeat(40)));
  assert.match(ok.stdout, /skipped 1/i);
  const none = run('--pr', '999', '--file', path.join(dir, 'nothing.jsonl'));
  assert.equal(none.status, 0);
  assert.match(none.stdout, /no decision log/i);
  assert.equal(run('--file', log).status, 2, 'usage error without --pr');
  const json = run('--pr', '714', '--file', log, '--ledger', ledger, '--json');
  assert.equal(JSON.parse(json.stdout).rows[0].mergeSha, 'b'.repeat(40));
});

test('AL14: a log file that cannot be read is listed as unreadable, not reported as a missing log', async () => {
  const { log } = fresh();
  mkdirSync(log); // a folder where the log goes: it exists, and it cannot be read as a file
  const d = await load();
  const got = d.decisionLogRead({ file: log });
  assert.equal(got.exists, true, 'something is there');
  assert.deepEqual(got.unreadable, [log]);
  assert.deepEqual(got.rows, []);
  const none = d.decisionLogRead({ file: path.join(path.dirname(log), 'nothing.jsonl') });
  assert.deepEqual([none.exists, none.unreadable], [false, []], 'a missing file is not unreadable');
});

test('AL15: a tap row with no text step or label is skipped and counted, like any bad line', async () => {
  const { log } = fresh();
  const d = await load();
  const good = { v: 1, kind: 'tap', id: 'g', at: '2026-11-24T21:00:00.000Z', step: 'land', key: KEY, repo: REPO, pr: 714, branch: null, head: HEAD, label: 'Land now (Recommended)' };
  writeFileSync(log, [{ v: 1, kind: 'tap', pr: 714, repo: REPO }, { ...good, label: 7 }, { ...good, step: null }, good].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const got = d.decisionLogRead({ file: log });
  assert.equal(got.rows.length, 1);
  assert.equal(got.skipped, 3);
});

test('AL16: the CLI survives a bad tap row and an unreadable log, and says which', async () => {
  const { dir, log } = fresh();
  const good = { v: 1, kind: 'tap', id: 'g', at: '2026-11-24T21:00:00.000Z', step: 'land', key: KEY, repo: REPO, pr: 714, branch: null, head: HEAD, label: 'Land now (Recommended)', entry: 'cli', session: null, lane: null };
  writeFileSync(log, `${JSON.stringify({ v: 1, kind: 'tap', pr: 714, repo: REPO })}\n${JSON.stringify(good)}\n`);
  const run = (...args) => spawnSync(process.execPath, [CLI, 'show', ...args], { encoding: 'utf8', env: { ...process.env, CCV3_DECISIONS_FILE: path.join(dir, 'decisions.json') } });
  const bad = run('--pr', '714', '--file', log);
  assert.equal(bad.status, 0, bad.stderr);
  assert.match(bad.stdout, /Land now \(Recommended\)/);
  assert.match(bad.stdout, /skipped 1/i);
  const folder = path.join(dir, 'a-folder.jsonl');
  mkdirSync(folder);
  const unreadable = run('--pr', '714', '--file', folder);
  assert.equal(unreadable.status, 0);
  assert.match(unreadable.stdout, /unreadable/i);
  assert.doesNotMatch(unreadable.stdout, /no decision log/i);
  assert.equal(JSON.parse(run('--pr', '714', '--file', folder, '--json').stdout).unreadable.length, 1);
});

test('AL17: an option with no operand is a usage error (exit 2), never a fall back to the default log; a valid explicit path still works', async () => {
  const { dir, log } = fresh();
  const d = await load();
  offer(d);
  tap(d);
  const ledger = path.join(dir, 'land-outcomes.jsonl');
  const run = (...args) => spawnSync(process.execPath, [CLI, 'show', ...args], { encoding: 'utf8', env: { ...process.env, CCV3_DECISIONS_FILE: path.join(dir, 'decisions.json') } });
  const bad = [
    ['--pr', '714', '--file'],
    ['--pr', '714', '--file', '--json'],
    ['--pr'],
    ['--pr', '--file', log],
    ['--pr', '714', '--repo'],
    ['--pr', '714', '--repo', '--json'],
    ['--pr', '714', '--ledger'],
    ['--pr', '714', '--file', log, '--ledger', '--json'],
  ];
  for (const args of bad) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')} -> exit ${r.status}: ${r.stdout}`);
    assert.match(r.stderr, /usage/i, args.join(' '));
  }
  const good = run('--pr', '714', '--file', log, '--ledger', ledger);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /Land now \(Recommended\)/, 'a valid explicit path is still read');
});

function appendTorn(file) { writeFileSync(file, `${readFileSync(file, 'utf8')}{"v":1,"kind":"tap","id":"cut`); }
