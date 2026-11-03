// Tests for scripts/github/ledger-report.mjs. Every test names the source change that would break it.
// Run: node --test scripts/github/ledger-report.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { analyze, formatReport, main, parseArgs, percentile } from './ledger-report.mjs';

const made = [];
const tmpDir = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ledger-report-test-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const T0 = Date.parse('2026-11-03T18:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

/** start + end lines of one run that ran from minute `from` to minute `to` after T0. */
function run(id, from, to, over = {}, end = {}) {
  return [
    { ts: iso(T0 + from * MIN), phase: 'start', id, ref: `ref-${id}`, model: 'grok-4.7-high', band: 'MID', ...over },
    { ts: iso(T0 + to * MIN), phase: 'end', id, ref: `ref-${id}`, durationMs: (to - from) * MIN, exit: 0, timedOut: false, usage: { outputTokens: (to - from) * 60 * 50 }, ...end },
  ];
}
const SINCE = T0;
const bucket = (a, c) => a.buckets.find((b) => b.concurrency === c);
const META = { since: iso(SINCE), ledger: 'f.jsonl', damaged: 0 };

// Breaks if overlap is counted wrongly: runs that only touch must stay at 1, three that share a minute must reach 3,
// and a run that starts alone but is joined later must still be filed under the peak it saw.
test('each run is filed under the most runs that were active at once during it', () => {
  const entries = [
    ...run('solo', 0, 10),
    ...run('touch', 10, 20),
    ...run('a', 30, 60), ...run('b', 40, 50), ...run('c', 45, 70),
  ];
  const a = analyze(entries, { sinceMs: SINCE });
  assert.equal(bucket(a, 1).runs, 2, 'solo and touch');
  assert.equal(bucket(a, 2).runs, 0);
  assert.equal(bucket(a, 3).runs, 3, 'a, b and c all saw 3 at minute 45 to 50');
});

// Breaks if the since filter looks at end times, or if runs from before it stop counting as company for a run after it.
test('only runs that started since the cutoff are reported, but an older run still running counts as company', () => {
  const entries = [...run('old-long', -30, 15), ...run('new', 5, 25), ...run('older-done', -60, -40)];
  const a = analyze(entries, { sinceMs: SINCE });
  assert.equal(a.total, 1);
  assert.equal(bucket(a, 2).runs, 1);
  assert.equal(bucket(a, 1).runs, 0);
});

// Breaks if median or p90 use the wrong rank (p90 of 10 runs is the 9th value, not the 10th).
test('median and p90 durations of a bucket', () => {
  const entries = [];
  for (let i = 1; i <= 10; i += 1) entries.push(...run(`r${i}`, i * 100, i * 100 + i * 2));
  const a = analyze(entries, { sinceMs: SINCE });
  const b = bucket(a, 1);
  assert.equal(b.runs, 10);
  assert.equal(b.medianMs, 11 * MIN, 'median of 2,4,...,20 min is 11 min');
  assert.equal(b.p90Ms, 18 * MIN);
  assert.equal(percentile([5], 0.9), 5);
  assert.equal(percentile([], 0.9), null);
});

// Breaks if runs that never started feed the duration stats or the overlap, or if unfinished runs vanish without a count.
test('a run that never started and a start line with no end line are counted apart, not timed', () => {
  const entries = [
    ...run('ok', 0, 10),
    ...run('queue-fail', 0, 0, {}, { notStarted: true, durationMs: 0, error: 'no grok slot came free' }),
    { ts: iso(T0 + 5 * MIN), phase: 'start', id: 'open', ref: 'ref-open', model: 'grok-4.7-high', band: 'MID' },
  ];
  const a = analyze(entries, { sinceMs: SINCE });
  assert.equal(a.total, 1);
  assert.equal(a.notStarted, 1);
  assert.equal(a.unfinished, 1);
  assert.equal(bucket(a, 1).medianMs, 10 * MIN);
});

// Breaks if time-outs, tool-stall stops or tok/s are read from the wrong field.
test('timeouts, tool-stall stops, tok/s and the longest tool call are counted per bucket', () => {
  const entries = [
    ...run('t', 0, 30, {}, { exit: 1, timedOut: true, usage: undefined }),
    ...run('s', 40, 43, {}, { exit: 1, error: 'tool-stall: the first 3 successful tool calls each took 30 s or more', usage: undefined, maxToolMs: 61_000 }),
    ...run('g', 50, 60, {}, { usage: { outputTokens: 30_000 }, maxToolMs: 900 }),
  ];
  const b = bucket(analyze(entries, { sinceMs: SINCE }), 1);
  assert.equal(b.runs, 3);
  assert.equal(b.timeouts, 1);
  assert.equal(b.toolStalls, 1);
  assert.equal(b.tokPerSec.n, 1);
  assert.equal(b.tokPerSec.median, 50, '30000 tokens in 600 s');
  assert.equal(b.maxToolMs, 61_000);
});

// Breaks if a ledger from before repo and purpose existed (or with no usage, spawnedAt or toolStats) throws.
test('old rows with none of the newer fields do not crash the report', () => {
  const entries = [
    { ts: iso(T0 + MIN), phase: 'start', id: 'x', ref: 'pr-1' },
    { ts: iso(T0 + 5 * MIN), phase: 'end', id: 'x', durationMs: 4 * MIN, exit: 0 },
    { not: 'a ledger line' },
  ];
  const a = analyze(entries, { sinceMs: SINCE });
  assert.equal(a.total, 1);
  assert.equal(bucket(a, 1).tokPerSec.n, 0);
  assert.match(formatReport(a, META), /tok\/s +-/);
});

// Breaks if the agent start time (spawnedAt) is ignored: a run that waited 20 min for a slot did not run during the wait.
test('overlap uses the time the agent ran, not the time the run was reserved', () => {
  const entries = [...run('a', 0, 30), ...run('queued', 5, 50, {}, { durationMs: 20 * MIN, spawnedAt: iso(T0 + 30 * MIN) })];
  const a = analyze(entries, { sinceMs: SINCE });
  assert.equal(bucket(a, 1).runs, 2, 'queued ran from minute 30 to 50, after a ended');
});

test('zero runs since the cutoff says so plainly', () => {
  const text = formatReport(analyze(run('old', -90, -80), { sinceMs: SINCE }), META);
  assert.match(text, /No runs since 2026-11-03T18:00:00\.000Z/);
  assert.doesNotMatch(text, /median/);
});

// Breaks if a missing or unreadable --since is accepted: the report would silently cover the wrong window.
test('parseArgs needs a valid --since and reads --ledger', () => {
  assert.match(parseArgs([]).error, /--since/);
  assert.match(parseArgs(['--since', 'yesterday']).error, /--since/);
  assert.match(parseArgs(['--since']).error, /--since/);
  assert.match(parseArgs(['--since', '2026-11-03T18:00:00Z', '--bogus']).error, /unknown/);
  const ok = parseArgs(['--since', '2026-11-03T18:00:00Z', '--ledger', 'x.jsonl']);
  assert.equal(ok.sinceMs, T0);
  assert.equal(ok.ledger, 'x.jsonl');
});

// Breaks if main does not read the ledger file it is given, or writes anything to it.
test('main reads the ledger file, prints the report and leaves the ledger as it was', async () => {
  const file = path.join(tmpDir(), 'ledger.jsonl');
  const text = `${[...run('a', 0, 10), ...run('b', 5, 20)].map((l) => JSON.stringify(l)).join('\n')}\n{broken\n`;
  writeFileSync(file, text);
  const out = [];
  const code = await main(['--since', iso(SINCE), '--ledger', file], { stdout: (s) => out.push(s) });
  assert.equal(code, 0);
  assert.match(out.join('\n'), /runs started since: 2/);
  assert.match(out.join('\n'), /1 damaged/);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(await main(['--ledger', file], { stdout: () => {}, stderr: () => {} }), 2);
});
