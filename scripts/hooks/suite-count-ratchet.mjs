#!/usr/bin/env node
/**
 * suite-count-ratchet -- the hook test suite may not silently shrink.
 *
 * WHAT THIS IS FOR
 * ----------------
 * On 2026-07-29 `npx vitest run` in .claude/hooks was found to have never
 * returned a verdict. Two defects: a bare module-scope `main()` awaiting stdin,
 * and ~10.4s x6 inside a synchronous spawnSync that vitest's testTimeout cannot
 * interrupt. While it hung, 93 tests were red -- 83 of them for a full month --
 * and nobody could have known, because there was no number to compare against.
 *
 * A pass/fail verdict alone would not have caught it either. The 83 fossils
 * failed loudly; what hid them was that no one ever saw the end of a run. And
 * the inverse failure is just as quiet: a test file that stops being COLLECTED
 * (wrong extension, an import that throws at load, `node:test` instead of
 * vitest) removes its tests from the total while the suite still reports green.
 * Three files had exactly that shape -- 39 tests that had never run once.
 *
 * So this ratchet asserts three things, in this order:
 *   1. zero failures
 *   2. passed   >= baseline.passed   (nothing silently stopped passing)
 *   3. collected >= baseline.collected (nothing silently stopped being collected)
 *
 * (3) is the one that matters most and the one a plain `vitest run` cannot give
 * you. Deleting a test file lowers `collected` and trips it; that is intended --
 * a deliberate deletion is a deliberate baseline update, in the same commit,
 * with the reason in the message.
 *
 * NON-VACUITY
 * -----------
 * This repo's recurring defect is a green check whose subject count is zero: an
 * ESLint boundary linting zero files, a registration gate passing on 0 of 85
 * while 85 fired, a scheduled task exiting 0 after 28 straight failures. A
 * ratchet comparing 0 >= 0 would join that list. So a baseline at or below
 * MIN_CREDIBLE_TESTS is itself a failure, and a run that collects fewer than
 * that fails before any comparison happens.
 *
 * USAGE
 *   node scripts/hooks/suite-count-ratchet.mjs             # exit 1 on regression
 *   node scripts/hooks/suite-count-ratchet.mjs --json
 *   node scripts/hooks/suite-count-ratchet.mjs --update    # rewrite the baseline
 *
 * --update is deliberately manual. It prints the delta it is about to record and
 * refuses to lower a count unless --allow-shrink is also passed, so a regression
 * cannot be laundered into the baseline by muscle memory.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const HOOKS = join(REPO, '.claude', 'hooks');
const BASELINE_PATH = join(HERE, 'suite-baseline.json');

/** Below this, the run itself is broken and no comparison is meaningful. */
const MIN_CREDIBLE_TESTS = 1500;

const flags = new Set(process.argv.slice(2));

/**
 * vitest's own JS entrypoint, invoked with plain `node`.
 *
 * NOT `npx`: execFileSync('npx.cmd', ...) fails to spawn at all here (status
 * null, empty stderr), which looked exactly like "the suite hung" -- the very
 * condition this script is supposed to detect. Calling the entry directly removes
 * a shim that can fail silently between the guard and the thing being guarded.
 */
const VITEST_BIN = join(HOOKS, 'node_modules', 'vitest', 'vitest.mjs');

function runSuite() {
  const dir = mkdtempSync(join(tmpdir(), 'suite-ratchet-'));
  const outFile = join(dir, 'result.json');
  try {
    if (!existsSync(VITEST_BIN)) {
      throw new Error(`vitest not installed at ${VITEST_BIN} -- run npm install in .claude/hooks`);
    }
    let spawnFailure = null;
    try {
      execFileSync(
        process.execPath,
        [VITEST_BIN, 'run', '--reporter=json', `--outputFile=${outFile}`],
        { cwd: HOOKS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60_000 }
      );
    } catch (e) {
      // vitest exits nonzero when tests FAIL, and the JSON report is still written
      // -- that case is normal and handled below. But a failure to spawn, or a
      // timeout, writes nothing, and must not be reported as a hang without saying
      // what actually happened.
      spawnFailure = e;
    }
    if (!existsSync(outFile) && spawnFailure) {
      throw new Error(
        `vitest could not be run (status=${spawnFailure.status}, signal=${spawnFailure.signal}, ` +
          `code=${spawnFailure.code}): ${String(spawnFailure.stderr || spawnFailure.message).slice(0, 500)}`
      );
    }
    if (!existsSync(outFile)) {
      throw new Error(
        'vitest produced no JSON report. The run did not complete -- check for a hang ' +
          '(a synchronous spawnSync cannot be interrupted by testTimeout) or a leaked ' +
          'vitest tree from an earlier run (taskkill /PID <n> /T /F).'
      );
    }
    const r = JSON.parse(readFileSync(outFile, 'utf8'));
    return {
      passed: r.numPassedTests ?? 0,
      failed: r.numFailedTests ?? 0,
      pending: r.numPendingTests ?? 0,
      collected: r.numTotalTests ?? 0,
      files: r.numTotalTestSuites ?? (r.testResults?.length ?? 0),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const actual = runSuite();

if (flags.has('--update')) {
  const prev = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : null;
  if (actual.failed > 0) {
    console.error(
      `[suite-count-ratchet] refusing to record a baseline with ${actual.failed} failing test(s). ` +
        `Fix them first -- a baseline is a statement that this state is good.`
    );
    process.exit(1);
  }
  if (actual.collected < MIN_CREDIBLE_TESTS) {
    console.error(
      `[suite-count-ratchet] refusing: only ${actual.collected} tests collected (< ${MIN_CREDIBLE_TESTS}). ` +
        `The run is broken, not improved.`
    );
    process.exit(1);
  }
  if (prev) {
    const shrinks = [];
    if (actual.passed < prev.passed) shrinks.push(`passed ${prev.passed} -> ${actual.passed}`);
    if (actual.collected < prev.collected)
      shrinks.push(`collected ${prev.collected} -> ${actual.collected}`);
    if (shrinks.length && !flags.has('--allow-shrink')) {
      console.error(
        `[suite-count-ratchet] refusing to lower the baseline (${shrinks.join(', ')}).\n` +
          `  If tests were deliberately deleted, re-run with --allow-shrink and say why in the commit.`
      );
      process.exit(1);
    }
    console.log(`[suite-count-ratchet] baseline ${prev.passed}/${prev.collected} -> ${actual.passed}/${actual.collected}`);
  }
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment:
          'Baseline for suite-count-ratchet. Update ONLY via --update, in the same commit as the ' +
          'change that moved it, with the reason in the commit message.',
        passed: actual.passed,
        collected: actual.collected,
        files: actual.files,
        recorded: new Date().toISOString().slice(0, 10),
      },
      null,
      2
    ) + '\n'
  );
  console.log(`[suite-count-ratchet] recorded ${actual.passed} passed / ${actual.collected} collected`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(
    `[suite-count-ratchet] no baseline at ${BASELINE_PATH}. Create one with --update once the suite is green.`
  );
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

const failures = [];
if (!baseline.passed || baseline.passed < MIN_CREDIBLE_TESTS) {
  failures.push(
    `VACUOUS BASELINE: baseline.passed is ${baseline.passed} (< ${MIN_CREDIBLE_TESTS}). ` +
      `A ratchet comparing against ~0 asserts nothing.`
  );
}
if (actual.collected < MIN_CREDIBLE_TESTS) {
  failures.push(
    `VACUOUS RUN: only ${actual.collected} tests collected (< ${MIN_CREDIBLE_TESTS}). The run is broken.`
  );
}
if (actual.failed > 0) failures.push(`${actual.failed} failing test(s).`);
if (actual.passed < baseline.passed) {
  failures.push(
    `PASS COUNT DROPPED: ${actual.passed} < baseline ${baseline.passed} (-${baseline.passed - actual.passed}).`
  );
}
if (actual.collected < baseline.collected) {
  failures.push(
    `COLLECTED COUNT DROPPED: ${actual.collected} < baseline ${baseline.collected} ` +
      `(-${baseline.collected - actual.collected}). A test file stopped being collected -- check for an ` +
      `import that throws at load, a node:test import, or a deleted file.`
  );
}

const report = {
  guard: 'suite-count-ratchet',
  baseline: { passed: baseline.passed, collected: baseline.collected, recorded: baseline.recorded },
  actual,
  pass: failures.length === 0,
  failures,
};

if (flags.has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `[suite-count-ratchet] baseline ${baseline.passed} passed / ${baseline.collected} collected ` +
      `(recorded ${baseline.recorded})`
  );
  console.log(
    `[suite-count-ratchet] actual   ${actual.passed} passed / ${actual.collected} collected / ${actual.failed} failed`
  );
  if (failures.length === 0) console.log('[suite-count-ratchet] PASS');
  else for (const f of failures) console.error(`[suite-count-ratchet] FAIL: ${f}`);
}

process.exit(report.pass ? 0 : 1);
