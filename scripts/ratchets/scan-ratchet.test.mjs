// Tests for scan-ratchet.mjs. Run: node --test scripts/ratchets/scan-ratchet.test.mjs
// One test per way the ratchet can fail: a missed new finding, a false alarm on an
// old one, a wrong severity filter, or a bad report/baseline treated as clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trivyCounts, semgrepCounts, osvCounts, osvReport, remapOsvKeys, relativeTo, keyFile, compare, run, InputError } from './scan-ratchet.mjs';

const SCRIPT = fileURLToPath(new URL('./scan-ratchet.mjs', import.meta.url));

const trivy = (vulns, extra = {}) => ({
  SchemaVersion: 2,
  Results: [{ Target: 'opc/uv.lock', Vulnerabilities: vulns, ...extra }],
});
const vuln = (id, sev = 'HIGH', pkg = 'pkg') => ({ VulnerabilityID: id, PkgName: pkg, Severity: sev });
const sg = (results) => ({ results, errors: [] });
const sgr = (id, path, severity = 'ERROR') => ({ check_id: id, path, extra: { severity } });

function tmp(files) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-ratchet-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('trivy: keeps HIGH and CRITICAL, drops MEDIUM and LOW', () => {
  const c = trivyCounts(trivy([vuln('CVE-1', 'HIGH'), vuln('CVE-2', 'CRITICAL'), vuln('CVE-3', 'MEDIUM'), vuln('CVE-4', 'LOW')]));
  assert.deepEqual(Object.keys(c).sort(), ['vuln|opc/uv.lock|CVE-1|pkg', 'vuln|opc/uv.lock|CVE-2|pkg']);
});

test('trivy: counts failed HIGH misconfigs and HIGH secrets, not passed misconfigs', () => {
  const c = trivyCounts(
    trivy([], {
      Misconfigurations: [
        { ID: 'DS002', Status: 'FAIL', Severity: 'HIGH' },
        { ID: 'DS003', Status: 'PASS', Severity: 'HIGH' },
      ],
      Secrets: [{ RuleID: 'aws-key', Severity: 'CRITICAL' }],
    }),
  );
  assert.deepEqual(Object.keys(c).sort(), ['misconf|opc/uv.lock|DS002', 'secret|opc/uv.lock|aws-key']);
});

test('trivy: a report without SchemaVersion is rejected, not read as clean', () => {
  assert.throws(() => trivyCounts({ Results: [] }), InputError);
});

test('semgrep: keeps ERROR, drops WARNING and INFO', () => {
  const c = semgrepCounts(sg([sgr('r.a', 'x.js'), sgr('r.b', 'x.js', 'WARNING'), sgr('r.c', 'x.js', 'INFO')]));
  assert.deepEqual(c, { 'r.a|x.js': 1 });
});

test('semgrep: a file that failed to scan gets one scan-error key, however many errors it had', () => {
  const rep = { results: [], errors: [
    { level: 'warn', type: 'Timeout', path: 'a.js' },
    { level: 'warn', type: 'Timeout', path: 'a.js' },
    { level: 'warn', type: 'Syntax error', path: 'b.yml' },
    { level: 'error', type: 'Network', message: 'no path' },
  ] };
  assert.deepEqual(semgrepCounts(rep), { 'scan-error|a.js': 1, 'scan-error|b.yml': 1 });
});

test('cli: a partial Semgrep report (scan error, no findings) on a changed file fails', () => {
  const dir = tmp({
    'base.json': { tool: 'semgrep', total: 0, counts: {} },
    'r.json': { results: [], errors: [{ level: 'warn', type: 'Syntax error', path: 'new.js' }] },
    'changed.txt': 'new.js\0',
  });
  const res = cli(['--tool', 'semgrep', '--report', join(dir, 'r.json'), '--baseline', join(dir, 'base.json'), '--changed', join(dir, 'changed.txt')]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /NEW {2}scan-error\|new\.js/);
});

test('cli: NUL-separated changed list keeps non-ASCII names, so their new findings block', () => {
  const dir = tmp({
    'base.json': { tool: 'semgrep', total: 0, counts: {} },
    'r.json': sg([sgr('r.a', 'scripts/café.js')]),
    'changed.txt': 'docs/x.md\0scripts/café.js\0',
  });
  const res = cli(['--tool', 'semgrep', '--report', join(dir, 'r.json'), '--baseline', join(dir, 'base.json'), '--changed', join(dir, 'changed.txt')]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /NEW {2}r\.a\|scripts\/café\.js/);
});

test('semgrep: a report without a results array is rejected', () => {
  assert.throws(() => semgrepCounts({ errors: [] }), InputError);
});

test('compare: a new key is a regression', () => {
  assert.equal(compare({ a: 1, b: 1 }, { a: 1 }).regressions.length, 1);
});

test('compare: more hits on a baselined key is a regression', () => {
  assert.deepEqual(compare({ a: 2 }, { a: 1 }).regressions, [{ key: 'a', was: 1, now: 2 }]);
});

test('compare: unchanged and fixed findings pass; fixed are listed', () => {
  const r = compare({ a: 1 }, { a: 1, b: 3 });
  assert.equal(r.regressions.length, 0);
  assert.deepEqual(r.fixed, [{ key: 'b', was: 3, now: 0 }]);
});

test('compare: with a changed set, a new finding in an untouched file is drift, in a touched file it blocks', () => {
  const cur = { 'vuln|opc/uv.lock|CVE-9|p': 1, 'r.x|new.js': 1 };
  const r = compare(cur, {}, new Set(['new.js']));
  assert.deepEqual(r.regressions.map((x) => x.key), ['r.x|new.js']);
  assert.deepEqual(r.drift.map((x) => x.key), ['vuln|opc/uv.lock|CVE-9|p']);
});

test('cli: exit 1 on a new finding, exit 0 on the baseline itself', () => {
  const dir = tmp({ 'r.json': trivy([vuln('CVE-1'), vuln('CVE-9')]) });
  const base = join(dir, 'b.json');
  writeFileSync(join(dir, 'old.json'), JSON.stringify(trivy([vuln('CVE-1')])));
  assert.equal(cli(['--tool', 'trivy', '--report', join(dir, 'old.json'), '--baseline', base, '--update', '--reason', 't']).status, 0);
  assert.equal(cli(['--tool', 'trivy', '--report', join(dir, 'old.json'), '--baseline', base]).status, 0);
  const res = cli(['--tool', 'trivy', '--report', join(dir, 'r.json'), '--baseline', base]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /NEW {2}vuln\|opc\/uv.lock\|CVE-9\|pkg/);
});

test('cli: exit 2 on a missing baseline, a malformed report, or a baseline for the other tool', () => {
  const dir = tmp({ 'r.json': trivy([]), 'bad.json': '{not json', 'sgb.json': { tool: 'semgrep', total: 0, counts: {} } });
  assert.equal(cli(['--tool', 'trivy', '--report', join(dir, 'r.json'), '--baseline', join(dir, 'none.json')]).status, 2);
  assert.equal(cli(['--tool', 'trivy', '--report', join(dir, 'bad.json'), '--baseline', join(dir, 'sgb.json')]).status, 2);
  assert.equal(cli(['--tool', 'trivy', '--report', join(dir, 'r.json'), '--baseline', join(dir, 'sgb.json')]).status, 2);
});

test('update: refuses without a reason, and records the reason and total', () => {
  const dir = tmp({ 'r.json': sg([sgr('r.a', 'x.js'), sgr('r.a', 'x.js')]) });
  const base = join(dir, 'b.json');
  assert.equal(cli(['--tool', 'semgrep', '--report', join(dir, 'r.json'), '--baseline', base, '--update']).status, 2);
  assert.equal(run(['--tool', 'semgrep', '--report', join(dir, 'r.json'), '--baseline', base, '--update', '--reason', 'pre-existing'], () => {}), 0);
  const b = JSON.parse(readFileSync(base, 'utf8'));
  assert.equal(b.reason, 'pre-existing');
  assert.equal(b.total, 2);
  assert.deepEqual(b.counts, { 'r.a|x.js': 2 });
});

// ---------- osv (scanner trial: advisory groups per lockfile; version is left out of the key) ----------
// Shape: real osv-scanner v2.7.0 `scan source --format json` (source.path absolute with forward slashes, groups[].ids and max_severity).

const OSV_ROOT = 'C:\\Users\\dkhay\\continuous-claude';
const osvPkg = (name, groups, ecosystem = 'npm', version = '1.0.0') => ({ package: { name, version, ecosystem }, groups });
const osvGroup = (ids, max_severity) => (max_severity === undefined ? { ids, aliases: [] } : { ids, aliases: [], max_severity });
const osvRep = (path, packages) => ({ results: [{ source: { path, type: 'lockfile' }, packages }] });
const LOCK = 'C:/Users/dkhay/continuous-claude/.claude/hooks/package-lock.json';
const LOCK_KEY = '.claude/hooks/package-lock.json';

test('osv: a string severity 7.5 is counted and 6.9 is not (the field is a string in the report)', () => {
  const c = osvCounts(osvRep(LOCK, [osvPkg('vite', [osvGroup(['GHSA-hi'], '7.5'), osvGroup(['GHSA-lo'], '6.9')])]), OSV_ROOT);
  assert.deepEqual(c, { [`osv|${LOCK_KEY}|GHSA-hi|npm/vite`]: 1 });
});

test('osv: severity exactly 7 is counted', () => {
  assert.equal(Object.keys(osvCounts(osvRep(LOCK, [osvPkg('a', [osvGroup(['X'], '7.0')])]), OSV_ROOT)).length, 1);
});

test('osv: an empty, missing or non-numeric severity is counted (unscored fails safe, not read as 0)', () => {
  const groups = [osvGroup(['E'], ''), osvGroup(['M']), osvGroup(['N'], 'n/a')];
  const c = osvCounts(osvRep(LOCK, [osvPkg('a', groups)]), OSV_ROOT);
  assert.deepEqual(Object.keys(c).map((k) => k.split('|')[2]).sort(), ['E', 'M', 'N']);
});

test('osv: the id order inside a group does not change the key (sorted, first id)', () => {
  const a = osvCounts(osvRep(LOCK, [osvPkg('p', [osvGroup(['B', 'A'], '9')])]), OSV_ROOT);
  const b = osvCounts(osvRep(LOCK, [osvPkg('p', [osvGroup(['A', 'B'], '9')])]), OSV_ROOT);
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a), [`osv|${LOCK_KEY}|A|npm/p`]);
});

test('osv: the version is not in the key, so a bump that does not fix the advisory keeps the key', () => {
  const a = osvCounts(osvRep(LOCK, [osvPkg('p', [osvGroup(['A'], '9')], 'npm', '1.0.0')]), OSV_ROOT);
  const b = osvCounts(osvRep(LOCK, [osvPkg('p', [osvGroup(['A'], '9')], 'npm', '1.0.1')]), OSV_ROOT);
  assert.deepEqual(a, b);
});

// Pure functions on purpose: the Windows spellings and case are tested without path.resolve, so they run on Linux too.
test('osv: two path spellings (worktree root with backslashes, other drive-letter case) give the same relative key', () => {
  const g = [osvPkg('p', [osvGroup(['A'], '9')])];
  const wt = osvCounts(osvRep('C:/Users/dkhay/continuous-claude/.claude/worktrees/x/.claude/hooks/package-lock.json', g), 'C:\\Users\\dkhay\\continuous-claude\\.claude\\worktrees\\x');
  const main = osvCounts(osvRep('c:\\users\\dkhay\\continuous-claude\\.claude\\hooks\\package-lock.json', g), 'C:/Users/dkhay/continuous-claude');
  assert.deepEqual(Object.keys(wt), [`osv|${LOCK_KEY}|A|npm/p`]);
  assert.deepEqual(wt, main);
});

test('osv: a source path outside the root throws InputError (a key never holds an absolute path)', () => {
  const g = [osvPkg('p', [osvGroup(['A'], '9')])];
  assert.throws(() => osvCounts(osvRep('D:/other/package-lock.json', g), OSV_ROOT), InputError);
  // a sibling folder that only shares a name prefix is outside too
  assert.throws(() => osvCounts(osvRep('C:/Users/dkhay/continuous-claude-old/package-lock.json', g), OSV_ROOT), InputError);
});

test('osv: relativeTo strips the root only at a folder boundary and returns null outside it', () => {
  assert.equal(relativeTo('C:/a/b/c.txt', 'C:\\a\\b\\'), 'c.txt');
  assert.equal(relativeTo('C:/a/bc/c.txt', 'C:/a/b'), null);
});

test('osv: a report without a results array is rejected, not read as clean', () => {
  assert.throws(() => osvCounts({ SchemaVersion: 2 }, OSV_ROOT), InputError);
  assert.throws(() => osvCounts(null, OSV_ROOT), InputError);
});

test('osv: an empty results array is a clean report', () => {
  assert.deepEqual(osvCounts({ results: [] }, OSV_ROOT), {});
});

test('osv: keyFile returns the lockfile, so --changed drift works as for the other tools', () => {
  assert.equal(keyFile(`osv|${LOCK_KEY}|A|npm/p`), LOCK_KEY);
});

test('osv: a regression on a lockfile the PR did not change is drift, on a changed one it blocks', () => {
  const cur = { [`osv|${LOCK_KEY}|A|npm/p`]: 1, 'osv|opc/uv.lock|B|PyPI/q': 1 };
  const r = compare(cur, {}, new Set(['opc/uv.lock']));
  assert.deepEqual(r.regressions.map((x) => x.key), ['osv|opc/uv.lock|B|PyPI/q']);
  assert.deepEqual(r.drift.map((x) => x.key), [`osv|${LOCK_KEY}|A|npm/p`]);
});

// A real folder as --root, so the CLI tests behave the same on Windows and on ubuntu-latest (CI): a drive-letter root would be resolved against the cwd on Linux.
const forward = (p) => p.replace(/\\/g, '/');

test('osv cli: --update then a plain run is OK; --root makes relative keys; the baseline keeps every id per key; a trivy baseline is rejected for --tool osv', () => {
  const dir = tmp({ 'tb.json': { tool: 'trivy', total: 0, counts: {} } });
  writeFileSync(join(dir, 'r.json'), JSON.stringify(osvRep(`${forward(dir)}/.claude/hooks/package-lock.json`, [osvPkg('p', [{ ids: ['A', 'Z'], aliases: ['CVE-1'], max_severity: '9' }])])));
  const base = join(dir, 'b.json');
  const common = ['--tool', 'osv', '--report', join(dir, 'r.json'), '--baseline', base, '--root', dir];
  assert.equal(cli([...common, '--update', '--reason', 't']).status, 0);
  const written = JSON.parse(readFileSync(base, 'utf8'));
  assert.deepEqual(written.counts, { [`osv|${LOCK_KEY}|A|npm/p`]: 1 });
  assert.deepEqual(written.ids, { [`osv|${LOCK_KEY}|A|npm/p`]: ['A', 'CVE-1', 'Z'] });
  const ok = cli(common);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /osv ratchet OK: 1 high-severity findings, baseline 1, new 0/);
  const bad = cli(['--tool', 'osv', '--report', join(dir, 'r.json'), '--baseline', join(dir, 'tb.json'), '--root', dir]);
  assert.equal(bad.status, 2);
});

test('osv cli: a report path outside --root exits 2', () => {
  const dir = tmp({ 'b.json': { tool: 'osv', total: 0, counts: {} } });
  const outside = tmp({});
  writeFileSync(join(dir, 'r.json'), JSON.stringify(osvRep(`${forward(outside)}/package-lock.json`, [osvPkg('p', [osvGroup(['A'], '9')])])));
  assert.equal(cli(['--tool', 'osv', '--report', join(dir, 'r.json'), '--baseline', join(dir, 'b.json'), '--root', dir]).status, 2);
});

// ---------- osv key stability: osv.dev adds ids to a group; the key (first sorted id) can change while the advisory does not ----------

const keyOf = (id, pkgName = 'p', lock = LOCK_KEY) => `osv|${lock}|${id}|npm/${pkgName}`;
const grpWith = (ids, aliases = [], max_severity = '9') => ({ ids, aliases, max_severity });

test('osv ids: osvReport lists every id and alias of a key, sorted and without duplicates', () => {
  const rep = osvReport(osvRep(LOCK, [osvPkg('p', [grpWith(['B', 'A'], ['CVE-2', 'A'])])]), OSV_ROOT);
  assert.deepEqual(rep.counts, { [keyOf('A')]: 1 });
  assert.deepEqual(rep.ids, { [keyOf('A')]: ['A', 'B', 'CVE-2'] });
});

test('osv ids: a group that gains a smaller id still matches its baseline key (no new, no fixed)', () => {
  const baseline = { counts: { [keyOf('GHSA-b')]: 1 }, ids: { [keyOf('GHSA-b')]: ['CVE-1', 'GHSA-b'] } };
  const now = osvReport(osvRep(LOCK, [osvPkg('p', [grpWith(['GHSA-b', 'GHSA-a'], ['CVE-1'])])]), OSV_ROOT);
  assert.deepEqual(Object.keys(now.counts), [keyOf('GHSA-a')], 'the raw key did change');
  const mapped = remapOsvKeys(now.counts, now.ids, baseline);
  assert.deepEqual(mapped, { [keyOf('GHSA-b')]: 1 });
  const r = compare(mapped, baseline.counts);
  assert.deepEqual([r.regressions.length, r.drift.length, r.fixed.length], [0, 0, 0]);
});

test('osv ids: a truly new advisory on the same package stays new; an id shared with another package or lockfile does not match', () => {
  const baseline = { counts: { [keyOf('GHSA-b')]: 1 }, ids: { [keyOf('GHSA-b')]: ['CVE-1', 'GHSA-b'] } };
  const fresh = osvReport(osvRep(LOCK, [osvPkg('p', [grpWith(['GHSA-b'], ['CVE-1']), grpWith(['GHSA-new'], ['CVE-9'])])]), OSV_ROOT);
  const r = compare(remapOsvKeys(fresh.counts, fresh.ids, baseline), baseline.counts);
  assert.deepEqual(r.regressions.map((x) => x.key), [keyOf('GHSA-new')]);
  const other = osvReport(osvRep(LOCK, [osvPkg('q', [grpWith(['GHSA-a'], ['CVE-1'])])]), OSV_ROOT);
  assert.deepEqual(Object.keys(remapOsvKeys(other.counts, other.ids, baseline)), [keyOf('GHSA-a', 'q')]);
  const elsewhere = osvReport(osvRep('C:/Users/dkhay/continuous-claude/opc/uv.lock', [osvPkg('p', [grpWith(['GHSA-a'], ['CVE-1'])])]), OSV_ROOT);
  assert.deepEqual(Object.keys(remapOsvKeys(elsewhere.counts, elsewhere.ids, baseline)), [keyOf('GHSA-a', 'p', 'opc/uv.lock')]);
});

test('osv ids: a baseline written before ids were stored (no ids field) is used as it is', () => {
  const baseline = { counts: { [keyOf('GHSA-b')]: 1 } };
  const now = osvReport(osvRep(LOCK, [osvPkg('p', [grpWith(['GHSA-b', 'GHSA-a'])])]), OSV_ROOT);
  assert.deepEqual(remapOsvKeys(now.counts, now.ids, baseline), now.counts);
});

test('osv cli: a group that gains a smaller id after --update is still OK (new 0, fixed 0); a new advisory on the same package fails', () => {
  const dir = tmp({});
  const lock = `${forward(dir)}/.claude/hooks/package-lock.json`;
  const put = (name, groups) => writeFileSync(join(dir, name), JSON.stringify(osvRep(lock, [osvPkg('p', groups)])));
  put('old.json', [grpWith(['GHSA-b'], ['CVE-1'])]);
  put('gained.json', [grpWith(['GHSA-b', 'GHSA-a'], ['CVE-1'])]);
  put('fresh.json', [grpWith(['GHSA-b'], ['CVE-1']), grpWith(['GHSA-new'], ['CVE-9'])]);
  const base = join(dir, 'b.json');
  const args = (report) => ['--tool', 'osv', '--report', join(dir, report), '--baseline', base, '--root', dir];
  assert.equal(cli([...args('old.json'), '--update', '--reason', 't']).status, 0);
  const same = cli(args('gained.json'));
  assert.equal(same.status, 0, same.stdout);
  assert.match(same.stdout, /new 0, drift 0, fixed 0/);
  const bad = cli(args('fresh.json'));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /NEW {2}osv\|\.claude\/hooks\/package-lock\.json\|GHSA-new\|npm\/p/);
});
