// Tests for scripts/scheduled/backup-state-lib.mjs (card ops-state-backup-nightly). Pure helpers: no database, no Notion, no clock.
// Design: .claudedocs/e2e-ops-state-backup-nightly/00-design-note.md (sections 4, 5 and 7).
//
// How the helpers can fail, one test each:
//   U1  a file up to 18 MiB goes single-part and a bigger one multi-part (Notion: single-part up to 20 MB, parts 5 to 20 MiB)
//   U2  the parts do not cover the file exactly once, a part other than the last is not 10 MiB, or parts are not numbered from 1
//   U3  an empty file, a file over the workspace limit, or a size that is not a whole number is not refused
//   R1  retention keeps fewer or more than the 14 newest rows
//   R2  a weekly row inside 8 weeks is trashed, or one outside 8 weeks is kept
//   R3  a row is trashed although no newer row has Status ok and Drill pass (a backup that was never proved)
//   R4  the proving row is older than the candidate (a newer row must prove an older one, never the reverse)
//   R5  a row of another owner (Task is not CCV3-State-Backup) is trashed
//   R6  the newest proved row is trashed
//   R7  a row with no date or a bad date is trashed
//   M1  a url password, a Notion token, a Bearer value or a given secret shows in the masked text
//   M2  the masked text is not cut to 600 characters, keeps newlines, or a short secret ("abc") blanks ordinary words
import { test } from 'node:test';
import assert from 'node:assert/strict';

const lib = () => import('./backup-state-lib.mjs'); // dynamic: a missing module fails each test, not the whole file
const MiB = 1024 * 1024;

test('U1 up to 18 MiB is single-part, above it multi-part', async () => {
  // Breaks when the threshold moves above 20 MB (Notion refuses a single-part file over 20 MB) or the live dump size (10.6 MB) goes multi.
  const { planUpload } = await lib();
  assert.equal(planUpload(10_636_108).mode, 'single');
  assert.equal(planUpload(18 * MiB).mode, 'single');
  assert.equal(planUpload(18 * MiB + 1).mode, 'multi');
});

test('U2 multi-part: contiguous parts of 10 MiB, numbered from 1, the last part holds the rest', async () => {
  // Breaks when a byte is dropped or sent twice, a middle part is not 10 MiB (Notion: 5 to 20 MiB except the last), or numbering starts at 0.
  const { planUpload } = await lib();
  const p = planUpload(45 * MiB);
  assert.equal(p.mode, 'multi');
  assert.equal(p.parts.length, 5);
  assert.deepEqual(p.parts.map((x) => x.n), [1, 2, 3, 4, 5]);
  let at = 0;
  for (const part of p.parts) { assert.equal(part.start, at); at = part.end; }
  assert.equal(at, 45 * MiB);
  for (const part of p.parts.slice(0, -1)) assert.equal(part.end - part.start, 10 * MiB);
  const tiny = planUpload(20 * MiB + 1);
  assert.equal(tiny.parts.length, 3);
  assert.equal(tiny.parts.at(-1).end - tiny.parts.at(-1).start, 1, 'the last part may be under 5 MiB');
});

test('U3 an empty file, a file over the workspace limit and a bad size are refused', async () => {
  // Breaks when 0 bytes uploads an empty file as a good backup, the workspace limit is ignored, or a float or NaN goes through.
  const { planUpload } = await lib();
  assert.deepEqual(planUpload(0), { error: 'empty' });
  assert.deepEqual(planUpload(5 * MiB + 1, { maxBytes: 5 * MiB }), { error: 'over-limit' });
  assert.equal(planUpload(5 * MiB, { maxBytes: 5 * MiB }).mode, 'single');
  for (const bad of [1.5, NaN, -3, '10']) assert.throws(() => planUpload(bad), /whole number/);
});

const NOW = '2026-11-24';
const TASK = 'CCV3-State-Backup';
const day = (offset) => new Date(Date.parse(`${NOW}T12:00:00Z`) - offset * 86_400_000).toISOString().slice(0, 10);
const row = (offset, extra = {}) => ({ id: `r-${day(offset)}`, date: day(offset), kind: 'nightly', status: 'ok', drill: 'pass', task: TASK, ...extra });
const nightlies = (n) => Array.from({ length: n }, (_, i) => row(i));

test('R1 keeps the 14 newest rows and trashes the older nightly rows', async () => {
  // Breaks when the window is 13 or 15 rows, or the newest are not chosen by date.
  const { chooseRetention } = await lib();
  const rows = nightlies(30);
  const r = chooseRetention(rows, { now: NOW });
  assert.equal(r.keep.length, 14);
  assert.equal(r.trash.length, 16);
  assert.ok(r.keep.includes(`r-${day(13)}`) && !r.keep.includes(`r-${day(14)}`));
  assert.equal(r.keep.length + r.trash.length, rows.length, 'every row is kept or trashed, none is lost');
});

test('R2 keeps a weekly row for 8 weeks and trashes an older one', async () => {
  // Breaks when the weekly window is 7 or 9 weeks, or weekly rows are treated as nightly rows.
  const { chooseRetention } = await lib();
  const rows = [...nightlies(20), row(44, { kind: 'weekly' }), row(56, { kind: 'weekly' }), row(58, { kind: 'weekly' })];
  const r = chooseRetention(rows, { now: NOW });
  assert.ok(r.keep.includes(`r-${day(44)}`), '44 days old: kept');
  assert.ok(r.keep.includes(`r-${day(56)}`), '56 days old (8 weeks): kept');
  assert.ok(r.trash.includes(`r-${day(58)}`), '58 days old: trashed');
});

test('R3 nothing is trashed while no newer row has Status ok and Drill pass', async () => {
  // Breaks when the drill result is not part of the rule: old backups would go while the new ones were never proved.
  const { chooseRetention } = await lib();
  for (const bad of [{ drill: 'fail' }, { drill: 'not-run' }, { status: 'upload-failed:dump' }]) {
    const rows = nightlies(30).map((x) => ({ ...x, ...bad }));
    assert.deepEqual(chooseRetention(rows, { now: NOW }).trash, [], JSON.stringify(bad));
  }
  // one proved row, the newest: now every older row outside the window may go
  const one = nightlies(30).map((x, i) => (i === 0 ? x : { ...x, drill: 'fail' }));
  assert.equal(chooseRetention(one, { now: NOW }).trash.length, 16);
});

test('R4 only a NEWER proved row lets an older row go', async () => {
  // Breaks when the proof is searched in all rows: an old good row would prove its own successors.
  const { chooseRetention } = await lib();
  const rows = nightlies(30).map((x, i) => (i < 20 ? { ...x, drill: 'fail' } : x)); // the 10 oldest pass, the 20 newest fail
  const r = chooseRetention(rows, { now: NOW });
  // rows 14..19 are outside the window but NEWER than every passing row (20..29): no newer proof, so they stay
  for (let i = 14; i <= 19; i += 1) assert.ok(r.keep.includes(`r-${day(i)}`) && !r.trash.includes(`r-${day(i)}`), `row ${i} stays`);
  // row 20 is the newest passing row: no newer proof, stays; rows 21..29 have it as a newer proof and go
  assert.ok(!r.trash.includes(`r-${day(20)}`), 'the newest passing row stays');
  for (let i = 21; i <= 29; i += 1) assert.ok(r.trash.includes(`r-${day(i)}`), `row ${i} goes`);
});

test('R5 a row of another owner is never trashed', async () => {
  // Breaks when the owner mark is not read: a row made by a person or another job could be trashed.
  const { chooseRetention } = await lib();
  const rows = [...nightlies(30), row(40, { id: 'foreign', task: 'someone-else' }), row(41, { id: 'no-task', task: undefined })];
  const r = chooseRetention(rows, { now: NOW });
  assert.ok(!r.trash.includes('foreign') && !r.trash.includes('no-task'));
  assert.ok(r.keep.includes('foreign') && r.keep.includes('no-task'));
});

test('R6 the newest proved row is never trashed', async () => {
  // Breaks when the newest proved row falls out of the window and nothing guards it.
  const { chooseRetention } = await lib();
  const rows = nightlies(30).map((x, i) => (i < 20 ? { ...x, status: 'upload-failed:dump', drill: 'not-run' } : x));
  const r = chooseRetention(rows, { now: NOW });
  assert.ok(!r.trash.includes(`r-${day(20)}`));
  assert.ok(r.keep.includes(`r-${day(20)}`));
});

test('R7 a row with no date or a bad date is kept', async () => {
  // Breaks when a malformed row is trashed (it cannot be placed in the window).
  const { chooseRetention } = await lib();
  const rows = [...nightlies(30), { id: 'no-date', kind: 'nightly', status: 'ok', drill: 'pass', task: TASK }, { id: 'bad-date', date: '2026-13-45', kind: 'nightly', status: 'ok', drill: 'pass', task: TASK }];
  const r = chooseRetention(rows, { now: NOW });
  assert.ok(r.keep.includes('no-date') && r.keep.includes('bad-date'));
  assert.ok(!r.trash.includes('no-date') && !r.trash.includes('bad-date'));
});

test('R8 rows of another owner do not take the 14 newest slots of our rows', async () => {
  // Breaks when the window counts every row: 14 newer foreign rows would push our own rows out and a newer proved row of ours would trash them.
  const { chooseRetention } = await lib();
  const foreign = Array.from({ length: 14 }, (_, i) => row(i, { id: `f${i}`, task: 'someone-else' }));
  const ours = [row(20), row(21), row(22)]; // 3 rows of ours: all inside our own 14 newest
  const r = chooseRetention([...foreign, ...ours], { now: NOW });
  assert.deepEqual(r.trash, [], 'our 3 rows are within our own 14 newest: none is trashed');
  assert.equal(r.keep.length, 17);
});

test('M1 maskText hides a url password, a Notion token, a Bearer value and a given secret', async () => {
  // Breaks when one of the four patterns is dropped: a failure row is shown in Notion and a local log.
  const { maskText } = await lib();
  const text = 'connect postgresql://claude:s3cretPw@db:5432/x failed; token secret_AbC123xyz987 and ntn_ZzZ999aaa111; Authorization: Bearer abcDEF123456; also MySecretValue99';
  const out = maskText(text, { secrets: ['MySecretValue99'] });
  for (const leak of ['s3cretPw', 'secret_AbC123xyz987', 'ntn_ZzZ999aaa111', 'abcDEF123456', 'MySecretValue99']) assert.equal(out.includes(leak), false, `${leak} in: ${out}`);
});

test('M2 maskText collapses whitespace, cuts to 600 characters and ignores a short secret', async () => {
  // Breaks when the cut is dropped (a huge log goes into a Notion cell), newlines stay, or a 3-letter secret blanks the word "abc" everywhere.
  const { maskText } = await lib();
  assert.equal(maskText('a\n\n  b\t c'), 'a b c');
  assert.equal(maskText('x'.repeat(2000)).length, 600);
  assert.equal(maskText('abc abc', { secrets: ['abc'] }), 'abc abc');
  assert.equal(maskText(undefined), '');
});
