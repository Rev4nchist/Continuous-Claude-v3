#!/usr/bin/env node
/**
 * scoped-scan-probe.mjs - proves the scope gate in scoped-scan.mjs.
 *
 * It runs the real runner as a subprocess and asserts the allow / deny decision
 * and exit code for each case. The decision, not the scanner, is under test, so
 * it passes whether or not nuclei / trivy / gitleaks are installed.
 *
 * Run: node scripts/security/scoped-scan-probe.mjs
 * Artifact: this script's PASS / FAIL output (AGENTS.md coordination row).
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN = join(__dirname, 'scoped-scan.mjs');
const DENY = 2;

// A fixture registry with a NON-loopback owned host, to exercise registry match.
const fixture = join(tmpdir(), `scoped-scan-fixture-${process.pid}.json`);
writeFileSync(fixture, JSON.stringify({ projects: [{ name: 'staging', url: 'https://staging.example.com' }] }));
const missing = join(tmpdir(), `scoped-scan-missing-${process.pid}.json`); // never created

let pass = 0;
let fail = 0;

function check(label, args, wantExit, wantText, env = {}) {
  const r = spawnSync('node', [SCAN, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const exitOk = r.status === wantExit;
  const textOk = !wantText || out.includes(wantText);
  if (exitOk && textOk) {
    console.log(`PASS  ${label}  (exit ${r.status})`);
    pass++;
  } else {
    console.log(`FAIL  ${label}  (exit ${r.status}, wanted ${wantExit}${wantText ? `, text "${wantText}"` : ''})`);
    console.log(out.split('\n').map((l) => `        ${l}`).join('\n'));
    fail++;
  }
}

try {
  // Deny by default: a host you do not own.
  check('deny public host', ['web', 'http://evil.example.com'], DENY, 'DENIED');
  // Deny a malformed target.
  check('deny non-url', ['web', 'not-a-url'], DENY, 'not a valid URL');
  // Allow loopback (nuclei may be absent; allow path still exits 0).
  check('allow loopback', ['web', 'http://localhost:3000'], 0, 'ALLOWED');
  check('allow dotted-localhost', ['web', 'https://app.localhost/'], 0, 'ALLOWED');
  // Registry match: a non-loopback host that IS in the (fixture) registry.
  check('allow registry host', ['web', 'https://staging.example.com'], 0, 'ALLOWED', { SCOPED_SCAN_REGISTRY: fixture });
  // Same fixture, a different public host is still denied.
  check('deny non-registry host', ['web', 'https://other.example.com'], DENY, 'DENIED', { SCOPED_SCAN_REGISTRY: fixture });
  // Fail closed: unreadable registry => only loopback is owned.
  check('fail closed on bad registry', ['web', 'https://staging.example.com'], DENY, 'DENIED', { SCOPED_SCAN_REGISTRY: missing });
  // allowlist command runs clean.
  check('allowlist exits 0', ['allowlist'], 0, 'owned hosts');
} finally {
  rmSync(fixture, { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
