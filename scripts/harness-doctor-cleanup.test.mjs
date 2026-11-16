// harness-doctor.test.mjs used to leave every temp folder behind: about 40,000 `hdoc-`, `hdoc-sched-`,
// `rem-home-` and `dash-home-` folders sat in %TEMP% (lane temp-folder-leak-hunt).
// These tests run four cheap tests of that file, one per folder prefix, with TEMP pointed at a scratch folder.
// They fail if the file stops removing what it made, or starts removing what it did not make.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET = join(dirname(fileURLToPath(import.meta.url)), 'harness-doctor.test.mjs');
// One test name per creator: fixture() hdoc-, schedRepo() hdoc-sched-, reminderHome() rem-home-, dashHome() dash-home-.
const PATTERNS = [
  'a registration baseline that git shows as changed is a WARN',
  'a missing tasks.json is one WARN naming the file',
  'F8: reminderSyncCheck is a PASS with no heartbeat',
  'fleetopsSize: PASS with no export',
];
const PREFIXES = ['hdoc-', 'hdoc-sched-', 'rem-home-', 'dash-home-'];

// A folder that a prefix match would remove but this file never made. It sits in the scratch folder before the run.
function runTarget() {
  const scratch = mkdtempSync(join(tmpdir(), 'hdoc-cleanup-scratch-'));
  const foreign = join(scratch, 'hdoc-foreign-not-made-by-the-test');
  mkdirSync(foreign);
  const env = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch };
  delete env.NODE_TEST_CONTEXT; // else the child runs as a subtest of this run and prints no summary
  const args = ['--test', ...PATTERNS.flatMap((p) => ['--test-name-pattern', p]), TARGET];
  const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', windowsHide: true, timeout: 240000 });
  return { scratch, foreign, r };
}

const run = runTarget();

test('the four cheap tests run and pass, so the leak check below is not vacuous', () => {
  const pass = Number(/^# pass (\d+)/m.exec(run.r.stdout)?.[1] ?? 0);
  assert.ok(pass >= PATTERNS.length, `pass count ${pass}\n${run.r.stdout}\n${run.r.stderr}`);
  assert.match(run.r.stdout, /^# fail 0/m, run.r.stdout);
});

test('harness-doctor.test.mjs removes every temp folder it made, for all four prefixes', () => {
  // Breaks if the after() hook or its list of made folders is removed, or a creator bypasses tempDir().
  const left = readdirSync(run.scratch).filter((n) => PREFIXES.some((p) => n.startsWith(p)) && n !== 'hdoc-foreign-not-made-by-the-test');
  assert.deepEqual(left, []);
});

test('harness-doctor.test.mjs does not remove a folder it did not make, even with the same prefix', () => {
  // Breaks if the cleanup becomes a prefix sweep of the temp dir.
  assert.equal(existsSync(run.foreign), true);
});

after(() => {
  try { rmSync(run.scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a leak is better than a failed test */ }
});
