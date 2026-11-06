// Tests for scripts/checks/typecheck-changed.mjs. The tsc tests run the real tsc from .claude/hooks/node_modules on temp files.
// Run: node --test scripts/checks/typecheck-changed.test.mjs
//
// How the unit can fail, and the test that catches it:
//   the tsc line format is not parsed, or an indented detail line is parsed      -> T1  (change ERROR_RE)
//   an error on an unchanged line, or in an unchanged file, is reported          -> T2  (drop the filter in keepChanged)
//   a real type error on a changed line is lost (wrong flags, cwd or typeRoots)  -> T3  (drop --checkJs or --typeRoots)
//   a test file or a non-.mjs file is passed to tsc                              -> T4  (drop the target filter)
//   no target throws instead of skipping, or a target with no tsc is a silent skip -> T5  (drop the guards, or turn the ENV error back into skipped)
//   the CLI exits 1 without --strict, or 0 with --strict and errors              -> T6  (flip the exit rule)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepChanged, parseTscOutput, runTypecheck, typecheckTargets } from './typecheck-changed.mjs';

const CLI = fileURLToPath(new URL('./typecheck-changed.mjs', import.meta.url));

// Line 1 imports fs. Line 2 is a type error (a number where a string is needed). Line 3 is fine. Line 4 is a second type error.
const BAD = "import fs from 'node:fs';\nfs.readFileSync(5, 'utf8').nope();\nconst ok = 1;\nconst s = 'a'.nope2();\n";

function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tc-test-'));
  mkdirSync(path.join(dir, 'scripts'));
  return dir;
}

test('T1: tsc error lines parse; detail lines and noise do not', () => {
  const text = [
    "scripts\\a.mjs(12,5): error TS2339: Property 'x' does not exist on type 'string'.",
    "  Type 'a' is not assignable to type 'b'.",
    'Found 1 error.',
    '',
  ].join('\r\n');
  assert.deepEqual(parseTscOutput(text), [{ path: 'scripts/a.mjs', line: 12, code: 'TS2339', message: "Property 'x' does not exist on type 'string'." }]);
});

test('T2: an error survives only in a changed file and a changed range', () => {
  const errs = [
    { path: 'a.mjs', line: 2, code: 'TS1', message: 'm' },
    { path: 'a.mjs', line: 9, code: 'TS2', message: 'm' },
    { path: 'other.mjs', line: 2, code: 'TS3', message: 'm' },
  ];
  assert.deepEqual(keepChanged(errs, [{ path: 'a.mjs', ranges: [[1, 3]] }]).map((e) => e.code), ['TS1']);
  assert.deepEqual(keepChanged(errs, { './a.mjs': [[9, 9]] }).map((e) => e.code), ['TS2']);
});

test('T3: the real tsc reports a type error on a changed line and drops one on an unchanged line', () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, 'scripts', 'bad.mjs'), BAD);
    const r = runTypecheck({ root: dir, files: ['scripts/bad.mjs'], ranges: { 'scripts/bad.mjs': [[2, 2]] } });
    assert.equal(r.skipped, null);
    assert.equal(r.tool, 'tsc');
    assert.match(r.version, /^\d+\.\d+/);
    assert.deepEqual(r.errors.map((e) => [e.path, e.line, e.code]), [['scripts/bad.mjs', 2, 'TS2339']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('T4: test files and non-.mjs files are not targets', () => {
  assert.deepEqual(typecheckTargets(['a.mjs', 'a.test.mjs', 'b.ts', 'c.js', 'scripts\\d.mjs', './a.mjs']), ['a.mjs', 'scripts/d.mjs']);
});

test('T5: no target is skipped; a target and no tsc anywhere is an ENV error, never a silent skip', () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, 'scripts', 'a.test.mjs'), BAD);
    const none = runTypecheck({ root: dir, files: ['scripts/a.test.mjs', 'scripts/gone.mjs'], ranges: [] });
    assert.match(none.skipped, /no changed non-test/);
    assert.deepEqual(none.errors, []);
    // No tsc and nothing to check: still a skip (a docs-only change needs no compiler).
    const noToolNoTarget = runTypecheck({ root: dir, files: ['scripts/a.test.mjs'], ranges: [] }, { hooksDir: dir });
    assert.match(noToolNoTarget.skipped, /no changed non-test/);
    assert.equal(noToolNoTarget.error, undefined);
    // A changed .mjs file and no tsc in hooksDir: ENV, with the folder tried and the fix.
    writeFileSync(path.join(dir, 'scripts', 'a.mjs'), BAD);
    const noTool = runTypecheck({ root: dir, files: ['scripts/a.mjs'], ranges: [] }, { hooksDir: dir });
    assert.equal(noTool.skipped, null);
    assert.equal(noTool.env, true);
    assert.match(noTool.error, /^ENV: tsc needs typescript\. Tried /);
    assert.ok(noTool.error.includes(path.join(dir, 'node_modules', 'typescript')));
    assert.match(noTool.error, /npm ci/);
    assert.deepEqual(noTool.errors, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('T6: the CLI exits 0 with errors, and 1 only with --strict', () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, 'scripts', 'bad.mjs'), BAD);
    const diff = path.join(dir, 'd.diff');
    writeFileSync(diff, 'diff --git a/scripts/bad.mjs b/scripts/bad.mjs\n--- a/scripts/bad.mjs\n+++ b/scripts/bad.mjs\n@@ -1,0 +2,1 @@\n+fs.readFileSync(5, \'utf8\').nope();\n');
    const run = (extra) => spawnSync(process.execPath, [CLI, '--root', dir, '--diff', diff, ...extra], { encoding: 'utf8', windowsHide: true });
    const plain = run([]);
    assert.equal(plain.status, 0);
    assert.equal(JSON.parse(plain.stdout).errors.length, 1);
    assert.equal(run(['--strict']).status, 1);
    assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8', windowsHide: true }).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
