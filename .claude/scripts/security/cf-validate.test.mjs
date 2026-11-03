// E2E tests for cf-validate.mjs: each case runs the real CLI on a real file.
// Run: node --test .claude/scripts/security/cf-validate.test.mjs
// Failure modes covered, one test each:
//  1 valid record rejected           7 oversize input read
//  2 Windows path accepted           8 invalid UTF-8 accepted
//  3 severity above impact accepted  9 invalid JSON crashes
//  4 unsorted fingerprints accepted 10 deep nesting crashes
//  5 directory read as input        11 missing argument passes
//  6 symlink followed               12 tampered vendored file used

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cf-validate.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'cf-validate-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

function record(fingerprint, overrides = {}) {
  return {
    verdict: 'confirmed',
    fingerprint,
    title: 'Example path traversal in report writer',
    description: 'A crafted name writes outside the output folder.',
    root_cause: 'The name is joined to the base path without a containment check.',
    intended_behavior: 'Reports stay inside the output folder.',
    trace: [
      { kind: 'entrypoint', file: 'src/cli.ts', line: 10, scope: 'main', description: 'Reads the name argument.' },
      { kind: 'sink', file: 'src/write.ts', line: 42, scope: 'writeReport', description: 'Writes to the joined path.' },
    ],
    evidence: [{ file: 'src/write.ts', line: 42, description: 'path.join(base, name) with no check.' }],
    conditions: [{ kind: 'user_interaction', description: 'The user runs the CLI with a crafted name.' }],
    execution: {
      attacker_perspective: 'Local user who controls the name argument.',
      payloads: ['../outside.txt'],
      instructions: ['Run the CLI with the payload as the name.'],
      observed_result: 'A file appears one folder above the output folder.',
    },
    remediation: { strategy: 'Resolve the path and check that it stays inside the base folder.' },
    severity: {
      likelihood: { score: 'medium', reason: 'Needs a local user.' },
      impact: { score: 'medium', reason: 'Writes one file outside the folder.' },
      overall_severity: 'medium',
    },
    confidence: { score: 'high', reason: 'Reproduced locally.' },
    ...overrides,
  };
}

function file(name, content) {
  const path = join(tmp, name);
  writeFileSync(path, content);
  return path;
}

function run(args, cli = CLI) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('1 valid record passes', () => {
  const r = run([file('ok.json', JSON.stringify([record('cli:write:traversal')]))]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS: 1 findings valid/);
});

test('2 Windows path in a trace fails', () => {
  const bad = record('cli:write:traversal');
  bad.trace[0].file = 'src\\cli.ts';
  const r = run([file('winpath.json', JSON.stringify([bad]))]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /trace\[0\]\.file: must be a safe repository-relative source path/);
});

test('3 overall severity above impact fails', () => {
  const bad = record('cli:write:traversal');
  bad.severity.overall_severity = 'critical';
  const r = run([file('sev.json', JSON.stringify([bad]))]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /overall_severity/);
});

test('4 unsorted fingerprints fail', () => {
  const r = run([file('order.json', JSON.stringify([record('b:second'), record('a:first')]))]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /sort/i);
});

test('5 directory input fails', () => {
  const dir = join(tmp, 'adir');
  mkdirSync(dir);
  const r = run([dir]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /regular file/);
});

test('6 symlink input fails', (t) => {
  const target = file('target.json', JSON.stringify([record('cli:write:traversal')]));
  const link = join(tmp, 'link.json');
  try { symlinkSync(target, link, 'file'); } catch (e) {
    if (e.code === 'EPERM') return t.skip('symlink needs Developer Mode or admin on Windows');
    throw e;
  }
  const r = run([link]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /symlink/);
});

test('7 input over 5 MiB fails before parse', () => {
  const r = run([file('big.json', `[${' '.repeat(5 * 1024 * 1024)}]`)]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /byte limit/);
});

test('8 invalid UTF-8 fails', () => {
  const r = run([file('utf8.json', Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]))]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /UTF-8/);
});

test('9 invalid JSON fails cleanly', () => {
  const r = run([file('syntax.json', '[{"verdict": ')]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL: invalid JSON/);
});

test('10 deep nesting fails without a crash', () => {
  const depth = 200000;
  const r = run([file('deep.json', '['.repeat(depth) + ']'.repeat(depth))]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL/);
  assert.doesNotMatch(r.out, /at .*\(.*:\d+:\d+\)/, 'no stack trace');
});

test('11 missing argument fails with usage', () => {
  const r = run([]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Usage/);
});

test('12 tampered vendored file fails the integrity check', () => {
  const copy = join(tmp, 'copy');
  cpSync(join(HERE, 'cf-contract'), join(copy, 'cf-contract'), { recursive: true });
  cpSync(CLI, join(copy, 'cf-validate.mjs'));
  appendFileSync(join(copy, 'cf-contract', 'report-schema.json'), ' ');
  const r = run([file('ok2.json', JSON.stringify([record('cli:write:traversal')]))], join(copy, 'cf-validate.mjs'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /integrity check failed for cf-contract\/report-schema\.json/);
});
