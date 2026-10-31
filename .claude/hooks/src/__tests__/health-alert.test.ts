/**
 * Health alert: the SessionStart line that tells Dave the harness doctor found a problem
 * or has stopped running (design 2026-10-31, section 3), and the FAIL-only toast script.
 *
 * Failure list (one test each):
 *   H1  a fresh report with 0 fail and 0 warn produces a line (must be silent)
 *   H2  a fresh report with problems loses the counts, the time or the check names
 *   H3  fail names do not come before warn names, or the name list is not capped
 *   H4  a healthy report older than 36 h stays silent (the dead-man switch does not fire)
 *   H5  a report at 35 h 59 min is called stale, or at 36 h 1 min is not
 *   H6  a missing file gives no line (Dave never learns the doctor has never run)
 *   H7  an unreadable, non-JSON or wrongly shaped file throws or gives a line
 *   H8  the env override is ignored, so a test or run reads the real ~/.claude file
 *   H9  buildSessionStartOutput drops the harness line from systemMessage or additionalContext
 *   H10 a report with no usable ts is not aged by the file time
 *   T1  the toast script shows a toast for a warn-only report
 *   T2  the toast script shows the same fail set twice
 *   T3  the toast script stays silent after a changed fail set
 *   T4  the toast script crashes (non-zero exit) on a missing or corrupt report
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatHealthAlert, healthAlertLine } from '../shared/health-alert.js';
import { buildSessionStartOutput } from '../shared/session-start-output.js';

const HOUR = 3600_000;
// Local components, so the expected "2026-10-31 07:50" holds in every time zone.
const REPORT_TIME = new Date(2026, 9, 31, 7, 50, 0);
const REPORT_TEXT = '2026-10-31 07:50';
const at = (hoursLater: number) => new Date(REPORT_TIME.getTime() + hoursLater * HOUR);

type Status = 'PASS' | 'WARN' | 'FAIL';
function report(checks: Array<[Status, string, string]>, ts: Date | string = REPORT_TIME) {
  const n = (s: Status) => checks.filter((c) => c[0] === s).length;
  return {
    ts: typeof ts === 'string' ? ts : ts.toISOString(),
    summary: { pass: n('PASS'), warn: n('WARN'), fail: n('FAIL') },
    checks: checks.map(([status, section, check]) => ({ status, section, check, detail: 'x' })),
  };
}

describe('formatHealthAlert', () => {
  it('H1: a fresh report with 0 fail and 0 warn is silent', () => {
    const doc = report([['PASS', 'hooks', 'a'], ['PASS', 'sync', 'b']]);
    expect(formatHealthAlert(doc, at(1))).toBeNull();
  });

  it('H2: problems give counts, the report time and the check names', () => {
    const doc = report([['FAIL', 'hooks', 'build-fresh'], ['WARN', 'sync', 'quarantine'], ['PASS', 'x', 'y']]);
    expect(formatHealthAlert(doc, at(1))).toBe(
      `harness: 1 fail, 1 warn as of ${REPORT_TEXT}: hooks:build-fresh, sync:quarantine. Run: node scripts/harness-doctor.mjs`,
    );
  });

  it('H3: fail names come before warn names and the list is capped', () => {
    const doc = report([
      ['WARN', 'w', '1'], ['WARN', 'w', '2'], ['WARN', 'w', '3'],
      ['FAIL', 'f', '1'], ['FAIL', 'f', '2'],
    ]);
    const line = formatHealthAlert(doc, at(1)) ?? '';
    expect(line).toContain('2 fail, 3 warn');
    expect(line).toContain('f:1, f:2, w:1 and 2 more.');
    expect(line).not.toContain('w:3');
  });

  it('H11: the run hint names the repo from the report, so it works outside continuous-claude', () => {
    const doc = { ...report([['FAIL', 'hooks', 'a']]), repo: 'C:\\Users\\x\\continuous-claude' };
    expect(formatHealthAlert(doc, at(1))).toContain('Run: node "C:\\Users\\x\\continuous-claude/scripts/harness-doctor.mjs"');
    const blank = { ...report([['FAIL', 'hooks', 'a']]), repo: '' };
    expect(formatHealthAlert(blank, at(1))).toContain('Run: node scripts/harness-doctor.mjs');
  });

  it('H4: a healthy report older than 36 h says the doctor has not run', () => {
    const doc = report([['PASS', 'hooks', 'a']]);
    expect(formatHealthAlert(doc, at(48))).toBe(`harness doctor has not run since ${REPORT_TEXT}`);
  });

  it('H5: the 36 h limit is exact', () => {
    const doc = report([['PASS', 'hooks', 'a']]);
    expect(formatHealthAlert(doc, at(35.99))).toBeNull();
    expect(formatHealthAlert(doc, at(36.02))).toContain('has not run since');
  });

  it('H7: a wrongly shaped document gives no line and does not throw', () => {
    for (const bad of [null, 42, 'text', [], {}, { ts: 5, checks: 'no' }]) {
      expect(() => formatHealthAlert(bad, at(1))).not.toThrow();
      expect(formatHealthAlert(bad, at(1))).toBeNull();
    }
  });

  it('H10: a report with no usable ts is aged by the fallback time', () => {
    const doc = report([['PASS', 'hooks', 'a']], 'not a date');
    expect(formatHealthAlert(doc, at(100), REPORT_TIME)).toBe(`harness doctor has not run since ${REPORT_TEXT}`);
    expect(formatHealthAlert(doc, at(1), REPORT_TIME)).toBeNull();
  });
});

describe('healthAlertLine (file reading)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'health-alert-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('H6: a missing file says the doctor has never run', () => {
    expect(healthAlertLine({ path: join(dir, 'nope.json'), now: at(1) }))
      .toBe('harness doctor has never run. Run: node scripts/harness-doctor.mjs');
  });

  it('H7: a corrupt file or a directory in place of the file gives no line and does not throw', () => {
    const corrupt = join(dir, 'latest.json');
    writeFileSync(corrupt, '{ not json');
    expect(healthAlertLine({ path: corrupt, now: at(1) })).toBeNull();
    expect(healthAlertLine({ path: dir, now: at(1) })).toBeNull();
  });

  it('H8: CCV3_HEALTH_LATEST overrides the default path', () => {
    const file = join(dir, 'latest.json');
    writeFileSync(file, JSON.stringify(report([['FAIL', 'hooks', 'boom']])));
    const old = process.env.CCV3_HEALTH_LATEST;
    process.env.CCV3_HEALTH_LATEST = file;
    try {
      expect(healthAlertLine({ now: at(1) })).toContain('1 fail, 0 warn');
    } finally {
      if (old === undefined) delete process.env.CCV3_HEALTH_LATEST; else process.env.CCV3_HEALTH_LATEST = old;
    }
  });

  it('H10: a ts-less report is aged by the file modification time', () => {
    const file = join(dir, 'latest.json');
    writeFileSync(file, JSON.stringify({ summary: { pass: 1, warn: 0, fail: 0 }, checks: [] }));
    utimesSync(file, REPORT_TIME, REPORT_TIME);
    expect(healthAlertLine({ path: file, now: at(72) })).toBe(`harness doctor has not run since ${REPORT_TEXT}`);
  });
});

describe('buildSessionStartOutput with a harness line', () => {
  const MEM = { line: 'Memory: 130 lessons', warn: false };
  const ALERT = 'harness: 1 fail, 0 warn as of 2026-10-31 07:50: hooks:boom. Run: node scripts/harness-doctor.mjs';

  it('H9: the harness line reaches Dave and the model, after the memory line', () => {
    const out = buildSessionStartOutput('daemon', MEM, ALERT);
    expect(out.systemMessage).toBe(`${MEM.line}\n${ALERT}`);
    expect(out.hookSpecificOutput.additionalContext).toBe(`daemon\n${MEM.line}\n${ALERT}`);
  });

  it('H9: a null harness line changes nothing', () => {
    expect(buildSessionStartOutput('daemon', MEM, null)).toEqual(buildSessionStartOutput('daemon', MEM));
  });
});

const TOAST = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../scripts/scheduled/health-toast.ps1');

// Each test starts powershell.exe up to four times; the 5 s default fails under full-suite load.
describe.skipIf(process.platform !== 'win32')('health-toast.ps1 (-DryRun)', { timeout: 120_000 }, () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'health-toast-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const run = () => spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TOAST,
      '-Latest', join(dir, 'latest.json'), '-StateFile', join(dir, 'toast-state.txt'), '-DryRun'],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  const put = (checks: Array<[Status, string, string]>) =>
    writeFileSync(join(dir, 'latest.json'), JSON.stringify(report(checks)));

  it('T1: a warn-only report shows no toast', () => {
    put([['WARN', 'sync', 'quarantine'], ['PASS', 'a', 'b']]);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('NO TOAST');
  });

  it('T2: a fail set toasts once, then stays quiet while it is unchanged', () => {
    put([['FAIL', 'hooks', 'build-fresh']]);
    const first = run();
    expect(first.stdout).toContain('TOAST: ');
    expect(first.stdout).not.toContain('NO TOAST');
    expect(first.stdout).toContain('hooks:build-fresh');
    expect(run().stdout).toContain('NO TOAST');
  });

  it('T3: a changed fail set toasts again, and a recovery re-arms the toast', () => {
    put([['FAIL', 'hooks', 'a']]);
    run();
    put([['FAIL', 'hooks', 'a'], ['FAIL', 'hooks', 'b']]);
    expect(run().stdout).toContain('hooks:b');
    put([['PASS', 'hooks', 'a']]);
    expect(run().stdout).toContain('NO TOAST');
    put([['FAIL', 'hooks', 'a'], ['FAIL', 'hooks', 'b']]);
    expect(run().stdout).not.toContain('NO TOAST');
  });

  it('T4: a missing or corrupt report exits 0 with no toast', () => {
    expect(run().status).toBe(0);
    writeFileSync(join(dir, 'latest.json'), '{ nope');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('NO TOAST');
  });
});
