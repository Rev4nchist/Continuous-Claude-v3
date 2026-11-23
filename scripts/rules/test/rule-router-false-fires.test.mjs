import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Card coord-false-fire-rows: one reading of the false-fire rate. Tests use scratch copies only.
const script = fileURLToPath(new URL('../rule-router-false-fires.mjs', import.meta.url));
const T = (iso) => new Date(iso).toISOString();
const fire = (iso, rules = ['git-merge'], kind = 'inject', what = 'git merge') => ({ ts: T(iso), session: 's', agent: 'main', tool: 'Bash', rules, kind, what });
const rearm = (iso, rules = []) => ({ ts: T(iso), session: 's', agent: 'main', tool: undefined, rules, kind: 'rearm', what: 'SessionStart compact', source: 'compact', removed: 1 });
const cap = (iso, extra = {}) => ({ ts: T(iso), week: '2026-W47', rule: 'git-merge', what: 'git commit', tool: 'Bash', count: 1, reason: 'x', source: 'agent', ...extra });

function scratch(fires, captures) {
  const dir = mkdtempSync(join(tmpdir(), 'rr-ff-'));
  const log = join(dir, 'fires.jsonl');
  const capture = join(dir, 'capture.jsonl');
  writeFileSync(log, fires.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(capture, captures.map((r) => JSON.stringify(r)).join('\n') + (captures.length ? '\n' : ''));
  const manifest = join(dir, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ rules: [{ id: 'git-merge', files: ['x.md'], command: ['^git merge'] }] }));
  return { dir, log, capture, manifest };
}

// PATH without a claude program: a judge call can never run (no cost) and ends as "judge call failed".
function run(s, args, env = {}) {
  const empty = mkdtempSync(join(tmpdir(), 'rr-nopath-'));
  const r = spawnSync(process.execPath, [script, ...args, '--log', s.log, '--capture', s.capture, '--manifest', s.manifest], {
    encoding: 'utf8', env: { ...process.env, PATH: empty, Path: empty, ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}
const rate = (s, since, until) => {
  const r = run(s, ['rate', '--since', since, ...(until ? ['--until', until] : []), '--json']);
  let json = null;
  try { json = JSON.parse(r.out); } catch { /* the assertions show the raw text */ }
  return { ...r, json };
};

test('R1: the denominator holds rule fires of deny and inject rows, never re-arm rows', () => {
  const s = scratch([rearm('2026-11-17T10:00:00Z'), rearm('2026-11-17T11:00:00Z'), rearm('2026-11-17T12:00:00Z'),
    fire('2026-11-17T10:00:00Z'), fire('2026-11-17T10:01:00Z'), fire('2026-11-17T10:02:00Z'), fire('2026-11-17T10:03:00Z', ['git-merge', 'lane-board'], 'deny')], []);
  const r = rate(s, '2026-11-16T00:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.fireRows, 4);
  assert.equal(r.json.ruleFires, 5);
  assert.equal(r.json.rearmRows, 3);
});

test('R2: a review row of 16 fires counts 16 false fires and 1 pair', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z')], [cap('2026-11-17T12:00:00Z', { source: 'review', count: 16, fires: 16, from: '2026-11-17T01:00:00Z', to: '2026-11-17T09:00:00Z' })]);
  const r = rate(s, '2026-11-16T00:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.falsePairs, 1);
  assert.equal(r.json.falseFires, 16);
});

test('R3: a capture row whose fires lie before the window is not in the numerator', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z')], [
    cap('2026-11-16T15:20:00Z', { source: 'review', count: 5, fires: 5, from: '2026-10-28T00:00:00Z', to: '2026-11-15T13:00:00Z' }),
    cap('2026-11-17T12:00:00Z', { from: '2026-11-17T11:59:00Z', to: '2026-11-17T11:59:00Z', fires: 1 }),
  ]);
  const r = rate(s, '2026-11-16T06:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.falseFires, 1);
  assert.equal(r.json.falsePairs, 1);
});

test('R4: an old row with no from field is dated by its capture time and flagged', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z')], [cap('2026-11-17T12:00:00Z')]);
  const r = rate(s, '2026-11-16T00:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.falseFires, 1);
  assert.equal(r.json.datedByCapture, 1);
  const text = run(s, ['rate', '--since', '2026-11-16T00:00:00Z']).out;
  assert.match(text, /dated by capture/);
});

test('R4b: an old review row with no from field judged the 7 days before its capture, so it is not dated by the capture time', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z')], [cap('2026-11-16T15:20:00Z', { source: 'review', count: 5 })]);
  // Captured after the window starts, but its fires lie up to 7 days earlier: partly in the window, not counted.
  const a = rate(s, '2026-11-16T06:00:00Z');
  assert.ok(a.json, a.out);
  assert.equal(a.json.falseFires, 0);
  assert.equal(a.json.partialRows, 1);
  // A window that holds the whole 7 days counts all 5 fires and flags the row.
  const b = rate(s, '2026-11-09T00:00:00Z', '2026-11-17T00:00:00Z');
  assert.equal(b.json.falseFires, 5);
  assert.equal(b.json.datedByCapture, 1);
});

test('R5: a re-arm row with a non-empty rules array is no fire and no pair to judge', () => {
  const s = scratch([rearm('2026-11-17T10:00:00Z', ['git-merge']), fire('2026-11-17T10:01:00Z')], []);
  const r = rate(s, '2026-11-16T00:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.ruleFires, 1);
  assert.equal(r.json.rearmRows, 1);
  const p = run(s, ['review', '--days', '3650', '--print-prompt']);
  assert.doesNotMatch(p.out, /SessionStart compact/);
});

test('R6: review writes from, to and fires on a new capture row', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z', ['git-merge'], 'inject', 'git commit'), fire('2026-11-18T10:00:00Z', ['git-merge'], 'inject', 'git commit')], []);
  const reply = join(s.dir, 'reply.json');
  writeFileSync(reply, JSON.stringify([{ n: 1, verdict: 'false_fire', reason: 'not a merge' }]));
  const r = run(s, ['review', '--days', '3650', '--report', join(s.dir, 'report.md'), '--judge-reply', reply]);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(s.capture));
  const rows = readFileSync(s.capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from, '2026-11-17T10:00:00.000Z');
  assert.equal(rows[0].to, '2026-11-18T10:00:00.000Z');
  assert.equal(rows[0].fires, 2);
  assert.equal(rows[0].count, 2);
});

test('R7: a row whose fires only partly lie in the window is reported apart and not counted', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z')], [
    cap('2026-11-17T12:00:00Z', { source: 'review', count: 4, fires: 4, from: '2026-11-10T00:00:00Z', to: '2026-11-17T01:00:00Z' }),
  ]);
  const r = rate(s, '2026-11-16T00:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.falseFires, 0);
  assert.equal(r.json.partialRows, 1);
});

test('R8: the rate is false fires over rule fires, to two decimals, never over rows', () => {
  const fires = [];
  for (let i = 0; i < 50; i++) fires.push(fire(`2026-11-17T10:${String(i).padStart(2, '0')}:00Z`));
  const s = scratch(fires, [cap('2026-11-17T12:00:00Z', { from: '2026-11-17T11:00:00Z', to: '2026-11-17T11:00:00Z', fires: 1 }),
    cap('2026-11-17T12:01:00Z', { source: 'review', count: 2, fires: 2, from: '2026-11-17T10:00:00Z', to: '2026-11-17T10:30:00Z' })]);
  const r = rate(s, '2026-11-16T00:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.ruleFires, 50);
  assert.equal(r.json.falseFires, 3);
  assert.equal(r.json.ratePercent, 6);
});

test('R8b: the denominator counts rules, not rows: 3 false fires of 7 rule fires in 6 rows is 42.86 percent', () => {
  const fires = [];
  for (let i = 0; i < 5; i++) fires.push(fire(`2026-11-17T10:0${i}:00Z`));
  fires.push(fire('2026-11-17T10:09:00Z', ['git-merge', 'lane-board']));
  const s = scratch(fires, [cap('2026-11-17T12:00:00Z', { from: '2026-11-17T11:00:00Z', to: '2026-11-17T11:00:00Z', fires: 3 })]);
  const r = rate(s, '2026-11-16T00:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.fireRows, 6);
  assert.equal(r.json.ruleFires, 7);
  assert.equal(r.json.ratePercent, 42.86);
});

test('R10: one fire recorded by a session and again by the review counts once', () => {
  const s = scratch([fire('2026-11-17T11:00:00Z', ['git-merge'], 'inject', 'git commit')], [
    cap('2026-11-17T11:05:00Z', { from: '2026-11-17T11:00:00Z', to: '2026-11-17T11:00:00Z', fires: 1 }),
    cap('2026-11-20T09:00:00Z', { source: 'review', count: 3, fires: 3, from: '2026-11-17T10:00:00Z', to: '2026-11-17T12:00:00Z' }),
  ]);
  const r = rate(s, '2026-11-16T00:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.falseFires, 3);
  assert.equal(r.json.falsePairs, 1);
  assert.equal(r.json.dedupedRows, 1);
});

test('R11: a bad or reversed window and a bad --fired-at exit 2 with a usage line', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z')], []);
  for (const args of [['rate', '--since', '2026-11-16T00:00:00Z', '--until', 'soon'], ['rate', '--since', '2026-11-18T00:00:00Z', '--until', '2026-11-16T00:00:00Z'],
    ['add', '--rule', 'git-merge', '--what', 'x', '--fired-at', 'yesterday-ish']]) {
    const r = run(s, args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert.match(r.out, /usage|invalid/i);
  }
});

test('R12: an unknown kind is no fire; fires beats count; a row that spans the whole window is partial', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z'), fire('2026-11-17T10:01:00Z', ['git-merge'], 'none')], [
    cap('2026-11-17T12:00:00Z', { count: 9, fires: 2, from: '2026-11-17T11:00:00Z', to: '2026-11-17T11:00:00Z' }),
    cap('2026-11-17T12:01:00Z', { source: 'review', count: 6, fires: 6, from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z', rule: 'other' }),
  ]);
  const r = rate(s, '2026-11-16T00:00:00Z', '2026-11-18T00:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.ruleFires, 1);
  assert.equal(r.json.falseFires, 2);
  assert.equal(r.json.partialRows, 1);
});

test('R13: fires given as a string is a number; a negative or non-number fires falls back to 1', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z')], [
    cap('2026-11-17T12:00:00Z', { fires: '4', from: '2026-11-17T11:00:00Z', to: '2026-11-17T11:00:00Z', what: 'a' }),
    cap('2026-11-17T12:01:00Z', { fires: -3, from: '2026-11-17T11:01:00Z', to: '2026-11-17T11:01:00Z', what: 'b' }),
    cap('2026-11-17T12:02:00Z', { fires: 'many', from: '2026-11-17T11:02:00Z', to: '2026-11-17T11:02:00Z', what: 'c' }),
  ]);
  const r = rate(s, '2026-11-16T00:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.falseFires, 6);
});

test('R14: a row with a bad timestamp is counted as a bad row, not dropped silently', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z'), { ...fire('2026-11-17T10:00:00Z'), ts: 'not a time' }], [{ ...cap('2026-11-17T12:00:00Z'), ts: 'broken' }]);
  const r = rate(s, '2026-11-16T00:00:00Z');
  assert.ok(r.json, r.out);
  assert.equal(r.json.badRows, 2);
  assert.equal(r.json.ruleFires, 1);
});

test('R15: --judge-reply needs --capture, and a missing reply file is "judge call failed" (exit 1), never a crash or a live write', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z', ['git-merge'], 'inject', 'git commit')], []);
  const home = mkdtempSync(join(tmpdir(), 'rr-home-'));
  const nopath = mkdtempSync(join(tmpdir(), 'rr-nopath-'));
  const env = { ...process.env, USERPROFILE: home, HOME: home, PATH: nopath, Path: nopath }; // no claude program can run
  const bare = spawnSync(process.execPath, [script, 'review', '--days', '3650', '--log', s.log, '--manifest', s.manifest, '--report', join(s.dir, 'r.md'), '--judge-reply', join(s.dir, 'reply.json')], { encoding: 'utf8', env });
  assert.equal(bare.status, 2, bare.stdout + bare.stderr);
  assert.equal(existsSync(join(home, '.claude', 'logs', 'rule-router-false-fires.jsonl')), false);
  const missing = run(s, ['review', '--days', '3650', '--report', join(s.dir, 'r2.md'), '--judge-reply', join(s.dir, 'nope.json')]);
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /judge call failed/);
});

test('R9: add records from and to with the fire time given, and keeps the old fields', () => {
  const s = scratch([fire('2026-11-17T10:00:00Z')], []);
  const r = run(s, ['add', '--rule', 'git-merge', '--what', 'git commit', '--note', 'x', '--source', 'agent', '--fired-at', '2026-11-17T10:00:00Z']);
  assert.equal(r.code, 0, r.out);
  const row = JSON.parse(readFileSync(s.capture, 'utf8').trim());
  assert.equal(row.from, '2026-11-17T10:00:00.000Z');
  assert.equal(row.to, '2026-11-17T10:00:00.000Z');
  assert.equal(row.fires, 1);
  assert.equal(row.count, 1);
  assert.equal(row.rule, 'git-merge');
});
