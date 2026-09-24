// safe-replace must never report success for an edit it did not make (P30).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceExact } from '../safe-replace.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'safe-replace.mjs');
const run = (args) => {
  try { return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }) }; }
  catch (e) { return { code: e.status, out: String(e.stderr) }; }
};

test('an LF anchor matches a CRLF file, and the file keeps CRLF', () => {
  const r = replaceExact('a\r\nb\r\nc\r\n', 'a\nb', 'x\ny');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'x\r\ny\r\nc\r\n');
});

test('an LF file stays LF', () => {
  assert.equal(replaceExact('a\nb\n', 'b', 'z').text, 'a\nz\n');
});

test('zero matches is a failure, not a silent no-op', () => {
  const r = replaceExact('a\nb\n', 'missing', 'z');
  assert.deepEqual([r.ok, r.found], [false, 0]);
});

test('more matches than expected is a failure', () => {
  assert.equal(replaceExact('x x', 'x', 'y').ok, false);
  assert.equal(replaceExact('x x', 'x', 'y', { count: 2 }).text, 'y y');
});

test('CLI: exit 1 on zero matches and the file is not rewritten', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'safe-replace-')), 'f.md');
  writeFileSync(f, 'one\r\ntwo\r\n');
  const before = statSync(f).mtimeMs;
  const r = run([f, '--old', 'three', '--new', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.out, /matched 0 time/);
  assert.equal(statSync(f).mtimeMs, before);
});

test('CLI: exit 0 and the edit lands', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'safe-replace-')), 'f.md');
  writeFileSync(f, 'one\r\ntwo\r\n');
  assert.equal(run([f, '--old', 'one\ntwo', '--new', 'uno\ndos']).code, 0);
  assert.equal(readFileSync(f, 'utf8'), 'uno\r\ndos\r\n');
});

test('CLI: exit 2 on bad usage', () => {
  assert.equal(run(['only-a-file']).code, 2);
});

test('a mixed-ending file keeps the endings outside the replaced span', () => {
  assert.equal(replaceExact('a\r\nb\nc\n', 'b', 'z').text, 'a\r\nz\nc\n');
  assert.equal(replaceExact('a\r\nb\nc\r\nd\n', 'b\nc', 'x\ny').text, 'a\r\nx\ny\r\nd\n');
});

test('regex characters in the anchor are literal', () => {
  assert.equal(replaceExact('f(x) + [1]', '(x) + [1]', 'y').text, 'fy');
});

test('CLI: an empty anchor is a usage error (exit 2)', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'safe-replace-')), 'f.md');
  writeFileSync(f, 'x');
  assert.equal(run([f, '--old', '', '--new', 'y']).code, 2);
});
