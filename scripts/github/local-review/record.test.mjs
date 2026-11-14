// Tests for scripts/github/local-review/record.mjs. Every test names the source change that would break it.
// Run: node --test scripts/github/local-review/record.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync as realRename, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import * as REC from './record.mjs'; // the new exports are read through REC so a missing one fails its own test, not the whole file
import { createHash } from 'node:crypto';
import {
  branchSlug, buildFunnel, confidenceOf, findRecord, lastReviewedSha, listRecords, majorsOpen, settlePrior, writeRecord,
} from './record.mjs';

const made = [];
const tmp = (label) => { const d = mkdtempSync(path.join(os.tmpdir(), `lr-record-${label}-`)); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const H3 = 'c'.repeat(40);
const major = (id, extra = {}) => ({ id, file: 'a.mjs', startLine: 5, severity: 'major', title: `t-${id}`, status: 'open', confidence: 4, ...extra });
const rec = (runId, head, findings = [], extra = {}) => ({ branch: 'feat/x', head, runId, status: 'ok', coverage: { complete: true }, findings, ts: `2026-11-02T10:00:0${runId.slice(-1)}.000Z`, ...extra });

// ---------- majorsOpen ----------

test('15 missing-confidence-counts: a Major with no confidence counts as 3; confidence 2 does not (breaks if the default is below 3)', () => {
  assert.equal(confidenceOf({}), 3);
  assert.equal(confidenceOf({ confidence: 'high' }), 3);
  const r = rec('r1', H1, [major('nc', { confidence: undefined }), major('low', { confidence: 2 }), major('edge', { confidence: 3 })]);
  assert.deepEqual(majorsOpen(r).map((f) => f.id).sort(), ['edge', 'nc']);
});

test('majorsOpen counts critical and major only, and only while open (breaks if minor or fixed findings are counted)', () => {
  const r = rec('r1', H1, [
    major('crit', { severity: 'critical' }), major('min', { severity: 'minor' }), major('gone', { status: 'fixed' }),
    major('old', { status: 'stale' }), major('nostatus', { status: undefined }),
  ]);
  assert.deepEqual(majorsOpen(r).map((f) => f.id).sort(), ['crit', 'nostatus']);
});

test('majorsOpen is the union over runs, one entry per finding id (breaks if only the last run is read)', () => {
  const a = rec('r1', H1, [major('x'), major('y')]);
  const b = rec('r2', H1, [major('y'), major('z')]);
  assert.deepEqual(majorsOpen([a, b]).map((f) => f.id).sort(), ['x', 'y', 'z']);
});

// ---------- 13.3 append-only ----------

test('13.3 same-head re-run keeps Majors: a clean --fresh run does not erase an earlier Major (breaks if majorsOpen reads only the new run)', () => {
  const root = tmp('keep');
  const first = writeRecord(rec('r1', H1, [major('x')]), { stateRoot: root });
  assert.equal(first.record.majorsOpen, 1);
  const second = writeRecord(rec('r2', H1, [], { mode: 'full' }), { stateRoot: root });
  assert.equal(second.record.majorsOpen, 1, 'the clean re-run still reports the earlier Major');
  assert.equal(findRecord({ branch: 'feat/x', head: H1 }, { stateRoot: root }).runId, 'r2');
  assert.equal(listRecords({ branch: 'feat/x', head: H1 }, { stateRoot: root }).records.length, 2);
});

test('13.3 writeRecord never overwrites: the same runId throws and the first file is unchanged (breaks if the exists check is removed)', () => {
  const root = tmp('append');
  const first = writeRecord(rec('r1', H1, [major('x')]), { stateRoot: root });
  const before = readFileSync(first.path, 'utf8');
  assert.throws(() => writeRecord(rec('r1', H1, []), { stateRoot: root }), /append-only/);
  assert.equal(readFileSync(first.path, 'utf8'), before);
});

test('13.3 the stored path is <root>/<slug>/<head40>/<runId>.json and sha256 is of the stored bytes (breaks if the layout or hash changes)', () => {
  const root = tmp('layout');
  const w = writeRecord(rec('r1', H1), { stateRoot: root });
  assert.equal(w.path, path.join(root, 'feat-x', H1, 'r1.json'));
  assert.equal(createHash('sha256').update(readFileSync(w.path)).digest('hex'), w.sha256);
  assert.equal(JSON.parse(readFileSync(w.path, 'utf8')).schema, 2);
});

test('13.3 the state root comes from opts or the environment, never a fixed home path in tests (breaks if the injection is ignored)', () => {
  const viaEnv = tmp('env');
  const w = writeRecord(rec('r1', H1), { env: { LOCAL_REVIEW_STATE_DIR: viaEnv } });
  assert.ok(w.path.startsWith(viaEnv));
});

test('an unreadable earlier record is reported as a problem, not skipped silently (breaks if unreadable files are ignored)', () => {
  const root = tmp('bad');
  const dir = path.join(root, 'feat-x', H1);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  const w = writeRecord(rec('r1', H1), { stateRoot: root });
  assert.match(w.record.problems.join('\n'), /unreadable record: .*broken\.json/);
});

// ---------- 13.3 slug ----------

test('13.3 slug escape refused: ".." names throw, and a hostile branch writes nothing outside the state root (breaks if the ".." check is removed)', () => {
  for (const bad of ['..', '../evil', 'a/../b', 'x..y', '.', '']) assert.throws(() => branchSlug(bad), /refused|usable/, bad);
  const root = tmp('slug');
  assert.throws(() => writeRecord({ ...rec('r1', H1), branch: '../../escape' }, { stateRoot: path.join(root, 'state') }));
  assert.deepEqual(readdirSync(root), [], 'nothing was created next to the state root');
});

test('13.3 slug maps characters outside [A-Za-z0-9._-] to "-" (breaks if a slash is kept)', () => {
  assert.equal(branchSlug('feat/local review:engine'), 'feat-local-review-engine');
  assert.equal(branchSlug('v1.2_x-y'), 'v1.2_x-y');
});

test('a head that is not 40 hex and a runId with a path part are refused (breaks if either check is removed)', () => {
  const root = tmp('ids');
  assert.throws(() => writeRecord(rec('r1', 'abc123'), { stateRoot: root }), /40-character/);
  assert.throws(() => writeRecord(rec('r1', H1, [], { runId: '../r1' }), { stateRoot: root }), /not usable/);
});

// ---------- 21 atomic ----------

test('21 record-atomic-rename: the body goes to a temp file and is renamed; the final path is never written directly (breaks if writeRecord uses writeFileSync on the final path)', () => {
  const root = tmp('atomic');
  const calls = [];
  const spy = {
    writeFileSync: (p, b) => { calls.push(['write', p, existsSync(p)]); writeFileSync(p, b); },
    renameSync: (a, b) => { calls.push(['rename', a, b]); return realRename(a, b); },
  };
  const w = writeRecord(rec('r1', H1, [major('x')]), { stateRoot: root, fs: spy });
  const writes = calls.filter((c) => c[0] === 'write');
  assert.equal(writes.length, 1);
  assert.notEqual(writes[0][1], w.path, 'the body is not written to the final path');
  const renames = calls.filter((c) => c[0] === 'rename');
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], writes[0][1]);
  assert.equal(renames[0][2], w.path);
  assert.deepEqual(readdirSync(path.dirname(w.path)), ['r1.json'], 'no temp file is left');
});

test('21 a failed rename leaves no temp file and no final file (breaks if the cleanup is removed)', () => {
  const root = tmp('atomic-fail');
  const spy = { renameSync: () => { throw new Error('disk full'); } };
  assert.throws(() => writeRecord(rec('r1', H1), { stateRoot: root, fs: spy }), /disk full/);
  assert.deepEqual(readdirSync(path.join(root, 'feat-x', H1)), []);
});

// ---------- lastReviewedSha ----------

test('lastReviewedSha returns the newest ok+complete ancestor head, skipping partial runs and non-ancestors (breaks if complete or isAncestor is ignored)', () => {
  const root = tmp('last');
  writeRecord(rec('r1', H1), { stateRoot: root });
  writeRecord(rec('r2', H2, [], { coverage: { complete: false } }), { stateRoot: root });
  writeRecord(rec('r3', H3, [], { ts: '2026-11-02T10:00:09.000Z' }), { stateRoot: root });
  const HEAD = 'd'.repeat(40);
  const ancestors = new Set([H1, H2]);
  const is = (c) => ancestors.has(c);
  assert.equal(lastReviewedSha({ branch: 'feat/x', head: HEAD, isAncestor: is }, { stateRoot: root }), H1);
  ancestors.add(H3);
  assert.equal(lastReviewedSha({ branch: 'feat/x', head: HEAD, isAncestor: is }, { stateRoot: root }), H3);
  assert.equal(lastReviewedSha({ branch: 'other', head: HEAD, isAncestor: is }, { stateRoot: root }), null);
});

test('lastReviewedSha with trustedOnly skips trusted:false records (breaks if the trust filter is removed)', () => {
  const root = tmp('trust');
  writeRecord(rec('r1', H1, [], { trusted: false }), { stateRoot: root });
  const HEAD = 'd'.repeat(40);
  assert.equal(lastReviewedSha({ branch: 'feat/x', head: HEAD, isAncestor: () => true, trustedOnly: true }, { stateRoot: root }), null);
  assert.equal(lastReviewedSha({ branch: 'feat/x', head: HEAD, isAncestor: () => true }, { stateRoot: root }), H1);
});

// ---------- prior answers (18 and 13.3) ----------

const prior = [major('p1'), major('p2', { file: 'gone.mjs' }), major('p3')];

test('18 prior-unanswered-stays-open: no answer leaves the finding open (breaks if an unanswered prior defaults to fixed)', () => {
  const out = settlePrior(prior, {}, { touches: () => true });
  assert.deepEqual(out.map((f) => f.status), ['open', 'open', 'open']);
  assert.equal(settlePrior(prior, undefined, { touches: () => true })[0].status, 'open');
  assert.equal(settlePrior(prior, { p1: 'still open' }, { touches: () => true })[0].status, 'open', 'only the exact answer "fixed" closes');
});

test('13.3 prior closed only on touched lines: a "fixed" answer for untouched lines is ignored (breaks if the touches check is removed)', () => {
  const touches = (f) => f.id === 'p1';
  const out = settlePrior(prior, { p1: 'fixed', p3: 'fixed' }, { touches });
  assert.equal(out.find((f) => f.id === 'p1').status, 'fixed');
  assert.equal(out.find((f) => f.id === 'p3').status, 'open');
});

test('a prior whose file is gone becomes stale; a closed prior is not reopened (breaks if exists is ignored or statuses are rewritten)', () => {
  const out = settlePrior([...prior, major('p4', { status: 'fixed' })], {}, { touches: () => false, exists: (f) => f !== 'gone.mjs' });
  assert.equal(out.find((f) => f.id === 'p2').status, 'stale');
  assert.equal(out.find((f) => f.id === 'p4').status, 'fixed');
});

test('settlePrior fails closed without a touches function (breaks if touches defaults to true)', () => {
  assert.throws(() => settlePrior(prior, { p1: 'fixed' }), /touches/);
});

test('a fixed prior does not count in majorsOpen of the next run (breaks if settled statuses are ignored)', () => {
  const settled = settlePrior([major('p1'), major('p3')], { p1: 'fixed' }, { touches: () => true });
  assert.deepEqual(majorsOpen(rec('r1', H2, settled)).map((f) => f.id), ['p3']);
});

// ---------- the funnel and the trace files (phase 1) ----------

test('buildFunnel counts raw, withdrawn, drops by reason and posted; no answer gives zeros (breaks if a count reads the wrong list)', () => {
  const answer = { findings: [{}, {}, {}], withdrawn: [{ id: 'w1' }, { id: 'w2' }] };
  const dropped = [{ reason: 'no-file' }, { reason: 'duplicate' }, { reason: 'no-file' }];
  assert.deepEqual(buildFunnel({ answer, dropped, kept: [{}] }), { raw: 3, withdrawn: 2, dropped: { byReason: { 'no-file': 2, duplicate: 1 } }, posted: 1 });
  assert.deepEqual(buildFunnel({ answer: null, dropped: [], kept: [] }), { raw: 0, withdrawn: 0, dropped: { byReason: {} }, posted: 0 });
  assert.equal(buildFunnel({ answer: { findings: [] }, dropped: [], kept: [] }).withdrawn, 0, 'an answer without a withdrawn list counts 0');
});

test('listRecords skips <runId>.trace.json beside a record: the trace is not a record (breaks if every .json file is read as a record)', () => {
  const root = tmp('trace');
  const written = writeRecord(rec('r1', H1, [major('a')]), { stateRoot: root });
  writeFileSync(written.path.replace(/.json$/, '.trace.json'), JSON.stringify({ runId: 'r1', filesRead: [] }));
  const got = listRecords({ branch: 'feat/x', head: H1 }, { stateRoot: root });
  assert.equal(got.records.length, 1);
  assert.deepEqual(got.unreadable, []);
  assert.equal(got.records[0].record.runId, 'r1');
});

// ---------- schema 2 ----------

/** A schema 1 record, as an old engine wrote it: no field of the schema 2 list. Written by hand, because writeRecord always stamps the current schema. */
function writeOldRecord(root, runId, head, findings, ts) {
  const dir = path.join(root, 'feat-x', head);
  mkdirSync(dir, { recursive: true });
  const body = { schema: 1, runId, branch: 'feat/x', head, status: 'ok', coverage: { complete: true }, findings, ts, majorsOpen: findings.length };
  writeFileSync(path.join(dir, `${runId}.json`), `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

test('RECORD_SCHEMA is 2 and RECORD_FIELDS names the schema 2 fields once each (breaks if the bump or a field name is dropped)', () => {
  assert.equal(REC.RECORD_SCHEMA, 2);
  assert.deepEqual([...REC.RECORD_FIELDS].sort(), [
    'armId', 'backend', 'contextVersion', 'cursorRunId', 'engineMainSha', 'impactRows', 'overallCorrectness', 'promptVersion', 'runIds', 'target', 'uncertainMajors', 'verify',
  ]);
  assert.equal(new Set(REC.RECORD_FIELDS).size, REC.RECORD_FIELDS.length);
  assert.throws(() => { REC.RECORD_FIELDS.push('x'); }, TypeError, 'the list is frozen');
});

test('a folder with a schema 1 and a schema 2 record at one head stays readable: listRecords lists both, majorsOpen unions them, lastReviewedSha finds the old head (breaks if a reader requires a schema 2 field)', () => {
  const root = tmp('mixed');
  writeOldRecord(root, 'old1', H1, [major('old-major')], '2026-11-02T10:00:01.000Z');
  const w = writeRecord(rec('new2', H1, [major('new-major')], { ts: '2026-11-13T10:00:00.000Z' }), { stateRoot: root });
  assert.equal(w.record.schema, 2);
  const got = listRecords({ branch: 'feat/x', head: H1 }, { stateRoot: root });
  assert.deepEqual(got.records.map((r) => r.record.schema), [1, 2]);
  assert.deepEqual(got.unreadable, []);
  assert.deepEqual(majorsOpen(got.records.map((r) => r.record)).map((f) => f.id).sort(), ['new-major', 'old-major']);
  assert.equal(w.record.majorsOpen, 2, 'the new record counts the schema 1 Major');
  assert.equal(lastReviewedSha({ branch: 'feat/x', head: H2, isAncestor: () => true }, { stateRoot: root }), H1);
  assert.equal(findRecord({ branch: 'feat/x', head: H1 }, { stateRoot: root }).runId, 'new2');
  assert.equal(findRecord({ branch: 'feat/x', head: H1, runId: 'old1', completeOnly: true }, { stateRoot: root }).schema, 1);
});

// ---------- majorsOpen under a lock ----------

test('writeRecord lists the earlier records, computes majorsOpen and renames inside the head-folder lock (breaks if any of the three runs outside withLock)', () => {
  const root = tmp('lock-order');
  writeRecord(rec('r1', H1, [major('x')]), { stateRoot: root });
  const events = [];
  const io = { readdirSync: (...a) => { events.push('list'); return readdirSync(...a); }, renameSync: (a, b) => { events.push('rename'); return realRename(a, b); } };
  const withLock = (file, o, fn) => {
    events.push(`enter:${path.dirname(file) === path.join(root, 'feat-x', H1) ? 'head' : file}`);
    const out = fn();
    events.push('exit');
    return out;
  };
  const w = writeRecord(rec('r2', H1, [major('y')]), { stateRoot: root, fs: io, withLock });
  assert.equal(events[0], 'enter:head', 'the lock sits in the head folder');
  assert.equal(events.at(-1), 'exit');
  assert.ok(events.includes('list') && events.includes('rename'));
  assert.equal(events.indexOf('list') > 0 && events.lastIndexOf('rename') < events.length - 1, true, 'the listing and the rename are between enter and exit');
  assert.equal(w.record.majorsOpen, 2);
});

test('a lock that stays held throws and writes nothing; a lock result of ok:false never lets the write through (breaks if { ok: false } is ignored)', () => {
  const root = tmp('lock-held');
  const held = () => ({ ok: false, reason: 'lock', detail: 'the lock is held by another session' });
  assert.throws(() => writeRecord(rec('r1', H1, [major('x')]), { stateRoot: root, withLock: held }), /lock/);
  assert.deepEqual(readdirSync(path.join(root, 'feat-x', H1)), [], 'no record and no temp file');
});

test('two writers at one head: the second waits for the first rename, then counts the first Major in majorsOpen (breaks if the listing happens outside the lock, so a concurrent writer misses the other Major)', () => {
  const root = tmp('lock-two');
  let second;
  let secondError = null;
  let fired = false;
  const io = {
    renameSync: (a, b) => {
      if (!fired) {
        fired = true;
        // The first writer holds the lock and has not renamed yet. A second writer at the same head must not get through.
        try { second = writeRecord(rec('r2', H1, [major('y')]), { stateRoot: root, lockWaitMs: 40 }); } catch (err) { secondError = err; }
      }
      return realRename(a, b);
    },
  };
  const first = writeRecord(rec('r1', H1, [major('x')]), { stateRoot: root, fs: io });
  assert.equal(second, undefined, 'the second writer did not write while the first held the lock');
  assert.match(String(secondError?.message), /lock/);
  assert.equal(first.record.majorsOpen, 1);
  const retry = writeRecord(rec('r2', H1, [major('y')]), { stateRoot: root });
  assert.equal(retry.record.majorsOpen, 2, 'after the first rename the second writer sees the first Major');
  assert.deepEqual(readdirSync(path.join(root, 'feat-x', H1)).sort(), ['r1.json', 'r2.json']);
});

// ---------- majorsOpen is the union at a head ----------

test('the stored majorsOpen is the union over every record at the head, whatever its arm or target, so it equals majorsOpen(list) (breaks if a filter on the arm or the target comes back: the stored count and the reader would then disagree)', () => {
  const root = tmp('union');
  const range = { range: `${H2}..${H1}` };
  const w = (id, extra, findings) => writeRecord(rec(id, H1, findings, extra), { stateRoot: root }).record.majorsOpen;
  assert.equal(w('r1', { target: range, armId: 'arm-a' }, [major('x')]), 1);
  assert.equal(w('r2', { target: range, armId: 'arm-b' }, [major('y'), major('z')]), 3, 'arm-b counts the Major of arm-a at the same head');
  assert.equal(w('r3', { target: range, armId: 'arm-a' }, [major('w')]), 4);
  assert.equal(w('r4', { target: { pr: 7 } }, [major('v')]), 5);
  const list = listRecords({ branch: 'feat/x', head: H1 }, { stateRoot: root }).records.map((r) => r.record);
  assert.equal(majorsOpen(list).length, 5);
  assert.equal(list.at(-1).majorsOpen, majorsOpen(list).length, 'the last stored count agrees with the reader');
});

// ---------- error texts hold no home folder path ----------

test('a held record lock throws a message that names the home folder as ~, never the user home path, also inside the lock detail (breaks if the error prints the full path)', () => {
  const home = os.homedir();
  const root = path.join(home, '.lr-never-made', 'local-review');
  const held = () => ({ ok: false, reason: 'lock', detail: `the lock ${path.join(root, 'feat-x', H1, 'records.lock')} is held by another session` });
  let message = '';
  try { writeRecord(rec('r1', H1, [major('x')]), { stateRoot: root, withLock: held, fs: { mkdirSync: () => {} } }); } catch (err) { message = err.message; }
  assert.match(message, /record lock at .* is not free/);
  assert.ok(!message.includes(home), message);
  assert.ok(!message.includes(home.replaceAll('\\', '/')), message);
  assert.ok(message.includes('~/.lr-never-made/local-review/feat-x/'), message);
});

test('homeRel turns a home folder path into ~/..., in either slash form, and leaves other text alone (breaks if the helper stops matching a form)', () => {
  const home = os.homedir();
  assert.equal(REC.homeRel(path.join(home, '.claude', 'state')), '~/.claude/state');
  assert.equal(REC.homeRel(`${home.replaceAll('\\', '/')}/x/y`), '~/x/y');
  assert.equal(REC.homeRel('no path here'), 'no path here');
  assert.equal(REC.homeRel(`a ${path.join(home, 'p')} b ${path.join(home, 'q')}`), 'a ~/p b ~/q');
});
