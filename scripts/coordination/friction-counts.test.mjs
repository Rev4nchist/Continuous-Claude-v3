/**
 * friction-counts.test.mjs -- card seat-friction-counts. The seat reads friction as counts, never as raw log rows.
 *
 * Synthetic rows only: every log file is built in a temp folder with made-up names and sentinel values. A sentinel (a PR number, a sha-shaped head, a
 * session label, a branch, a lane id) must never reach the output. FRICTION_COUNTS_CLI points the tests at another copy of the script (a mutation run).
 * Test names C1..C15 are the failure list of the plan (C14 and C15 came from the CodeRabbit CLI run 1 of the first head). The file name has no `.db.` part: it needs no database.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASET_REL, EVAL_CONFIG_REL } from './board-mask.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.FRICTION_COUNTS_CLI ? path.resolve(process.env.FRICTION_COUNTS_CLI) : path.join(HERE, 'friction-counts.mjs');

const NOW = Date.parse('2026-11-26T20:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const HOUR = 3_600_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const SENTINELS = ['9876543', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'abc12345', 'Sentinel', 'sentinel', 'Continuous-Claude', '424242', 'cafe1234'];

let tmp;
let n = 0;
const folder = () => { const d = path.join(tmp, `case${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const jsonl = (rows) => `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;
const put = (dir, name, rows) => { const f = path.join(dir, name); fs.writeFileSync(f, jsonl(rows)); return f; };
const run = (args) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: tmp }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-counts-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** An empty board root: no listed-id list (the script says so on stderr and goes on). */
const bareRoot = () => folder();
/** A board root with a listed-id list: the dataset has one digit comment id, and `extra` more ids (strings). */
function listRoot(extra = []) {
  const root = folder();
  fs.mkdirSync(path.join(root, 'scripts', 'eval', 'review-eval'), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, DATASET_REL)), { recursive: true });
  const findings = [{ pr: 7654321, comment_id: 1234567890 }, ...extra.map((id) => ({ pr: 7654321, comment_id: id }))];
  fs.writeFileSync(path.join(root, DATASET_REL), JSON.stringify({ prs: [{ pr: 7654321 }], findings }));
  fs.writeFileSync(path.join(root, EVAL_CONFIG_REL), '{}');
  return root;
}

// A decision-log tap and a runs-log row, with every field that must NOT reach the output set to a sentinel.
const tap = (step, { rec = true, msAgo = HOUR } = {}) => ({
  v: 1, kind: 'tap', id: '11111111-2222-3333-4444-555555555555', at: iso(msAgo), step, key: 'Rev4nchist/Continuous-Claude-v3#9876543',
  repo: 'Rev4nchist/Continuous-Claude-v3', pr: 9876543, branch: 'coord/sentinel-branch', head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  label: rec ? 'Land now (Recommended)' : 'Keep open', entry: 'cli', session: 'abc12345 Sentinel', lane: ['sentinel-lane'], tree: null,
});
const start = ({ msAgo = HOUR } = {}) => ({ ts: NOW - msAgo, event: 'start', pid: 424242, head: 'cafe1234', heavy: false, free: 10, load: 20, mode: 'grant' });
const end = (result, failing, minutes, { msAgo = HOUR } = {}) => ({ ts: NOW - msAgo, event: 'end', pid: 424242, head: 'cafe1234', result, failing, minutes });

const args = (dir, d, r, ...more) => ['--decisions', d, '--runs', r, '--now', NOW_ISO, '--root', dir, ...more];
const oneLine = (r) => { assert.equal(r.out.split('\n').length, 2, `one line of output: ${JSON.stringify(r.out)}`); return r.out.trim(); };

describe('counts and shape', () => {
  it('C1: taps are counted per step with the recommended share, and pre-pr starts, ends, FAILs and FAILs under 1 minute by failing step', () => {
    const dir = listRoot();
    const d = put(dir, 'd.jsonl', [tap('land'), tap('land'), tap('land', { rec: false }), tap('open-pr')]);
    const r = put(dir, 'r.jsonl', [start(), start(), start(), start(), end('PASS', null, 10), end('FAIL', 'evidence', 0.8), end('FAIL', 'summary', 2.1)]);
    const out = run(args(dir, d, r));
    assert.equal(out.code, 0, out.err);
    assert.equal(oneLine(out), 'taps (land, open-pr, review) 1d recommended/all: land 2/3 open-pr 1/1 review 0/0 | pre-pr 1d: starts 4 ends 3 FAIL 2 (evidence 1, summary 1) FAIL<1min 1 (evidence 1) ERROR 0');
  });

  it('C2: a label without the (Recommended) ending is not a recommended tap', () => {
    const dir = listRoot();
    const d = put(dir, 'd.jsonl', [tap('review', { rec: false }), tap('review', { rec: false })]);
    const r = put(dir, 'r.jsonl', [start()]);
    const out = run(args(dir, d, r));
    assert.match(oneLine(out), /review 0\/2/);
  });

  it('C3: the window drops rows older than N days and rows in the future; --days 7 brings the older ones back', () => {
    const dir = listRoot();
    const d = put(dir, 'd.jsonl', [tap('land'), tap('land', { msAgo: 2 * 24 * HOUR }), tap('land', { msAgo: -3 * HOUR })]);
    const r = put(dir, 'r.jsonl', [start(), start({ msAgo: 3 * 24 * HOUR }), end('FAIL', 'evidence', 0.5, { msAgo: 3 * 24 * HOUR })]);
    assert.match(oneLine(run(args(dir, d, r))), /^taps \(land, open-pr, review\) 1d recommended\/all: land 1\/1 .* \| pre-pr 1d: starts 1 ends 0 FAIL 0 FAIL<1min 0 ERROR 0$/);
    assert.match(oneLine(run(args(dir, d, r, '--days', '7'))), /^taps \(land, open-pr, review\) 7d recommended\/all: land 2\/2 .* \| pre-pr 7d: starts 2 ends 1 FAIL 1 \(evidence 1\) FAIL<1min 1 \(evidence 1\) ERROR 0$/);
  });

  it('C11: a step with no row still prints 0/0, so the line keeps one shape; the line begins with the sources', () => {
    const dir = listRoot();
    const d = put(dir, 'd.jsonl', [tap('open-pr')]);
    const r = put(dir, 'r.jsonl', [start()]);
    const out = run(args(dir, d, r));
    const line = oneLine(out);
    assert.ok(line.startsWith('taps (land, open-pr, review)'), line);
    assert.match(line, /land 0\/0 open-pr 1\/1 review 0\/0/);
    assert.match(line, /FAIL 0 FAIL<1min 0 ERROR 0$/);
  });

  it('C14: an ERROR end row (pre-pr.mjs writes it when a run dies) counts as an end and prints apart from FAIL as "ERROR n"', () => {
    const dir = listRoot();
    const d = put(dir, 'd.jsonl', [tap('land')]);
    const r = put(dir, 'r.jsonl', [start(), start(), start(), end('PASS', null, 9), end('FAIL', 'evidence', 0.5), { ...end('ERROR', null, 6), exitCode: 130 }]);
    const out = run(args(dir, d, r));
    assert.equal(out.code, 0, out.err);
    assert.match(oneLine(out), /starts 3 ends 3 FAIL 1 \(evidence 1\) FAIL<1min 1 \(evidence 1\) ERROR 1$/);
    assert.ok(!out.err.includes('skipped'), 'an ERROR row is a known shape, not a skipped row');
  });

  it('C15: a failing step named like an Object.prototype key (constructor) counts as a step; __proto__ is not a plain name and counts as "other"', () => {
    const dir = listRoot();
    const d = put(dir, 'd.jsonl', [tap('land')]);
    const r = put(dir, 'r.jsonl', [start(), end('FAIL', 'constructor', 0.4), end('FAIL', 'constructor', 5), end('FAIL', '__proto__', 0.2)]);
    const out = run(args(dir, d, r));
    assert.equal(out.code, 0, out.err);
    assert.match(oneLine(out), /FAIL 3 \(constructor 2, other 1\) FAIL<1min 2 \(constructor 1, other 1\) ERROR 0$/);
  });
});

describe('no PR number, sha or id in the output', () => {
  it('C5: no sentinel of a row (PR number, head, session, branch, lane, pid) reaches stdout or stderr', () => {
    const dir = listRoot();
    const d = put(dir, 'd.jsonl', [tap('land'), tap('open-pr'), tap('review')]);
    const r = put(dir, 'r.jsonl', [start(), end('FAIL', 'evidence', 0.5), end('PASS', null, 9)]);
    const out = run(args(dir, d, r));
    assert.equal(out.code, 0, out.err);
    for (const s of SENTINELS) assert.ok(!out.out.includes(s) && !out.err.includes(s), `the output holds a sentinel: ${s.length > 8 ? 'long one' : s}`);
  });

  it('C6: a step or failing name that is not a plain gate name (a hex run, markup, a long text) counts as "other", never by name', () => {
    const dir = listRoot();
    const d = put(dir, 'd.jsonl', [tap('abcdef1234567'), tap('<b>x</b>')]);
    const r = put(dir, 'r.jsonl', [start(), end('FAIL', 'deadbeefcafe0123', 0.4), end('FAIL', '<script>', 0.4), end('FAIL', 'a'.repeat(60), 5), end('FAIL', null, 5)]);
    const out = run(args(dir, d, r));
    assert.equal(out.code, 0, out.err);
    const line = oneLine(out);
    assert.match(line, /review 0\/0 other 2\/2 \|/);
    assert.match(line, /FAIL 4 \(other 4\) FAIL<1min 2 \(other 2\)/);
    for (const bad of ['deadbeef', 'script', 'abcdef12', '<b>', 'aaaaaaaa']) assert.ok(!line.includes(bad), `the line holds ${bad}`);
  });

  it('C7: a listed id that equals a printed word stops the run: exit 3, nothing on stdout', () => {
    const dir = listRoot(['zzcollide']);
    const d = put(dir, 'd.jsonl', [tap('land')]);
    const r = put(dir, 'r.jsonl', [start(), end('FAIL', 'zzcollide', 0.5)]);
    const out = run(args(dir, d, r));
    assert.equal(out.code, 3);
    assert.equal(out.out, '');
  });

  it('C7b: the message names the field that collided and never its value', () => {
    const dir = listRoot(['zzcollide']);
    const d = put(dir, 'd.jsonl', [tap('land')]);
    const r = put(dir, 'r.jsonl', [start(), end('FAIL', 'zzcollide', 0.5)]);
    const out = run(args(dir, d, r));
    assert.equal(out.code, 3);
    assert.match(out.err, /collided with field "pre-pr FAIL step name"/);
    assert.ok(!out.err.includes('zzcollide'), 'the id is not in the message');
  });

  it('C13: an unreadable listed-id list stops the run (exit 3, nothing on stdout); no list at all gives a note on stderr and the line', () => {
    const bad = listRoot();
    fs.writeFileSync(path.join(bad, DATASET_REL), '{ not json');
    const d = put(bad, 'd.jsonl', [tap('land')]);
    const r = put(bad, 'r.jsonl', [start()]);
    const stopped = run(args(bad, d, r));
    assert.equal(stopped.code, 3);
    assert.equal(stopped.out, '');
    const none = bareRoot();
    const d2 = put(none, 'd.jsonl', [tap('land')]);
    const r2 = put(none, 'r.jsonl', [start()]);
    const ok = run(args(none, d2, r2));
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.err, /no listed-id list/);
    assert.match(ok.out, /^taps \(land, open-pr, review\)/);
  });
});

describe('inputs and errors', () => {
  it('C8: a line that is not JSON, or lacks the shape, is skipped and counted on stderr only', () => {
    const dir = listRoot();
    const d = put(dir, 'd.jsonl', ['not json at all', { kind: 'tap', step: 'land' }, tap('land'), { v: 1, kind: 'other', at: iso(HOUR), step: 'land', label: 'x' }]);
    const r = put(dir, 'r.jsonl', [start(), '{"event":"end","result":"MAYBE","ts":1}', end('PASS', null, 3)]);
    const out = run(args(dir, d, r));
    assert.equal(out.code, 0, out.err);
    assert.match(oneLine(out), /land 1\/1/);
    assert.match(out.err, /skipped 4 rows/);
    assert.ok(!out.out.includes('skipped'), 'stdout holds the one line only');
  });

  it('C9: both logs missing, or no row of either in the window, exits 2 with nothing on stdout; one missing log prints "no log" for its half', () => {
    const dir = bareRoot();
    const gone = run(args(dir, path.join(dir, 'no-d.jsonl'), path.join(dir, 'no-r.jsonl')));
    assert.equal(gone.code, 2);
    assert.equal(gone.out, '');
    const oldD = put(dir, 'old-d.jsonl', [tap('land', { msAgo: 5 * 24 * HOUR })]);
    const oldR = put(dir, 'old-r.jsonl', [start({ msAgo: 5 * 24 * HOUR })]);
    const empty = run(args(dir, oldD, oldR));
    assert.equal(empty.code, 2);
    assert.equal(empty.out, '');
    const d = put(dir, 'd.jsonl', [tap('land')]);
    const half = run(args(dir, d, path.join(dir, 'no-r.jsonl')));
    assert.equal(half.code, 0, half.err);
    assert.match(oneLine(half), /land 1\/1 open-pr 0\/0 review 0\/0 \| pre-pr 1d: no log$/);
  });

  it('C10: the script only reads: both input files are byte-equal after a run, and no other file appears next to them', () => {
    const dir = listRoot();
    const d = put(dir, 'd.jsonl', [tap('land'), tap('review')]);
    const r = put(dir, 'r.jsonl', [start(), end('FAIL', 'evidence', 0.3)]);
    const before = { d: fs.readFileSync(d), r: fs.readFileSync(r), names: fs.readdirSync(dir).sort() };
    const out = run(args(dir, d, r));
    assert.equal(out.code, 0, out.err);
    assert.ok(fs.readFileSync(d).equals(before.d) && fs.readFileSync(r).equals(before.r), 'an input file changed');
    assert.deepEqual(fs.readdirSync(dir).sort(), before.names, 'a file was added or removed');
  });

  it('C12: usage errors exit 1 with nothing on stdout (a bad --days, an unknown argument, a missing value)', () => {
    const dir = bareRoot();
    for (const bad of [['--days', '0'], ['--days', 'x'], ['--nope'], ['--decisions']]) {
      const out = run([...bad, '--root', dir]);
      assert.equal(out.code, 1, `${bad.join(' ')}: ${out.err}`);
      assert.match(out.err, /^friction-counts: /, 'the script names itself in the usage message (a missing module also exits 1)');
      assert.equal(out.out, '');
    }
  });
});
