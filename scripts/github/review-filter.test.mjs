// Tests for scripts/github/review-filter.mjs. Every test names the source change that would break it.
// Run: node --test scripts/github/review-filter.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  absenceClaims, dedupe, definesName, filterFindings, findingId, isStrippedFile, main, mapLine, NEVER_SUPPRESS, normTitle, parseHunks, rangeTouched, stripIgnoreFiles,
} from './review-filter.mjs';

const made = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'review-filter-test-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A review tree: { 'rel/path': 'text' }. */
function tree(files) {
  const dir = tmp();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const finding = (o = {}) => ({ file: 'src/a.mjs', startLine: 2, endLine: 2, title: 'Wrong result', body: 'It is wrong.', severity: 'major', category: 'correctness', bucket: 'actionable', confidence: 4, ...o });
const never = () => { throw new Error('grep must not run'); };
const run = (raw, dir, extra = {}) => filterFindings([].concat(raw), { treeDir: dir, grep: () => [], ...extra });

// ---- spec 6 row 10 ----

// Breaks if checkFile stops testing the path (absence, absolute, "..", excluded, engine file) or the order puts no-line first.
test('drop-no-file: an absent, absolute, escaping, excluded or engine path is dropped with reason no-file', () => {
  const dir = tree({ 'src/a.mjs': lines(5), '.review/CONTEXT.md': 'x', 'PR.diff': 'x', 'artifacts/o.mjs': lines(3) });
  const cases = {
    absent: 'src/missing.mjs',
    absolute: path.resolve(dir, 'src/a.mjs'),
    posixAbsolute: '/etc/passwd',
    escape: '../outside.mjs',
    excluded: 'artifacts/o.mjs',
    engineFile: '.review/CONTEXT.md',
    prDiff: 'PR.diff',
  };
  for (const [name, file] of Object.entries(cases)) {
    const r = run(finding({ file, startLine: 0 }), dir);
    assert.equal(r.kept.length, 0, name);
    assert.equal(r.dropped[0]?.reason, 'no-file', `${name}: no-file comes before no-line`);
    assert.ok(r.dropped[0].evidence.length > 0, name);
  }
});

test('drop-no-file: a finding that is not an object is dropped, not thrown on', () => {
  const r = filterFindings([null, 'text', 7], { treeDir: tree({}), grep: () => [] });
  assert.deepEqual(r.dropped.map((d) => d.reason), ['no-file', 'no-file', 'no-file']);
});

// ---- spec 6 row 11 ----

// Breaks if the EOF compare or the "below 1" compare is removed, or countLines counts the \r or the empty tail line.
test('drop-no-line: a start line below 1 or past EOF is dropped, the last line is kept, CRLF and a final newline do not add a line', () => {
  const dir = tree({ 'src/a.mjs': 'a\r\nb\r\nc\r\n', 'src/b.mjs': 'one\ntwo' });
  const at = (file, startLine) => run(finding({ file, startLine, endLine: startLine }), dir);
  assert.equal(at('src/a.mjs', 3).kept.length, 1, 'line 3 of 3 stays');
  assert.equal(at('src/a.mjs', 4).dropped[0]?.reason, 'no-line', 'line 4 of a 3-line CRLF file');
  assert.equal(at('src/a.mjs', 0).dropped[0]?.reason, 'no-line');
  assert.equal(at('src/b.mjs', 2).kept.length, 1, 'no final newline');
  assert.equal(at('src/b.mjs', 3).dropped[0]?.reason, 'no-line');
  const noLine = run(finding({ startLine: undefined }), dir);
  assert.equal(noLine.dropped[0]?.reason, 'no-line', 'a missing line');
});

// Breaks if the endLine clamp is removed.
test('no-line: endLine is clamped to EOF and to startLine, never dropped', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  assert.equal(run(finding({ startLine: 4, endLine: 99 }), dir).kept[0].endLine, 5);
  assert.equal(run(finding({ startLine: 4, endLine: 2 }), dir).kept[0].endLine, 4);
});

// ---- inDiff (rule 3) ----

const DIFF = ['diff --git a/src/a.mjs b/src/a.mjs', '--- a/src/a.mjs', '+++ b/src/a.mjs', '@@ -2,2 +2,3 @@', ' line 2', '+added', ' line 3', ''].join('\n');

// Breaks if inDiff stops being recomputed from the hunks (the model's own inDiff:true would survive) or the style rule is removed.
test('inDiff is recomputed: off the diff becomes outside_diff, an off-diff style finding becomes nitpick, an in-diff outside_diff becomes actionable', () => {
  const dir = tree({ 'src/a.mjs': lines(10) });
  const hunks = parseHunks(DIFF);
  const at = (o) => run(finding(o), dir, { hunks }).kept[0];
  assert.equal(at({ startLine: 3, endLine: 3, inDiff: false }).inDiff, true);
  assert.equal(at({ startLine: 9, endLine: 9, inDiff: true }).inDiff, false);
  assert.equal(at({ startLine: 9, endLine: 9 }).bucket, 'outside_diff');
  assert.equal(at({ startLine: 9, endLine: 9, category: 'maintainability', severity: 'minor' }).bucket, 'nitpick');
  assert.equal(at({ startLine: 3, endLine: 3, category: 'maintainability', severity: 'trivial' }).bucket, 'nitpick', 'a style finding in the diff');
  assert.equal(at({ startLine: 3, endLine: 3, bucket: 'outside_diff' }).bucket, 'actionable');
  assert.equal(at({ startLine: 1, endLine: 3 }).inDiff, true, 'a range that overlaps the hunk');
});

// ---- spec 6 row 12 ----

// Breaks if a grep hit is ignored.
test('claim-refuted-drops: a hit on the claimed name elsewhere drops the finding with the hit as evidence', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  const grep = (x) => (x === 'helperFn' ? ['src/b.mjs:7:export function helperFn() {}'] : []);
  const f = finding({ body: 'The call fails because `helperFn` is not defined.' });
  const r = filterFindings([f], { treeDir: dir, grep });
  assert.equal(r.kept.length, 0);
  assert.equal(r.dropped[0].reason, 'claim-refuted');
  assert.match(r.dropped[0].evidence, /helperFn.*src\/b\.mjs:7/);
});

// Breaks if the path-exists check is removed (the injected grep throws, so only the path check can drop it).
test('claim-refuted-drops: a claimed path that exists drops the finding before any grep runs', () => {
  const dir = tree({ 'src/a.mjs': lines(5), 'lib/real.mjs': 'x' });
  const f = finding({ title: '`lib/real.mjs` does not exist' });
  const r = filterFindings([f], { treeDir: dir, grep: never });
  assert.equal(r.dropped[0]?.reason, 'claim-refuted');
});

// Breaks if a claim with no hit is dropped, or if a plain finding runs a grep.
test('claim-refuted: no hit keeps the finding, and a finding with no claim never calls grep', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  const claim = finding({ body: '`ghostFn` is undefined here.' });
  assert.equal(run(claim, dir).kept.length, 1);
  assert.equal(filterFindings([finding()], { treeDir: dir, grep: never }).kept.length, 1);
});

// Breaks if the cited-line exclusion is removed: the only hit is the call the finding complains about.
test('claim-refuted: a hit on the finding\'s own cited lines does not refute the claim', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  const f = finding({ startLine: 2, endLine: 3, body: '`ghostFn` is not defined.' });
  const grep = () => ['src/a.mjs:2:ghostFn();'];
  assert.equal(filterFindings([f], { treeDir: dir, grep }).kept.length, 1);
  const elsewhere = () => ['src/a.mjs:4:function ghostFn() {}'];
  assert.equal(filterFindings([f], { treeDir: dir, grep: elsewhere }).dropped[0]?.reason, 'claim-refuted');
});

// Breaks if absenceClaims matches another phrase, drops the "()" , or reads a spaced span as a name.
test('absenceClaims: reads the backticked name before each absence phrase, once', () => {
  const text = '`a.b` does not exist. `go()` is not defined. `x y` is undefined. `a.b` is undefined. No such file: `q` does not exist? `m` has no such function.';
  assert.deepEqual(absenceClaims(text).sort(), ['a.b', 'go', 'q'].sort());
  assert.deepEqual(absenceClaims('`z` is missing'), []);
  assert.deepEqual(absenceClaims(null), []);
});

// ---- spec 6 row 13 ----

// Breaks if the catch returns a drop.
test('grep-error-keeps: a grep that throws keeps the finding and adds a problem', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  const grep = () => { throw new Error('git exploded'); };
  const r = filterFindings([finding({ body: '`ghostFn` is not defined.' })], { treeDir: dir, grep });
  assert.equal(r.kept.length, 1);
  assert.equal(r.dropped.length, 0);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /ghostFn.*git exploded/);
});

// Breaks if defaultGrep searches non-logic files (PR.diff holds the claimed name only in a removed line), drops -w, or reads a git error as "no hit".
test('default grep (real git): finds a name in a logic file, ignores PR.diff, honours -w, and keeps the finding when git fails', () => {
  const dir = tree({ 'src/a.mjs': lines(5), 'src/b.mjs': 'export function helperFn() {}\nconst helperFnExtra = 1;\n', 'PR.diff': '-function ghostFn() {}\n', 'notes.md': 'wordOnlyInMd' });
  const dropsOn = (name) => filterFindings([finding({ body: `\`${name}\` is not defined.` })], { treeDir: dir }).dropped.length;
  assert.equal(dropsOn('helperFn'), 1, 'a hit in a .mjs file');
  assert.equal(dropsOn('helperFnExtra'), 1);
  assert.equal(dropsOn('helper'), 0, '-w: "helper" is only a part of a word');
  assert.equal(dropsOn('ghostFn'), 0, 'PR.diff is not searched');
  assert.equal(dropsOn('wordOnlyInMd'), 0, 'only logic extensions are searched');
  const gone = filterFindings([finding({ body: '`helperFn` is not defined.' })], { treeDir: dir, exts: ['mjs'], grep: (x, o) => { throw new Error(`cwd ${o.treeDir}`); } });
  assert.equal(gone.kept.length, 1);
});

// ---- spec 6 row 14 ----

// Breaks if NEVER_SUPPRESS is skipped when threading, or if rules 1/2/4 stop applying to such a finding.
test('never-suppress-security: a low-confidence security finding still gets thread:true, a plain one does not, and rules 1 and 2 still drop it (rule 4 keeps it, see claim-refuted-never-suppress)', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  const low = { confidence: 1 };
  const kept = (o) => run(finding({ ...low, ...o }), dir).kept[0];
  assert.equal(kept({ category: 'security' }).thread, true);
  assert.equal(kept({ title: 'Possible SQL injection in query builder' }).thread, true);
  assert.equal(kept({ category: 'correctness', title: 'Off by one' }).thread, false);
  assert.equal(run(finding({ ...low, category: 'security', file: 'src/none.mjs' }), dir).dropped[0].reason, 'no-file');
  assert.equal(run(finding({ ...low, category: 'security', startLine: 50 }), dir).dropped[0].reason, 'no-line');
  for (const t of ['secret', 'injection', 'null deref', 'infinite loop', 'leak', 'validation']) assert.ok(NEVER_SUPPRESS.titlePattern.test(`A ${t} here`), t);
});

// Breaks if the default confidence is below the thread threshold, or if the threshold compare becomes strict.
test('thread: a missing confidence counts as 3 and threads; 2 does not; the threshold is inclusive', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  const f = (confidence) => { const x = finding(); if (confidence === undefined) delete x.confidence; else x.confidence = confidence; return x; };
  assert.equal(run(f(undefined), dir).kept[0].thread, true);
  assert.equal(run(f(3), dir).kept[0].thread, true);
  assert.equal(run(f(2), dir).kept[0].thread, false);
  assert.equal(run(f(2), dir, { threadMin: 2 }).kept[0].thread, true);
});

// ---- duplicate (rule 5) ----

// Breaks if dedupe keeps the first finding instead of the higher severity, or the ±3 window changes.
test('duplicate: lines within 3 with the same category keep the higher severity; 4 lines apart are both kept', () => {
  const dir = tree({ 'src/a.mjs': lines(20) });
  const minor = finding({ startLine: 5, endLine: 5, title: 'Minor thing', severity: 'minor' });
  const major = finding({ startLine: 8, endLine: 8, title: 'Other thing', severity: 'major' });
  const r = run([minor, major], dir);
  assert.deepEqual(r.kept.map((f) => f.severity), ['major']);
  assert.equal(r.dropped[0].reason, 'duplicate');
  assert.equal(r.dropped[0].finding.severity, 'minor');
  assert.match(r.dropped[0].evidence, new RegExp(r.kept[0].id));
  const far = run([minor, { ...major, startLine: 9, endLine: 9 }], dir);
  assert.equal(far.kept.length, 2);
});

// Breaks if the title branch of "same category or title" is removed, or if different files are merged.
test('duplicate: the same title in another category counts; another file or another category and title do not', () => {
  const dir = tree({ 'src/a.mjs': lines(20), 'src/b.mjs': lines(20) });
  const a = finding({ title: 'Null check missing', category: 'stability' });
  const sameTitle = finding({ startLine: 3, endLine: 3, title: 'null check, missing!', category: 'correctness', severity: 'minor' });
  assert.equal(run([a, sameTitle], dir).kept.length, 1);
  assert.equal(run([a, { ...sameTitle, file: 'src/b.mjs' }], dir).kept.length, 2);
  assert.equal(run([a, { ...sameTitle, title: 'Different', category: 'performance' }], dir).kept.length, 2);
});

// Breaks if a NEVER_SUPPRESS finding can be folded into a plain finding of higher severity.
test('duplicate: a security finding is not folded into a non-security finding', () => {
  const dir = tree({ 'src/a.mjs': lines(20) });
  const sec = finding({ title: 'Token printed', category: 'security', severity: 'minor' });
  const crit = finding({ startLine: 3, endLine: 3, title: 'Crash', category: 'security', severity: 'critical' });
  const plain = finding({ startLine: 3, endLine: 3, title: 'Token printed', category: 'stability', severity: 'critical' });
  assert.equal(run([sec, plain], dir).kept.length, 2);
  assert.equal(run([sec, crit], dir).kept.length, 1, 'two security findings still fold');
});

test('dedupe: returns kept in input order and takes the higher confidence on a severity tie', () => {
  const f = (id, confidence) => ({ id, file: 'a', startLine: 1, title: 't', category: 'c', severity: 'major', confidence });
  const r = dedupe([f('low', 2), f('x', 5)].map((x, i) => (i === 0 ? x : { ...x, file: 'z' })).concat([f('high', 5)]));
  assert.deepEqual(r.kept.map((k) => k.id), ['x', 'high']);
  assert.equal(r.dropped[0].finding.id, 'low');
});

// ---- diff parsing ----

const CRLF_DIFF = ['diff --git a/src/a.mjs b/src/a.mjs', 'index 1..2 100644', '--- a/src/a.mjs', '+++ b/src/a.mjs', '@@ -1,3 +1,4 @@', ' keep', '-old', '+new', '+extra', ' tail', '@@ -20 +21,2 @@ fn', ' x', '+y', 'diff --git a/m.sh b/m.sh', 'old mode 100644', 'new mode 100755', 'diff --git a/o.mjs b/r.mjs', 'similarity index 100%', 'rename from o.mjs', 'rename to r.mjs', ''].join('\r\n');

// Breaks if parseHunks splits on "\n" only: the \r stays in the key of a mode-only or rename-only entry (no +++ line to fix it).
test('crlf-hunks: a diff with \\r\\n line ends parses to clean paths and exact line numbers', () => {
  const h = parseHunks(CRLF_DIFF);
  assert.deepEqual([...h.keys()], ['src/a.mjs', 'm.sh', 'r.mjs']);
  assert.equal(h.get('r.mjs').oldFile, 'o.mjs');
  const [first, second] = h.get('src/a.mjs').hunks;
  assert.deepEqual([first.oldStart, first.oldLines, first.newStart, first.newLines], [1, 3, 1, 4]);
  assert.deepEqual(first.lines.filter((l) => l.t === '+').map((l) => l.new), [2, 3]);
  assert.deepEqual(first.lines.find((l) => l.t === '-'), { t: '-', old: 2 });
  assert.deepEqual([second.oldStart, second.oldLines, second.newStart, second.newLines], [20, 1, 21, 2]);
  assert.equal(parseHunks(CRLF_DIFF.replaceAll('\r\n', '\n')).get('src/a.mjs').hunks.length, 2, 'LF gives the same result');
});

// Breaks if hunk ends are decided by line prefix instead of the counts.
test('parseHunks: a removed line that reads "-- x" is content, not a file header; renames, deletions and quoted paths are keyed right', () => {
  const diff = [
    'diff --git a/s.sql b/s.sql', '--- a/s.sql', '+++ b/s.sql', '@@ -1,2 +1,1 @@', '--- a comment', ' keep',
    'diff --git a/old.mjs b/new.mjs', 'similarity index 90%', 'rename from old.mjs', 'rename to new.mjs', '--- a/old.mjs', '+++ b/new.mjs', '@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file',
    'diff --git a/gone.mjs b/gone.mjs', 'deleted file mode 100644', '--- a/gone.mjs', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y',
    'diff --git "a/caf\\303\\251.mjs" "b/caf\\303\\251.mjs"', '--- "a/caf\\303\\251.mjs"', '+++ "b/caf\\303\\251.mjs"', '@@ -1 +1 @@', '-1', '+2', '',
  ].join('\n');
  const h = parseHunks(diff);
  assert.deepEqual([...h.keys()], ['s.sql', 'new.mjs', 'gone.mjs', 'café.mjs']);
  assert.equal(h.get('s.sql').hunks[0].lines[0].t, '-');
  assert.equal(h.get('new.mjs').oldFile, 'old.mjs');
  assert.equal(h.get('gone.mjs').hunks[0].newLines, 0);
  assert.equal(parseHunks('').size, 0);
});

// Breaks if the offset sums skip a hunk, an inserted-only hunk is mis-based, or a removed line maps to a number.
test('mapLine: shifts lines after a hunk, maps context, and marks changed or removed lines touched', () => {
  const h = parseHunks(CRLF_DIFF);
  assert.deepEqual(mapLine(h, 'src/a.mjs', 1), { line: 1, touched: false }, 'context line');
  assert.deepEqual(mapLine(h, 'src/a.mjs', 2), { line: null, touched: true }, 'removed line');
  assert.deepEqual(mapLine(h, 'src/a.mjs', 3), { line: 4, touched: false }, 'context after the change');
  assert.deepEqual(mapLine(h, 'src/a.mjs', 10), { line: 11, touched: false }, 'between hunks: +1 from the first');
  assert.deepEqual(mapLine(h, 'src/a.mjs', 20), { line: 21, touched: false }, 'context inside the second hunk');
  assert.deepEqual(mapLine(h, 'src/a.mjs', 30), { line: 32, touched: false }, 'after both hunks: +2');
  assert.deepEqual(mapLine(h, 'src/other.mjs', 5), { line: 5, touched: false }, 'untouched file');
  const insert = parseHunks('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -4,0 +5,2 @@\n+p\n+q\n');
  assert.deepEqual(mapLine(insert, 'f', 4), { line: 4, touched: false });
  assert.deepEqual(mapLine(insert, 'f', 5), { line: 7, touched: false });
  assert.deepEqual(mapLine(h, 'old/path.mjs', 5), { line: 5, touched: false });
  const renamed = parseHunks('diff --git a/o b/n\nrename from o\nrename to n\n--- a/o\n+++ b/n\n@@ -1 +1,2 @@\n+z\n k\n');
  assert.deepEqual(mapLine(renamed, 'o', 1), { line: 2, touched: false }, 'looked up by the old path');
});

// ---- ids ----

// Breaks if the id includes the body, drops the file or line, or stops folding case and punctuation in the title.
test('id: sha1(file|startLine|normTitle) as 16 hex, stable across title case and punctuation', () => {
  const a = findingId({ file: 'a.mjs', startLine: 3, title: 'Null  check, missing!' });
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, findingId({ file: 'a.mjs', startLine: 3, title: 'null check missing' }));
  assert.notEqual(a, findingId({ file: 'a.mjs', startLine: 4, title: 'null check missing' }));
  assert.notEqual(a, findingId({ file: 'b.mjs', startLine: 3, title: 'null check missing' }));
  assert.equal(normTitle('  A--B  c '), 'a b c');
  const dir = tree({ 'src/a.mjs': lines(5) });
  assert.equal(run(finding({ id: 'model-made-up' }), dir).kept[0].id, findingId(finding()), 'the model id is replaced');
});

test('prior: a kept finding with a prior id inherits that firstSeenSha', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  const prior = [{ id: findingId(finding()), firstSeenSha: 'a'.repeat(40) }];
  assert.equal(run(finding(), dir, { prior }).kept[0].firstSeenSha, 'a'.repeat(40));
  assert.equal(run(finding(), dir).kept[0].firstSeenSha, undefined);
});

// ---- CLI ----

function cliFiles() {
  const dir = tree({ 'src/a.mjs': lines(5), 'PR.diff': DIFF });
  const findings = path.join(tmp(), 'f.json');
  const bad = [finding({ file: 'scripts/github/lib/nope.mjs', startLine: 3, title: 'Cites an absent file' }), finding({ title: 'Fine' })];
  writeFileSync(findings, JSON.stringify({ findings: bad }));
  return { dir, findings, badId: findingId(bad[0]) };
}

// Breaks if main prints a different prefix or reason (the prove-check rows match "^DROP no-file ").
test('main: prints one "DROP <reason> <id>" line per drop and reads PR.diff from the tree', () => {
  const { dir, findings, badId } = cliFiles();
  const out = [];
  const code = main(['--findings', findings, '--tree', dir], { stdout: (s) => out.push(s), grep: () => [] });
  assert.equal(code, 0);
  assert.deepEqual(out, [`DROP no-file ${badId}`]);
});

test('main: bad arguments or unreadable JSON exit 2 and print nothing on stdout', () => {
  const out = [];
  const err = [];
  const deps = { stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
  assert.equal(main(['--tree', 'x'], deps), 2);
  assert.equal(main(['--findings', 'nope.json', '--tree', 'x'], deps), 2);
  assert.equal(main(['--bogus'], deps), 2);
  assert.deepEqual(out, []);
  assert.equal(err.length, 3);
});

test('main --json: prints the whole result', () => {
  const { dir, findings } = cliFiles();
  const out = [];
  main(['--findings', findings, '--tree', dir, '--json'], { stdout: (s) => out.push(s), grep: () => [] });
  const r = JSON.parse(out.join('\n'));
  assert.equal(r.kept.length, 1);
  assert.equal(r.dropped[0].reason, 'no-file');
});

// The end-to-end form: the script as the harness runs it.
test('CLI e2e: node scripts/github/review-filter.mjs prints the DROP line and exits 0', () => {
  const { dir, findings, badId } = cliFiles();
  const script = fileURLToPath(new URL('./review-filter.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--findings', findings, '--tree', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `DROP no-file ${badId}`);
});

// ---- review findings on the P1 build ----

const diffOf = (file, newLines) => [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${newLines} @@`, ...Array.from({ length: newLines }, (_, i) => `+x${i}`), ''].join('\n');

// Breaks if checkFile drops a finding on a stripped file (agent file or ignore file) that PR.diff shows, or lets one through that PR.diff does not show.
test('stripped-file-finding: a security finding on .claude/settings.json is kept when PR.diff shows the file, bounded by its new-side lines', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  const hunks = parseHunks(diffOf('.claude/settings.json', 6));
  const f = finding({ file: '.claude/settings.json', startLine: 3, endLine: 3, category: 'security', severity: 'critical', title: 'Hook runs a shell command' });
  const r = filterFindings([f], { treeDir: dir, hunks, grep: () => [] });
  assert.equal(r.kept.length, 1, JSON.stringify(r.dropped));
  assert.equal(r.kept[0].inDiff, true);
  assert.equal(r.kept[0].thread, true);
  assert.equal(filterFindings([{ ...f, startLine: 9 }], { treeDir: dir, hunks, grep: () => [] }).dropped[0].reason, 'no-line');
  const none = filterFindings([f], { treeDir: dir, hunks: parseHunks(diffOf('other.json', 6)), grep: () => [] });
  assert.equal(none.dropped[0].reason, 'no-file', 'PR.diff has no hunks for this file');
  assert.equal(filterFindings([f], { treeDir: dir, hunks: null, grep: () => [] }).dropped[0].reason, 'no-file');
  for (const file of ['.mcp.json', 'pkg/AGENTS.md', '.cursorignore', 'sub/.gitignore']) {
    const g = filterFindings([{ ...f, file }], { treeDir: dir, hunks: parseHunks(diffOf(file, 6)), grep: () => [] });
    assert.equal(g.kept.length, 1, file);
  }
  assert.equal(filterFindings([{ ...f, file: 'src/missing.mjs' }], { treeDir: dir, hunks, grep: () => [] }).dropped[0].reason, 'no-file', 'a normal absent file is still dropped');
});

// Breaks if isIgnoreFile matches by substring, or stripIgnoreFiles misses a nested file.
test('stripIgnoreFiles removes .gitignore, .cursorignore and .cursorindexingignore at any depth and nothing else', () => {
  const dir = tree({ '.cursorignore': '*', 'a/b/.gitignore': 'PR.diff', 'a/.cursorindexingignore': '*', 'a/keep.mjs': 'x', 'my.gitignore': 'x', 'PR.diff': 'd' });
  const removed = stripIgnoreFiles(dir).sort();
  assert.deepEqual(removed, ['.cursorignore', 'a/.cursorindexingignore', 'a/b/.gitignore']);
  assert.equal(isStrippedFile('x/y/.cursorignore'), true);
  assert.equal(isStrippedFile('.mcp.json'), true);
  assert.equal(isStrippedFile('my.gitignore'), false);
  assert.equal(isStrippedFile('src/a.mjs'), false);
});

// Breaks if a use or a comment refutes the claim again, or if a definition or import stops refuting it.
test('claim-refuted-definition-only: a call elsewhere or a comment does not refute; a definition or import does', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  const f = finding({ startLine: 2, endLine: 2, body: '`validateInput` is not defined.' });
  const withHits = (hits) => filterFindings([f], { treeDir: dir, grep: () => hits });
  assert.equal(withHits(['src/a.mjs:5:validateInput(x);']).kept.length, 1, 'a use on another line');
  assert.equal(withHits(['src/b.mjs:2:// TODO call validateInput here']).kept.length, 1, 'a comment');
  assert.equal(withHits(['src/b.mjs:2:  * validateInput is missing']).kept.length, 1, 'a block comment line');
  assert.equal(withHits(['src/b.mjs:2:const msg = "validateInput";']).kept.length, 1, 'a string');
  assert.equal(withHits(['src/b.mjs:3:export function validateInput(x) {}']).dropped[0]?.reason, 'claim-refuted');
  assert.equal(withHits(['src/b.mjs:3:import { validateInput } from "./v.mjs";']).dropped[0]?.reason, 'claim-refuted');
  assert.equal(withHits(['src/b.mjs:3:const validateInput = (x) => x;']).dropped[0]?.reason, 'claim-refuted');
  assert.equal(withHits(['src/b.py:3:def validateInput(x):']).dropped[0]?.reason, 'claim-refuted');
  assert.equal(withHits(true).kept.length, 1, 'a bare true carries no definition');
});

// Breaks if definesName reads a name that only contains X, or a commented declaration, as a definition.
test('definesName: whole-name declarations count; comments, longer names and calls do not', () => {
  assert.equal(definesName('function foo() {}', 'foo'), true);
  assert.equal(definesName('  async function foo() {}', 'foo'), true);
  assert.equal(definesName('foo() {', 'foo'), true);
  assert.equal(definesName('function foobar() {}', 'foo'), false);
  assert.equal(definesName('// function foo() {}', 'foo'), false);
  assert.equal(definesName('# def foo():', 'foo'), false);
  assert.equal(definesName('x = foo();', 'foo'), false);
  assert.equal(definesName('const a$ = 1; const $foo = 2;', 'foo'), false);
  assert.equal(definesName('function aXb() {}', 'a.b'), false, 'the dot is literal');
});

// Breaks if rule 4 drops a NEVER_SUPPRESS finding again, or if the evidence no longer reaches problems.
test('claim-refuted-never-suppress: a security finding with a refuting definition is kept with the evidence in problems; a plain one is dropped', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  const grep = () => ['src/b.mjs:1:export function ghostFn() {}'];
  const sec = finding({ category: 'security', confidence: 1, body: '`ghostFn` is not defined.' });
  const r = filterFindings([sec], { treeDir: dir, grep });
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].thread, true);
  assert.equal(r.dropped.length, 0);
  assert.match(r.problems[0], /ghostFn.*src\/b\.mjs:1/);
  const byTitle = finding({ title: 'Secret leak in log', body: '`ghostFn` does not exist.' });
  assert.equal(filterFindings([byTitle], { treeDir: dir, grep }).kept.length, 1);
  assert.equal(filterFindings([{ ...sec, category: 'correctness' }], { treeDir: dir, grep }).dropped[0].reason, 'claim-refuted');
});

// Breaks if normalize copies status or firstSeenSha from the model.
test('normalize: the model cannot set status or firstSeenSha on a new finding', () => {
  const dir = tree({ 'src/a.mjs': lines(5) });
  const r = run(finding({ status: 'fixed', firstSeenSha: 'f'.repeat(40) }), dir);
  assert.equal(r.kept[0].status, 'open');
  assert.equal(r.kept[0].firstSeenSha, undefined);
  const prior = [{ id: r.kept[0].id, firstSeenSha: 'a'.repeat(40) }];
  assert.equal(run(finding({ firstSeenSha: 'f'.repeat(40) }), dir, { prior }).kept[0].firstSeenSha, 'a'.repeat(40));
});

const REPLACE = ['diff --git a/src/app.mjs b/src/app.mjs', '--- a/src/app.mjs', '+++ b/src/app.mjs', '@@ -5,5 +5,5 @@', ' l5', ' l6', '-l7', '+L7', ' l8', ' l9', ''].join('\n');

// Breaks if rangeTouched looks only at the endpoints, counts context lines, or misses an insert strictly inside the range or a CRLF diff.
test('rangeTouched: a same-length replacement inside the range counts; context, outside edits and edge inserts do not', () => {
  const h = parseHunks(REPLACE);
  assert.equal(rangeTouched(h, 'src/app.mjs', 5, 10), true, 'line 7 replaced inside 5-10');
  assert.equal(rangeTouched(h, 'src/app.mjs', 7, 7), true);
  assert.equal(rangeTouched(h, 'src/app.mjs', 5, 6), false, 'only context lines in the hunk');
  assert.equal(rangeTouched(h, 'src/app.mjs', 8, 9), false);
  assert.equal(rangeTouched(h, 'src/other.mjs', 1, 99), false);
  assert.equal(rangeTouched(null, 'src/app.mjs', 1, 9), false);
  assert.equal(rangeTouched(parseHunks(REPLACE.replaceAll('\n', '\r\n')), 'src/app.mjs', 5, 10), true, 'CRLF diff');
  const insert = parseHunks(['diff --git a/f.mjs b/f.mjs', '--- a/f.mjs', '+++ b/f.mjs', '@@ -4,2 +4,3 @@', ' l4', '+new', ' l5', ''].join('\n'));
  assert.equal(rangeTouched(insert, 'f.mjs', 3, 6), true, 'insert before l5, inside 3-6');
  assert.equal(rangeTouched(insert, 'f.mjs', 5, 6), false, 'insert before the first line of the range');
  assert.equal(rangeTouched(insert, 'f.mjs', 3, 4), false, 'insert after the last line of the range');
});
