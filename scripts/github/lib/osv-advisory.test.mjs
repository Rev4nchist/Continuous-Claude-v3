// Tests for lib/osv-advisory.mjs. Run: node --test scripts/github/lib/osv-advisory.test.mjs
// osv-scanner never starts and nothing touches the network: the run call, the binary and the lockfile list are injected.
// The report shape is real osv-scanner v2.7.0 `scan source --format json` output (absolute forward-slash source.path, groups[].ids, max_severity as a string).
//
// Failure modes, and the source change that makes each test fail:
//   O1  no tracked lockfile                        -> a NOTE on every run (changes every pre-pr line count) or a run with no -L file
//   O2  the binary is missing                      -> a throw or a FAIL instead of a skip NOTE
//   O3  baseline missing or not an osv baseline    -> a throw, or osv runs for nothing
//   O4  osv cannot run (network, exit 127, timeout) -> a FAIL step, a throw, or a wrong "0 advisories" line
//   O5  a normal run: arguments and the line       -> -r is used, a lockfile is skipped, the counts or the tag text are wrong
//   O6  new vs drift                               -> a new advisory in a lockfile the PR did not change is called new (or the reverse)
//   O7  exit 0 with an empty results array         -> read as "could not read the output"
//   O8  junk output, or a source path outside root -> the error propagates out of pre-pr
//   O9  the binary lookup                          -> env ignored, or version folders sorted as text
//   O10 lockfile discovery                         -> node_modules/worktree lockfiles are scanned, or a deleted lockfile is passed to osv
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findOsv, lockfilesIn, osvAdvisory } from './osv-advisory.mjs';

const TAG = 'advisory only (one-week trial, never fails pre-pr)';
const grp = (id, sev) => (sev === undefined ? { ids: [id], aliases: [] } : { ids: [id], aliases: [], max_severity: sev });
const pkg = (name, groups, ecosystem = 'npm') => ({ package: { name, version: '1.0.0', ecosystem }, groups });
const report = (root, byFile) => JSON.stringify({
  results: Object.entries(byFile).map(([file, packages]) => ({ source: { path: `${root.replace(/\\/g, '/')}/${file}`, type: 'lockfile' }, packages })),
  experimental_config: { licenses: { summary: false, allowlist: null } },
});

/** A repo folder with the given lockfiles and a baseline of { key: count } (baseline: null writes none). */
function repo({ files = ['opc/uv.lock', '.claude/hooks/package-lock.json'], baseline = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'osv-adv-'));
  for (const f of files) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), '{}\n'); }
  mkdirSync(path.join(root, 'scripts', 'ratchets'), { recursive: true });
  if (baseline !== null) {
    const total = Object.values(baseline).reduce((s, n) => s + n, 0);
    writeFileSync(path.join(root, 'scripts', 'ratchets', 'osv-baseline.json'), JSON.stringify({ tool: 'osv', reason: 't', total, counts: baseline }));
  }
  return { root, files };
}

test('O1: no tracked lockfile gives null and never runs osv-scanner', () => {
  const { root } = repo({ files: [] });
  let ran = 0;
  assert.equal(osvAdvisory({ root, paths: ['docs/a.md'], bin: 'OSV', lockfiles: [], run: () => { ran += 1; return {}; } }), null);
  assert.equal(ran, 0);
});

test('O2: a missing binary is a NOTE that says it was skipped, and osv is not run', () => {
  const { root, files } = repo();
  let ran = 0;
  const r = osvAdvisory({ root, paths: [], bin: null, lockfiles: files, run: () => { ran += 1; return {}; } });
  assert.equal(r.step, 'osv');
  assert.equal(r.status, 'NOTE');
  assert.match(r.detail, /skipped.*not found/i);
  assert.match(r.detail, /advisory only/);
  assert.equal(ran, 0);
});

test('O2b: CCV3_OSV=off is a skip NOTE that says so, and osv is not run (the off switch for a bad network day)', () => {
  const { root, files } = repo();
  let ran = 0;
  for (const off of ['off', 'OFF']) {
    const r = osvAdvisory({ root, paths: [], bin: 'OSV', lockfiles: files, env: { CCV3_OSV: off }, run: () => { ran += 1; return {}; } });
    assert.equal(r.status, 'NOTE');
    assert.match(r.detail, /^skipped: CCV3_OSV=off; advisory only/);
  }
  assert.equal(ran, 0);
  // with no lockfile there is still no line at all
  assert.equal(osvAdvisory({ root, paths: [], bin: 'OSV', lockfiles: [], env: { CCV3_OSV: 'off' } }), null);
});

test('O3: a missing, unreadable or wrong-tool baseline is a "no baseline" NOTE, never a throw, and osv is not run', () => {
  let ran = 0;
  const run = () => { ran += 1; return {}; };
  const none = repo({ baseline: null });
  const bad = repo();
  writeFileSync(path.join(bad.root, 'scripts', 'ratchets', 'osv-baseline.json'), '{not json');
  const wrong = repo();
  writeFileSync(path.join(wrong.root, 'scripts', 'ratchets', 'osv-baseline.json'), JSON.stringify({ tool: 'trivy', total: 0, counts: {} }));
  for (const r of [none, bad, wrong]) {
    const n = osvAdvisory({ root: r.root, paths: [], bin: 'OSV', lockfiles: r.files, run });
    assert.equal(n.status, 'NOTE');
    assert.match(n.detail, /no baseline/i);
    assert.match(n.detail, /advisory only/);
  }
  assert.equal(ran, 0);
});

test('O4: a crash, a time-out, exit 127 or exit 2 is a skip NOTE with the useful stderr line, never a FAIL', () => {
  const { root, files } = repo();
  const noise = 'Starting filesystem walk for root: C:\\\nfailed to fetch https://api.osv.dev: dial tcp: no such host\nEnd status: 0 dirs visited';
  const runs = [
    () => { throw new Error('boom'); },
    () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn ENOENT') }),
    () => ({ status: null, stdout: '', stderr: '', timedOut: true }),
    () => ({ status: 127, stdout: '', stderr: noise }),
    () => ({ status: 2, stdout: '', stderr: noise }),
  ];
  for (const run of runs) {
    const r = osvAdvisory({ root, paths: [], bin: 'OSV', lockfiles: files, run });
    assert.equal(r.status, 'NOTE', JSON.stringify(r));
    assert.match(r.detail, /^skipped: osv-scanner could not run/);
  }
  const r = osvAdvisory({ root, paths: [], bin: 'OSV', lockfiles: files, run: runs[3] });
  assert.match(r.detail, /failed to fetch https:\/\/api\.osv\.dev/);
  assert.doesNotMatch(r.detail, /Starting filesystem walk/);
});

test('O5: exit 1 with a report is read; arguments are scan source --format json with one -L per lockfile, no -r; the line has counts and the tag', () => {
  const { root, files } = repo({ baseline: { 'osv|opc/uv.lock|OLD-1|PyPI/old': 1 } });
  const out = report(root, {
    'opc/uv.lock': [pkg('pillow', [grp('GHSA-new1', '9.8'), grp('GHSA-low', '5.0')], 'PyPI'), pkg('old', [grp('OLD-1', '8')], 'PyPI')],
    '.claude/hooks/package-lock.json': [pkg('vite', [grp('GHSA-unscored')])],
  });
  const calls = [];
  const r = osvAdvisory({ root, paths: ['opc/uv.lock'], bin: 'OSVBIN', lockfiles: files, run: (bin, args, opts) => { calls.push({ bin, args, opts }); return { status: 1, stdout: out, stderr: 'noise' }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'OSVBIN');
  assert.deepEqual(calls[0].args, ['scan', 'source', '--format', 'json', '-L', 'opc/uv.lock', '-L', '.claude/hooks/package-lock.json']);
  assert.equal(calls[0].opts.cwd, root);
  assert.equal(r.step, 'osv');
  assert.equal(r.status, 'NOTE');
  assert.match(r.detail, /^3 high\/unscored advisory group\(s\) in 2 lockfile\(s\), baseline 1, new 1, drift 1, fixed 0; /);
  assert.match(r.detail, /top new: osv\|opc\/uv\.lock\|GHSA-new1\|PyPI\/pillow/);
  assert.ok(r.detail.endsWith(TAG), r.detail);
});

test('O6: a new advisory in a lockfile the PR changed is new, in an untouched lockfile it is drift; top new lists at most 3', () => {
  const { root, files } = repo();
  const out = report(root, {
    'opc/uv.lock': [pkg('a', [grp('N1', '9'), grp('N2', '9'), grp('N3', '9'), grp('N4', '9')], 'PyPI')],
    '.claude/hooks/package-lock.json': [pkg('v', [grp('D1', '9')])],
  });
  const run = () => ({ status: 1, stdout: out, stderr: '' });
  const r = osvAdvisory({ root, paths: ['opc/uv.lock', 'README.md'], bin: 'OSV', lockfiles: files, run });
  assert.match(r.detail, /new 4, drift 1/);
  const top = /top new: (.*?);/.exec(r.detail)[1].split(', ');
  assert.equal(top.length, 3);
  assert.ok(top.every((k) => k.includes('opc/uv.lock')), top.join(' '));
  const none = osvAdvisory({ root, paths: ['docs/a.md'], bin: 'OSV', lockfiles: files, run });
  assert.match(none.detail, /new 0, drift 5/);
});

test('O6b: a group that gained a smaller id since the baseline is not new and not fixed; a new advisory on the same package is new', () => {
  const key = 'osv|opc/uv.lock|GHSA-b|PyPI/pillow';
  const { root, files } = repo({ baseline: { [key]: 1 } });
  writeFileSync(path.join(root, 'scripts', 'ratchets', 'osv-baseline.json'), JSON.stringify({ tool: 'osv', reason: 't', total: 1, counts: { [key]: 1 }, ids: { [key]: ['CVE-1', 'GHSA-b'] } }));
  const withIds = (ids, aliases) => ({ ids, aliases, max_severity: '9' });
  const run = (groups) => () => ({ status: 1, stdout: report(root, { 'opc/uv.lock': [pkg('pillow', groups, 'PyPI')] }), stderr: '' });
  const gained = osvAdvisory({ root, paths: ['opc/uv.lock'], bin: 'OSV', lockfiles: files, run: run([withIds(['GHSA-b', 'GHSA-a'], ['CVE-1'])]) });
  assert.match(gained.detail, /baseline 1, new 0, drift 0, fixed 0;/);
  const fresh = osvAdvisory({ root, paths: ['opc/uv.lock'], bin: 'OSV', lockfiles: files, run: run([withIds(['GHSA-b'], ['CVE-1']), withIds(['GHSA-new'], ['CVE-9'])]) });
  assert.match(fresh.detail, /baseline 1, new 1, drift 0, fixed 0; top new: osv\|opc\/uv\.lock\|GHSA-new\|PyPI\/pillow/);
});

test('O7: exit 0 with an empty results array is "0 groups", and baseline keys are reported as fixed', () => {
  const { root, files } = repo({ baseline: { 'osv|opc/uv.lock|GONE|PyPI/x': 1 } });
  const r = osvAdvisory({ root, paths: [], bin: 'OSV', lockfiles: files, run: () => ({ status: 0, stdout: '{"results":[]}', stderr: '' }) });
  assert.match(r.detail, /^0 high\/unscored advisory group\(s\) in 2 lockfile\(s\), baseline 1, new 0, drift 0, fixed 1; top new: none; /);
});

test('O8: junk output, or a source path outside the root, is a skip NOTE and never a throw', () => {
  const { root, files } = repo();
  for (const stdout of ['not json', '', '{"nope":1}', report('D:/elsewhere', { 'opc/uv.lock': [pkg('a', [grp('X', '9')])] })]) {
    const r = osvAdvisory({ root, paths: [], bin: 'OSV', lockfiles: files, run: () => ({ status: 1, stdout, stderr: '' }) });
    assert.equal(r.status, 'NOTE', stdout);
    assert.match(r.detail, /^skipped: osv-scanner output could not be read/);
  }
});

test('O9: findOsv prefers CCV3_OSV, else the newest version folder under the home tools folder', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'osv-home-'));
  const base = path.join(home, 'tools', 'review-scanners', 'osv-scanner');
  for (const v of ['v2.9.0', 'v2.10.1', 'v2.7.0']) {
    mkdirSync(path.join(base, v), { recursive: true });
    writeFileSync(path.join(base, v, 'osv-scanner_windows_amd64.exe'), '');
  }
  mkdirSync(path.join(base, 'v9.0.0'), { recursive: true }); // newest folder, but no binary inside: skipped
  assert.equal(findOsv({ env: {}, home }), path.join(base, 'v2.10.1', 'osv-scanner_windows_amd64.exe'));
  const own = path.join(home, 'mine.exe');
  writeFileSync(own, '');
  assert.equal(findOsv({ env: { CCV3_OSV: own }, home }), own);
  assert.equal(findOsv({ env: { CCV3_OSV: path.join(home, 'gone.exe') }, home: mkdtempSync(path.join(tmpdir(), 'osv-empty-')) }), null);
});

test('O10: lockfilesIn keeps tracked package-lock.json, uv.lock and requirements.txt that still exist, and nothing else', () => {
  const { root } = repo({ files: ['package-lock.json', 'opc/uv.lock', 'opc/scripts/pageindex/requirements.txt', 'docs/requirements.txt.md'] });
  const list = ['package-lock.json', 'opc/uv.lock', 'opc/scripts/pageindex/requirements.txt', 'docs/requirements.txt.md', 'gone/package-lock.json', 'x-package-lock.json', 'a/uv.lock.bak'];
  assert.deepEqual(lockfilesIn(root, list), ['package-lock.json', 'opc/uv.lock', 'opc/scripts/pageindex/requirements.txt']);
});

test('O10b: with no list given, lockfiles come from git ls-files (an ignored, untracked lockfile is left out)', () => {
  const { root } = repo({ files: ['package-lock.json', 'opc/uv.lock', 'node_modules/x/package-lock.json'] });
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, windowsHide: true });
  g('init', '-q');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  g('add', '.');
  assert.deepEqual(lockfilesIn(root), ['opc/uv.lock', 'package-lock.json']);
});
