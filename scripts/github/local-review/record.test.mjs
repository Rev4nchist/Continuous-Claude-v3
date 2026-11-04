// Tests for scripts/github/local-review/record.mjs. Every test names the source change that would break it.
// Run: node --test scripts/github/local-review/record.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync as realRename, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
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
  assert.equal(JSON.parse(readFileSync(w.path, 'utf8')).schema, 1);
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
