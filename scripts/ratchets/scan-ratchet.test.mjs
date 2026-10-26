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
import { trivyCounts, semgrepCounts, compare, run, InputError } from './scan-ratchet.mjs';

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
