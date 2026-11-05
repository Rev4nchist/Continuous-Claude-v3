// Tests for changedLines in scripts/checks/changed-lines.mjs.
// Run: node --test scripts/checks/changed-lines.test.mjs
//
// How the unit can fail, and the test that catches it:
//   a context line is listed as changed                                  -> C1  (count ' ' lines as added)
//   two separate edits in one hunk merge into one range                  -> C2  (drop the gap check in toRanges)
//   a removed line shifts the new-side numbers                           -> C3  (advance n on '-' lines)
//   a deleted file is listed                                             -> C4  (drop the entry.file check)
//   a renamed file is listed under its old path, or its edit is lost     -> C5  (key by oldFile)
//   a CRLF diff gives wrong or empty ranges                              -> C6  (split on '\n' only)
//   the "\ No newline at end of file" marker counts as a line            -> C7  (count '\' lines)
//   a new file or a one-line hunk with no ",count" gets no range         -> C8  (read missing count as 0)
//   a second file in the diff takes the first file's ranges              -> C9  (reuse one entry)
//   the CLI waits on stdin for --help, or ignores a piped diff           -> C10 (read stdin before the --help check)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedLines, inRanges } from './changed-lines.mjs';

const hdr = (a, b = a) => `diff --git a/${a} b/${b}\nindex 111..222 100644\n--- a/${a}\n+++ b/${b}\n`;

test('C1: context lines are not changed lines', () => {
  const d = `${hdr('x.mjs')}@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`;
  assert.deepEqual(changedLines(d), [{ path: 'x.mjs', ranges: [[2, 2]] }]);
});

test('C2: edits split by context stay as separate ranges; adjacent adds merge', () => {
  const d = `${hdr('x.mjs')}@@ -1,6 +1,8 @@\n+n1\n+n2\n a\n b\n c\n+n6\n d\n e\n`;
  assert.deepEqual(changedLines(d), [{ path: 'x.mjs', ranges: [[1, 2], [6, 6]] }]);
});

test('C3: a removed line does not shift the new-side numbers', () => {
  const d = `${hdr('x.mjs')}@@ -10,4 +10,3 @@\n a\n-gone1\n-gone2\n+kept\n b\n`;
  assert.deepEqual(changedLines(d), [{ path: 'x.mjs', ranges: [[11, 11]] }]);
});

test('C4: a deleted file is not listed', () => {
  const d = 'diff --git a/old.mjs b/old.mjs\ndeleted file mode 100644\nindex 111..000\n--- a/old.mjs\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n';
  assert.deepEqual(changedLines(d), []);
});

test('C5: a rename with an edit is listed under the new path; a pure rename has no ranges', () => {
  const edit = 'diff --git a/a.mjs b/b.mjs\nsimilarity index 90%\nrename from a.mjs\nrename to b.mjs\n--- a/a.mjs\n+++ b/b.mjs\n@@ -1,2 +1,2 @@\n x\n-y\n+Y\n';
  assert.deepEqual(changedLines(edit), [{ path: 'b.mjs', ranges: [[2, 2]] }]);
  const pure = 'diff --git a/a.mjs b/c.mjs\nsimilarity index 100%\nrename from a.mjs\nrename to c.mjs\n';
  assert.deepEqual(changedLines(pure), [{ path: 'c.mjs', ranges: [] }]);
});

test('C6: a CRLF diff gives the same ranges as an LF diff', () => {
  const lf = `${hdr('x.mjs')}@@ -1,2 +1,3 @@\n a\n+b\n+c\n`;
  assert.deepEqual(changedLines(lf.replaceAll('\n', '\r\n')), changedLines(lf));
  assert.deepEqual(changedLines(lf), [{ path: 'x.mjs', ranges: [[2, 3]] }]);
});

test('C7: the no-newline marker is not a line, before or after the added line', () => {
  const d = `${hdr('x.mjs')}@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n`;
  assert.deepEqual(changedLines(d), [{ path: 'x.mjs', ranges: [[2, 2]] }]);
});

test('C8: a new file and a hunk header with no count', () => {
  const nf = 'diff --git a/n.mjs b/n.mjs\nnew file mode 100644\nindex 000..111\n--- /dev/null\n+++ b/n.mjs\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n';
  assert.deepEqual(changedLines(nf), [{ path: 'n.mjs', ranges: [[1, 3]] }]);
  const one = `${hdr('x.mjs')}@@ -5 +5 @@\n-old\n+new\n`;
  assert.deepEqual(changedLines(one), [{ path: 'x.mjs', ranges: [[5, 5]] }]);
});

test('C9: two files keep their own ranges, in diff order', () => {
  const d = `${hdr('a.mjs')}@@ -1 +1 @@\n-a\n+A\n${hdr('b.mjs')}@@ -7,0 +8,2 @@\n+p\n+q\n`;
  assert.deepEqual(changedLines(d), [
    { path: 'a.mjs', ranges: [[1, 1]] },
    { path: 'b.mjs', ranges: [[8, 9]] },
  ]);
});

test('inRanges: both ends are inclusive', () => {
  assert.equal(inRanges([[3, 5]], 3), true);
  assert.equal(inRanges([[3, 5]], 5), true);
  assert.equal(inRanges([[3, 5]], 6), false);
  assert.equal(inRanges(undefined, 1), false);
});

test('C10: the CLI prints usage for --help and reads a piped diff; it never waits on --help', () => {
  const cli = fileURLToPath(new URL('./changed-lines.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage:/);
  const d = `${hdr('x.mjs')}@@ -1,2 +1,3 @@\n a\n+b\n+c\n`;
  const piped = spawnSync(process.execPath, [cli], { input: d, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.deepEqual(JSON.parse(piped.stdout), [{ path: 'x.mjs', ranges: [[2, 3]] }]);
});

// Breaks if a plain unified diff (hunks, no "diff --git" header) gives an empty list, which lets the catchers run on no files.
test('C11: a diff with hunks but no "diff --git" header throws; a diff with no hunks still gives []', () => {
  const plain = '--- a/scripts/a.mjs\n+++ b/scripts/a.mjs\n@@ -1 +1 @@\n-x\n+y\n';
  assert.throws(() => changedLines(plain), /no "diff --git" header/);
  assert.deepEqual(changedLines(''), []);
});

// Breaks if the header check looks at the whole input: a plain section next to a Git section would be dropped silently.
test('C12: a plain section before or after a Git section throws; an added line that starts with "++" does not', () => {
  const plain = ['--- a/plain.mjs', '+++ b/plain.mjs', '@@ -1 +1 @@', '-old', '+new'];
  const git = ['diff --git a/git.mjs b/git.mjs', 'index 1111111..2222222 100644', '--- a/git.mjs', '+++ b/git.mjs', '@@ -1 +1 @@', '-old', '+new'];
  assert.throws(() => changedLines([...plain, ...git, ''].join('\n')), /outside a "diff --git" section/);
  assert.throws(() => changedLines([...git, ...plain, ''].join('\n')), /outside a "diff --git" section/);
  const plusPlus = ['diff --git a/g.mjs b/g.mjs', '--- a/g.mjs', '+++ b/g.mjs', '@@ -1,1 +1,2 @@', ' keep', '+++ added text', ''].join('\n');
  assert.deepEqual(changedLines(plusPlus), [{ path: 'g.mjs', ranges: [[2, 2]] }]);
});

// Breaks if a header-only Git section (pure rename, mode change) leaves the section open for a following plain section.
test('C13: a plain section after a pure rename throws; a rename with content and a --no-index new file still parse', () => {
  const rename = ['diff --git a/old.mjs b/new.mjs', 'similarity index 100%', 'rename from old.mjs', 'rename to new.mjs'];
  const plain = ['--- a/plain.mjs', '+++ b/plain.mjs', '@@ -1 +1 @@', '-old', '+new'];
  assert.throws(() => changedLines([...rename, ...plain, ''].join('\n')), /outside a "diff --git" section/);
  const renameEdit = ['diff --git a/o.mjs b/n.mjs', 'similarity index 90%', 'rename from o.mjs', 'rename to n.mjs', 'index 1111111..2222222 100644', '--- a/o.mjs', '+++ b/n.mjs', '@@ -1 +1 @@', '-x', '+y', ''].join('\n');
  assert.deepEqual(changedLines(renameEdit), [{ path: 'n.mjs', ranges: [[1, 1]] }]);
  const untracked = ['diff --git a/u.mjs b/u.mjs', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/u.mjs', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n');
  assert.deepEqual(changedLines(untracked), [{ path: 'u.mjs', ranges: [[1, 2]] }]);
});

// Breaks if the header check splits the "diff --git" line at the last " b/": a path can hold " b/" itself.
test('C14: a path that holds " b/" parses; a plain section after it still throws', () => {
  const spaced = ['diff --git a/docs/Plan b/report.mjs b/docs/Plan b/report.mjs', 'index 1111111..2222222 100644', '--- a/docs/Plan b/report.mjs', '+++ b/docs/Plan b/report.mjs', '@@ -1 +1 @@', '-x', '+y'];
  assert.deepEqual(changedLines([...spaced, ''].join('\n')).map((e) => e.ranges), [[[1, 1]]]);
  const plain = ['--- a/plain.mjs', '+++ b/plain.mjs', '@@ -1 +1 @@', '-old', '+new'];
  const rename = ['diff --git a/x b/old.mjs b/x b/new.mjs', 'similarity index 100%', 'rename from x b/old.mjs', 'rename to x b/new.mjs'];
  assert.throws(() => changedLines([...rename, ...plain, ''].join('\n')), /outside a "diff --git" section/);
});
