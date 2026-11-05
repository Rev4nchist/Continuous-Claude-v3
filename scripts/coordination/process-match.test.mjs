// Tests for process-match.mjs: join claude.exe processes to lane board sessions by start time.
// Pure functions only; no database, no process listing. Runs on Linux and Windows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityPids, matchProcesses, parseProcessList, summarize } from './process-match.mjs';

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

test('parseProcessList: JSON with rows but none usable is unknown (null), not zero processes', () => {
  assert.equal(parseProcessList('{"error":"denied"}'), null);
  assert.equal(parseProcessList('[{"pid":"x","startMs":1}]'), null);
  assert.deepEqual(parseProcessList('[]'), []);
});

test('summarize: counts and unmatched pids', () => {
  const s = summarize(matchProcesses([proc(1, T), proc(2, T + 99999)], [sess('a', T)]));
  assert.deepEqual(s, { total: 2, matched: 1, unmatchedPids: [2] });
});

// ---- pid join: the SessionStart hook writes CLAUDE_PID into the identity file on every start, resume included.
// A resumed session keeps its old sessions.started_at, so only the pid can match it to its new process.
const ident = (id, pid, updatedMs) => ({ id, pid, updatedMs });
const HOUR = 3_600_000;

test('pid join: a resumed session (old start time, new process) matches by pid', () => {
  const r = matchProcesses([proc(7, T)], [sess('old', T - 5 * HOUR)], { identities: [ident('old', 7, T + 3000)] });
  assert.deepEqual(r.matched.map((m) => [m.pid, m.id, m.by]), [[7, 'old', 'pid']]);
  assert.deepEqual(r.unmatchedProcs, []);
});

test('pid join: the pid claim wins over a nearer start time', () => {
  // Process 7 started next to session x, but its identity file says it is session y.
  const r = matchProcesses([proc(7, T)], [sess('x', T + 500), sess('y', T - 5 * HOUR)], { identities: [ident('y', 7, T + 3000)] });
  assert.deepEqual(r.matched.map((m) => [m.pid, m.id, m.by]), [[7, 'y', 'pid']]);
  assert.deepEqual(r.unmatchedSessions.map((s) => s.id), ['x']);
});

test('pid join: an identity older than the process is a reused pid, not a match', () => {
  const r = matchProcesses([proc(7, T)], [sess('old', T - 5 * HOUR)], { identities: [ident('old', 7, T - HOUR)] });
  assert.equal(r.matched.length, 0);
  assert.deepEqual(r.unmatchedProcs.map((p) => p.pid), [7]);
});

test('pid join: a small clock skew between the file and the process is tolerated', () => {
  const r = matchProcesses([proc(7, T)], [sess('s', T - HOUR)], { identities: [ident('s', 7, T - 1000)] });
  assert.equal(r.matched.length, 1);
});

test('pid join: an identity whose session is not live is ignored (an ended /clear predecessor shares the pid)', () => {
  const r = matchProcesses([proc(7, T)], [sess('new', T + 1000)], {
    identities: [ident('cleared', 7, T + 500), ident('new', 7, T + 2000)],
  });
  assert.deepEqual(r.matched.map((m) => [m.pid, m.id]), [[7, 'new']]);
});

test('pid join: two live sessions claim one pid, the newer identity wins', () => {
  const r = matchProcesses([proc(7, T)], [sess('a', T + 100), sess('b', T + 200)], {
    identities: [ident('a', 7, T + 1000), ident('b', 7, T + 9000)],
  });
  assert.deepEqual(r.matched.map((m) => [m.pid, m.id, m.by]), [[7, 'b', 'pid']]);
});

test('no identity for the pid: the start-time join still matches', () => {
  const r = matchProcesses([proc(7, T)], [sess('s', T + 1000)], { identities: [ident('other', 99, T)] });
  assert.deepEqual(r.matched.map((m) => [m.pid, m.id, m.by]), [[7, 's', 'start']]);
});

test('identityPids: reads a Map of identity files; keeps good rows, drops bad pid or bad time', () => {
  const m = new Map([
    ['u1', { uuid: 'u1', pid: 4242, updatedAt: '2026-11-05T14:07:03.000Z' }],
    ['u2', { uuid: 'u2', pid: null, updatedAt: '2026-11-05T14:07:03.000Z' }],
    ['u3', { uuid: 'u3', updatedAt: '2026-11-05T14:07:03.000Z' }],
    ['u4', { uuid: 'u4', pid: '12', updatedAt: '2026-11-05T14:07:03.000Z' }],
    ['u5', { uuid: 'u5', pid: 0, updatedAt: '2026-11-05T14:07:03.000Z' }],
    ['u6', { uuid: 'u6', pid: 77, updatedAt: 'not a date' }],
  ]);
  assert.deepEqual(identityPids(m), [{ id: 'u1', pid: 4242, updatedMs: Date.UTC(2026, 10, 5, 14, 7, 3) }]);
});
