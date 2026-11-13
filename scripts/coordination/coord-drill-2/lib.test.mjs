/**
 * coord-drill-2 / lib.test.mjs -- the read-error paths of the two real-home proofs (review 4, lib.mjs:370 and :428).
 *
 *   node --test scripts/coordination/coord-drill-2/lib.test.mjs
 *
 * Each test builds a temp "home" in os.tmpdir() and passes it as `homes`, so no real home is read or written.
 * A read error is made with a deny of read-data on one file (icacls on Windows, chmod 000 elsewhere).
 * Failure modes these tests catch:
 *   1. gainedText returns '' on a read error again: diffRealHome then reports nothing for a changed, unreadable file.
 *   2. tailText returns '' on a read error again: scanRealHomeChanged counts the file as scanned, not unreadable.
 *   3. scanIncomplete is not set when a changed file is unreadable: run.mjs would print "SANDBOX: 0 writes".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { diffRealHome, scanRealHomeChanged, snapshotRealHome } from './lib.mjs';

const MARKER = 'drill-test-marker-0001';
const isWin = process.platform === 'win32';
const isRoot = !isWin && typeof process.getuid === 'function' && process.getuid() === 0;

function denyRead(file) {
  if (isWin) {
    const r = spawnSync('icacls', [file, '/deny', `${os.userInfo().username}:(RD)`], { windowsHide: true, encoding: 'utf8' });
    assert.equal(r.status, 0, `icacls deny failed: ${r.stderr || r.stdout}`);
  } else {
    fs.chmodSync(file, 0o000);
  }
}

function allowRead(file) {
  if (isWin) spawnSync('icacls', [file, '/remove:d', os.userInfo().username], { windowsHide: true });
  else { try { fs.chmodSync(file, 0o644); } catch { /* ignore */ } }
}

/** A temp home with the watched session-id file. Returns { dir, home, sid }. */
function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-drill-2-libtest-'));
  const home = path.join(dir, 'home');
  const sid = path.join(home, '.claude', '.coordination-session-id');
  fs.mkdirSync(path.dirname(sid), { recursive: true });
  fs.writeFileSync(sid, '0'.repeat(36));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(sid, old, old);
  return { dir, home, sid };
}

function readFails(file) {
  try { fs.readFileSync(file); return false; } catch { return true; }
}

test('diffRealHome reports a changed watched file that cannot be read', { skip: isRoot && 'root ignores chmod 000' }, (t) => {
  const { dir, home, sid } = tempHome();
  t.after(() => { allowRead(sid); fs.rmSync(dir, { recursive: true, force: true }); });
  const before = snapshotRealHome([home]);
  fs.writeFileSync(sid, MARKER.padEnd(36, '-')); // same size: only a whole-file read could see the marker
  denyRead(sid);
  assert.ok(readFails(sid), 'setup: the deny did not stop the read');
  const changed = diffRealHome(before, [MARKER], [home]);
  assert.equal(changed.length, 1, `expected one report, got ${JSON.stringify(changed)}`);
  assert.match(changed[0], /could not be read/);
});

test('scanRealHomeChanged counts an unreadable changed file as unreadable and marks the scan incomplete', { skip: isRoot && 'root ignores chmod 000' }, (t) => {
  const { dir, home } = tempHome();
  const idFile = path.join(home, '.claude', 'state', 'identity', 'locked.json');
  t.after(() => { allowRead(idFile); fs.rmSync(dir, { recursive: true, force: true }); });
  const before = snapshotRealHome([home]);
  fs.mkdirSync(path.dirname(idFile), { recursive: true });
  fs.writeFileSync(idFile, `{"uuid":"${MARKER}"}\n`);
  denyRead(idFile);
  assert.ok(readFails(idFile), 'setup: the deny did not stop the read');
  const scan = scanRealHomeChanged(before, [MARKER], [home]);
  assert.equal(scan.unreadable, 1);
  assert.equal(scan.scanned, 0);
  assert.equal(scan.hits.length, 0);
  assert.equal(scan.scanIncomplete, true);
});

test('scanRealHomeChanged on readable files is complete (control for the test above)', (t) => {
  const { dir, home } = tempHome();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = snapshotRealHome([home]);
  const idFile = path.join(home, '.claude', 'state', 'identity', 'open.json');
  fs.mkdirSync(path.dirname(idFile), { recursive: true });
  fs.writeFileSync(idFile, `{"uuid":"${MARKER}"}\n`);
  const scan = scanRealHomeChanged(before, [MARKER], [home]);
  assert.equal(scan.unreadable, 0);
  assert.equal(scan.scanned, 1);
  assert.equal(scan.hits.length, 1);
  assert.equal(scan.scanIncomplete, false);
});
