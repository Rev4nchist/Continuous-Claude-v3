/**
 * vitest reporter of the flake ledger (card coord-flake-ledger). Both gates add it next to the default reporter:
 *   --includeTaskLocation --reporter=default --reporter=./test-support/flake-ledger-reporter.mjs
 * pre-pr gate hooks-vitest runs in .claude/hooks (pre-pr.mjs), the CI step in working-directory .claude/hooks (ccv3-checks.yml).
 *
 * Each retry pass is written at once (a crash later keeps the row). At the end of the run it prints the FLAKE LEDGER lines, copies them to
 * $GITHUB_STEP_SUMMARY when set, and sets exit code 1 when a test of this run is at the limit.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { appendRow, isRunRetry, ledgerPath, parseLedger, printedLines, recordKey, relFile, verdict } from './flake-ledger.mjs';

function gitValue(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : '';
}

export default class FlakeLedgerReporter {
  constructor() {
    this.root = process.cwd();
    this.path = ledgerPath();
    this.thisRun = [];
    this.warn = null;
    this.git = null;
  }

  onInit(vitest) {
    this.root = vitest?.config?.root ?? this.root;
    this.runRetry = vitest?.config?.retry;
  }

  gitFacts() {
    if (!this.git) this.git = { head: gitValue(this.root, ['rev-parse', 'HEAD']), branch: gitValue(this.root, ['rev-parse', '--abbrev-ref', 'HEAD']) };
    return this.git;
  }

  onTestCaseResult(testCase) {
    const diag = testCase.diagnostic?.();
    if (!diag?.flaky || testCase.result?.().state !== 'passed') return;
    // A test with its own retry option chose that retry; only a retry of the run (--retry) can hide an error unseen.
    if (!isRunRetry(testCase.options?.retry, this.runRetry)) return;
    const file = testCase.module.moduleId;
    const row = {
      at: new Date().toISOString(),
      key: recordKey(this.root, file, testCase.fullName),
      file: relFile(this.root, file),
      line: testCase.location?.line ?? null,
      retryCount: diag.retryCount,
      ...this.gitFacts(),
      source: process.env.GITHUB_ACTIONS ? 'ci' : 'local',
    };
    this.thisRun.push(row);
    const res = appendRow(this.path, row);
    if (!res.ok && !this.warn) this.warn = res.error;
  }

  onTestRunEnd() {
    let rows = [];
    let bad = 0;
    try {
      ({ rows, bad } = parseLedger(readFileSync(this.path, 'utf8')));
    } catch (err) {
      // No ledger yet: only this run's rows. Any other read error is a warning, never a fail.
      if (err?.code !== 'ENOENT' && !this.warn) this.warn = String(err?.code ?? err);
    }
    // A failed write leaves this run's rows out of the file: count them anyway.
    const all = this.warn ? [...rows, ...this.thisRun.filter((t) => !rows.some((r) => r.at === t.at && r.key === t.key))] : rows;
    const failing = verdict(this.thisRun, all, Date.now());
    const lines = printedLines({ thisRun: this.thisRun, failing, warn: this.warn, bad, path: this.path });
    process.stdout.write(`\n${lines.join('\n')}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${lines.join('\n')}\n`, 'utf8');
      } catch {
        // The summary is a copy; the printed lines stand.
      }
    }
    if (failing.length > 0) process.exitCode = 1;
  }
}
