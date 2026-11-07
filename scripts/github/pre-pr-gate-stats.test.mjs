// Tests for pre-pr-gate-stats.mjs. Run: node --test scripts/github/pre-pr-gate-stats.test.mjs
//
// How it can fail, and the test that catches it:
//   runs, fails or a percentile is counted wrong (null ms counted as 0, off by one)   -> GS1
//   rows older than --days are counted, or a row with no ts is dropped by accident     -> GS2
//   one bad line in the file stops the report                                          -> GS3
//   the CLI ignores --days / --file, prints nothing for a missing file, or crashes     -> GS4
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateStats, percentile, readRows, formatStats } from './pre-pr-gate-stats.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pre-pr-gate-stats.mjs');
const NOW = new Date('2026-11-07T12:00:00Z');
const row = (step, status, ms, ts = '2026-11-07T10:00:00.000Z') => ({ ts, branch: 'b', head: 'h', base: 'main', run_id: 'r', step, status, ms, detail: '' });
const tmpFile = (lines) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'prepr-stats-')), 'g.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
};

test('GS1: per gate runs, fails, p50 and p90 use nearest rank, and a null ms is left out of the percentiles', () => {
  const rows = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms) => row('gate:a', ms === 100 ? 'FAIL' : 'PASS', ms));
  rows.push(row('gate:a', 'PASS', null), row('gate:b', 'FAIL', 5), row('gate:b', 'SKIP', null));
  const stats = gateStats(rows, { now: NOW });
  const a = stats.find((s) => s.gate === 'gate:a');
  assert.deepEqual([a.runs, a.fails, a.p50, a.p90], [11, 1, 50, 90]);
  const b = stats.find((s) => s.gate === 'gate:b');
  assert.deepEqual([b.runs, b.fails, b.p50, b.p90], [2, 1, 5, 5]);
  assert.equal(gateStats([row('gate:c', 'PASS', null)], { now: NOW })[0].p50, null);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([], 50), null);
});

test('GS2: --days drops older rows and keeps the newer ones', () => {
  const rows = [row('g', 'FAIL', 1, '2026-11-07T09:00:00Z'), row('g', 'FAIL', 1, '2026-10-20T09:00:00Z')];
  assert.equal(gateStats(rows, { days: 3, now: NOW })[0].runs, 1);
  assert.equal(gateStats(rows, { now: NOW })[0].runs, 2);
});

test('GS3: a bad line or a missing file does not stop the reader', () => {
  const file = tmpFile([JSON.stringify(row('g', 'PASS', 4)), '{not json', '', JSON.stringify(row('g', 'FAIL', 6))]);
  assert.equal(readRows(file).length, 2);
  assert.deepEqual(readRows(path.join(os.tmpdir(), 'prepr-no-such-dir', 'x.jsonl')), []);
  assert.match(formatStats([]), /no gate rows/i);
});

test('GS4: the CLI prints one line per gate, honours --days and --file, and --help exits 0', () => {
  const recent = new Date().toISOString();
  const file = tmpFile([
    JSON.stringify(row('gate:hooks-vitest', 'PASS', 50000, recent)), JSON.stringify(row('gate:hooks-vitest', 'FAIL', 76000, recent)),
    JSON.stringify(row('gate:old', 'FAIL', 1, '2020-01-01T00:00:00Z')),
  ]);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PRE_PR_GATE_LOG: '' } });
  const all = run('--file', file);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /gate:hooks-vitest\s+2\s+1\s+50000\s+76000/);
  assert.match(all.stdout, /gate:old\s+1\s+1/);
  const recentOnly = run('--file', file, '--days', '7');
  assert.doesNotMatch(recentOnly.stdout, /gate:old/);
  assert.match(recentOnly.stdout, /gate:hooks-vitest/);
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage/i);
  const missing = run('--file', path.join(os.tmpdir(), 'prepr-no-such-dir', 'x.jsonl'));
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /no gate rows/i);
});
