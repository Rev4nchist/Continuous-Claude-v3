// Tests for process-match.mjs: join claude.exe processes to lane board sessions by start time.
// Pure functions only; no database, no process listing. Runs on Linux and Windows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchProcesses, parseProcessList, summarize } from './process-match.mjs';

const T = Date.UTC(2026, 10, 5, 14, 7, 3);
const proc = (pid, ms) => ({ pid, startMs: ms });
const sess = (id, ms) => ({ id, startMs: ms });

test('exact and near start times match; gap is reported', () => {
  const r = matchProcesses([proc(1, T), proc(2, T + 4000)], [sess('a', T + 1000), sess('b', T + 4000)]);
  assert.deepEqual(r.matched.map((m) => [m.pid, m.id]), [[1, 'a'], [2, 'b']]);
  assert.equal(r.matched[0].gapMs, 1000);
  assert.deepEqual(r.unmatchedProcs, []);
  assert.deepEqual(r.unmatchedSessions, []);
});

test('a gap above the tolerance is not a match', () => {
  const r = matchProcesses([proc(1, T)], [sess('a', T + 11000)]);
  assert.equal(r.matched.length, 0);
  assert.deepEqual(r.unmatchedProcs.map((p) => p.pid), [1]);
  assert.deepEqual(r.unmatchedSessions.map((s) => s.id), ['a']);
});

test('tolerance is an option', () => {
  const r = matchProcesses([proc(1, T)], [sess('a', T + 11000)], { toleranceMs: 20000 });
  assert.equal(r.matched.length, 1);
});

test('two processes near one session: the closest wins, the other stays unmatched', () => {
  const r = matchProcesses([proc(1, T + 5000), proc(2, T + 1000)], [sess('a', T)]);
  assert.deepEqual(r.matched.map((m) => [m.pid, m.id]), [[2, 'a']]);
  assert.deepEqual(r.unmatchedProcs.map((p) => p.pid), [1]);
});

test('empty inputs', () => {
  assert.deepEqual(matchProcesses([], []), { matched: [], unmatchedProcs: [], unmatchedSessions: [] });
});

test('parseProcessList: a JSON array', () => {
  assert.deepEqual(parseProcessList(`[{"pid":7,"startMs":${T}},{"pid":8,"startMs":${T + 1}}]`), [proc(7, T), proc(8, T + 1)]);
});

test('parseProcessList: PowerShell prints one object, not an array, for a single process', () => {
  assert.deepEqual(parseProcessList(`{"pid":7,"startMs":${T}}`), [proc(7, T)]);
});

test('parseProcessList: empty output means no processes; garbage means unknown (null)', () => {
  assert.deepEqual(parseProcessList(''), []);
  assert.equal(parseProcessList('not json'), null);
});

test('parseProcessList: drops rows without a numeric pid or start', () => {
  assert.deepEqual(parseProcessList(`[{"pid":7,"startMs":${T}},{"pid":"x","startMs":1},{"pid":9}]`), [proc(7, T)]);
});

test('summarize: counts and unmatched pids', () => {
  const s = summarize(matchProcesses([proc(1, T), proc(2, T + 99999)], [sess('a', T)]));
  assert.deepEqual(s, { total: 2, matched: 1, unmatchedPids: [2] });
});
