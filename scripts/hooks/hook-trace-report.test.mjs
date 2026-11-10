// Tests for scripts/hooks/hook-trace-report.mjs (p50 and p95 per hook from the day files).
//
// How the reader can fail, one test each:
//   percentile: empty input is not null, one value is not itself, p95 of 1..100 is not 95 (nearest rank)
//   it reads a file outside the last 7 day files, or the legacy hook-trace.jsonl
//   it counts a test or probe row, or a job row, in the table
//   it prints no p50 or p95 per hook, or the wrong one
//   it hides the .dropped counts or the timeout bias line
//   --by event,tool does not split the groups
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile } from './hook-trace-report.mjs';

const REPORT = join(dirname(fileURLToPath(import.meta.url)), 'hook-trace-report.mjs');
const DAY = 24 * 3600 * 1000;
const dayName = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const row = (name, durationMs, extra = {}) => ({ ts: new Date().toISOString(), name, event: 'PreToolUse', tool: 'Bash', startupMs: 30, durationMs, exitCode: 0, code: 0, sessionId: 's', out: 'allow', error: null, source: 'live', ...extra });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const run = (dir, ...args) => spawnSync(process.execPath, [REPORT, '--dir', dir, ...args], { encoding: 'utf8', windowsHide: true });
const lineOf = (out, name) => out.split('\n').find((l) => l.trim().startsWith(name));

test('percentile: empty is null, one value is itself, p95 of 1..100 is 95, p50 of 1..100 is 50', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([7], 95), 7);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile(hundred, 50), 50);
  assert.equal(percentile([5, 1, 3], 50), 3); // unsorted input
});

test('prints n, p50, p95 and max per hook from the day files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'htr-'));
  const rows = Array.from({ length: 100 }, (_, i) => row('guard-a', i + 1));
  writeFileSync(join(dir, `hook-trace-${dayName(0)}.jsonl`), jsonl([...rows, row('guard-b', 10), row('guard-b', 30)]));
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const a = lineOf(r.stdout, 'guard-a');
  assert.ok(a, r.stdout);
  assert.match(a, /\b100\b.*\b50\b.*\b95\b.*\b100\b/); // n, p50, p95, max in that order
  assert.match(lineOf(r.stdout, 'guard-b'), /\b2\b/);
});

test('skips test and probe rows and job rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'htr-'));
  writeFileSync(join(dir, `hook-trace-${dayName(0)}.jsonl`), jsonl([
    row('live-hook', 10), row('live-hook', 20, { source: 'test' }), row('live-hook', 30, { source: 'probe' }),
    row('prompt-submit/job', 5, { kind: 'job' }), row('only-probe', 5, { source: 'probe' }),
  ]));
  const r = run(dir);
  assert.match(lineOf(r.stdout, 'live-hook'), /\b1\b/);
  assert.equal(lineOf(r.stdout, 'only-probe'), undefined);
  assert.equal(lineOf(r.stdout, 'prompt-submit/job'), undefined);
});

test('reads only the last 7 day files and ignores the legacy hook-trace.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'htr-'));
  for (let n = 0; n < 7; n++) writeFileSync(join(dir, `hook-trace-${dayName(n)}.jsonl`), jsonl([row('in-window', 10)]));
  writeFileSync(join(dir, `hook-trace-${dayName(8)}.jsonl`), jsonl([row('too-old', 10)]));
  writeFileSync(join(dir, 'hook-trace.jsonl'), jsonl([row('legacy', 10)]));
  const r = run(dir);
  assert.match(lineOf(r.stdout, 'in-window'), /\b7\b/);
  assert.equal(lineOf(r.stdout, 'too-old'), undefined);
  assert.equal(lineOf(r.stdout, 'legacy'), undefined);
});

test('prints the .dropped counts and the timeout bias line, and the dependency-evaluation note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'htr-'));
  writeFileSync(join(dir, `hook-trace-${dayName(0)}.jsonl`), jsonl([row('x', 1)]));
  writeFileSync(join(dir, `hook-trace-${dayName(0)}.dropped`), '{"dropped":42}\n');
  const r = run(dir);
  assert.match(r.stdout, /dropped.*42/i);
  assert.match(r.stdout, /timeout-killed hooks write no row; p95 is biased low/);
  assert.match(r.stdout, /bundled dependency evaluation is in durationMs/);
});

test('--by event,tool splits one hook into one line per event and tool, and counts the out classes and the error rate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'htr-'));
  writeFileSync(join(dir, `hook-trace-${dayName(0)}.jsonl`), jsonl([
    row('g', 10, { event: 'PreToolUse', tool: 'Bash', out: 'deny' }), row('g', 20, { event: 'PostToolUse', tool: 'PowerShell', code: 1, exitCode: 1 }),
  ]));
  const r = run(dir, '--by', 'event,tool');
  assert.match(r.stdout, /g\s+PreToolUse\s+Bash/);
  assert.match(r.stdout, /g\s+PostToolUse\s+PowerShell/);
  assert.match(r.stdout, /deny:1/);
  assert.match(r.stdout, /err 100%/);
});

test('an empty or missing dir is a clear message and exit 1, never a table of zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'htr-'));
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /no live rows/i);
});
