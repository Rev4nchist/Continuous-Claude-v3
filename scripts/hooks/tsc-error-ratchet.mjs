#!/usr/bin/env node
/**
 * tsc-error-ratchet — the type-error count may not grow.
 *
 * Runs `tsc --noEmit` in .claude/hooks and FAILS (exit 1) when the error
 * count exceeds BASELINE. Lowering the baseline after a genuine fix is a
 * manual, deliberate edit here — the ratchet only stops silent growth.
 *
 * Census and per-file breakdown: docs/harness-strategy/2026-08-30-tsc-error-census.md
 * (90% of the debt is four session-* test files missing vitest imports).
 *
 * Override for a deliberate exception: TSC_RATCHET_BASELINE=<n> env var.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// 235 at first census (2026-08-30); lowered to 229 by the Step-10 archive
// moving 6 error-carrying orphan hooks out of src (2026-08-31).
const BASELINE = Number(process.env.TSC_RATCHET_BASELINE ?? 229);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hooksDir = resolve(repoRoot, '.claude', 'hooks');

const r = spawnSync('npx', ['tsc', '--noEmit'], {
  cwd: hooksDir,
  encoding: 'utf-8',
  shell: process.platform === 'win32', // npx is npx.cmd on Windows
  timeout: 300_000,
});

if (r.error) {
  console.error(`FAIL  tsc-error-ratchet  could not run tsc: ${r.error.message}`);
  process.exit(1);
}

const out = `${r.stdout || ''}\n${r.stderr || ''}`;
const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));

// A guard that counts zero because tsc never ran is vacuous — require the
// run to have produced output or a clean exit status.
if (errors.length === 0 && r.status !== 0) {
  console.error(`FAIL  tsc-error-ratchet  tsc exited ${r.status} but no parseable errors — refusing a vacuous PASS`);
  process.exit(1);
}

if (errors.length > BASELINE) {
  console.error(`FAIL  tsc-error-ratchet  ${errors.length} errors > baseline ${BASELINE} (${errors.length - BASELINE} new)`);
  // Show a sample of what likely grew: the least-common files first.
  const byFile = new Map();
  for (const l of errors) {
    const f = l.split('(')[0];
    byFile.set(f, (byFile.get(f) || 0) + 1);
  }
  for (const [f, c] of [...byFile.entries()].sort((a, b) => a[1] - b[1]).slice(0, 10)) {
    console.error(`  ${String(c).padStart(3)}  ${f}`);
  }
  process.exit(1);
}

console.log(`PASS  tsc-error-ratchet  ${errors.length} errors <= baseline ${BASELINE}`);
