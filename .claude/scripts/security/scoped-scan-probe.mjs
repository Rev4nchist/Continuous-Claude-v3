#!/usr/bin/env node
/**
 * scoped-scan-probe.mjs - proves the scope gate.
 *
 * Part 1 tests the pure gate (scope-gate.mjs) with fixture hosts.
 * Part 2 runs the real runner, but only `check` (decision only) and DENY paths,
 * so no scanner ever starts, whatever is installed.
 *
 * Run: node .claude/scripts/security/scoped-scan-probe.mjs
 * Artifact: this script's PASS / FAIL output.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { decide, registryHosts, loadRegistryHosts } from './scope-gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN = join(__dirname, 'scoped-scan.mjs');
const DENY = 2;

let pass = 0;
let fail = 0;
function report(ok, label, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  ok ? pass++ : fail++;
}

// --- Part 1: the pure gate ------------------------------------------------
const owned = registryHosts({ projects: [{ url: 'https://staging.example.com' }, { url: 'stdio (MCP)' }] });
const gateCases = [
  ['deny public host', 'http://evil.example.com', false],
  ['deny non-url', 'not-a-url', false],
  ['allow loopback', 'http://localhost:3000', true],
  ['allow 127.0.0.1', 'http://127.0.0.1:8000', true],
  ['allow dotted-localhost', 'https://app.localhost/', true],
  ['allow registry host', 'https://staging.example.com', true],
  ['deny non-registry host', 'https://other.example.com', false],
  ['deny lookalike suffix', 'https://staging.example.com.evil.net', false],
];
for (const [label, target, want] of gateCases) {
  const d = decide(target, owned);
  report(d.allowed === want, `gate: ${label}`, d.reason);
}
report(owned.size === 1, 'gate: non-URL registry entries skipped', `${owned.size} host`);
const missing = join(tmpdir(), `scoped-scan-missing-${process.pid}.json`);
report(loadRegistryHosts(missing).size === 0, 'gate: unreadable registry fails closed');

// --- Part 2: the runner (decision-only and deny paths) ----------------------
const fixture = join(tmpdir(), `scoped-scan-fixture-${process.pid}.json`);
writeFileSync(fixture, JSON.stringify({ projects: [{ url: 'https://staging.example.com' }] }));

function runCase(label, args, wantExit, wantText, env = {}) {
  const r = spawnSync('node', [SCAN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  report(r.status === wantExit && out.includes(wantText), `runner: ${label}`, `exit ${r.status}`);
}

try {
  runCase('check allows loopback', ['check', 'http://localhost:3000'], 0, 'ALLOWED');
  runCase('check denies public host', ['check', 'http://evil.example.com'], DENY, 'DENIED');
  runCase('web denies public host before any scan', ['web', 'http://evil.example.com'], DENY, 'DENIED');
  // The env override that used to pick the registry must have no effect now.
  runCase('env cannot add an owned host', ['check', 'https://staging.example.com'], DENY, 'DENIED', {
    SCOPED_SCAN_REGISTRY: fixture,
  });
  runCase('allowlist exits 0', ['allowlist'], 0, 'owned hosts');
} finally {
  rmSync(fixture, { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
