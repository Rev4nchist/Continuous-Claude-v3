/**
 * Card coord-flake-ledger: a test that passes only on a retry leaves a record, and the second retry pass of one test in 7 days fails the
 * run. Design: .claudedocs/coordination/2026-11-18-coord-flake-ledger-design.md (rev 2) in the primary checkout. Each test names the failure
 * row it guards (F1-F14, C1-C5 of the note).
 *
 * The ledger code is plain .mjs outside src (no hook build), so it is loaded with a dynamic import and typed here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Row = { at: string; key: string; file: string; line: number | null; retryCount: number; head: string; branch: string; source: string };
type Lib = {
  WINDOW_MS: number;
  recordKey: (root: string, file: string, fullName: string) => string;
  relFile: (root: string, file: string) => string;
  parseLedger: (text: string) => { rows: Row[]; bad: number };
  countInWindow: (rows: Row[], key: string, now: number) => number;
  verdict: (thisRun: Row[], rows: Row[], now: number) => Array<{ row: Row; count: number }>;
  appendRow: (path: string, row: Row) => { ok: boolean; error?: string };
  printedLines: (o: { thisRun: Row[]; failing: Array<{ row: Row; count: number }>; warn: string | null; bad: number; path: string }) => string[];
  ledgerPath: (env: Record<string, string | undefined>) => string;
};

const HOOKS = fileURLToPath(new URL('../..', import.meta.url));
const SUPPORT = join(HOOKS, 'test-support');
const FIXTURE = join(SUPPORT, 'fixtures', 'retry-once');
// Resolved, not joined: a nested worktree finds vitest through the shared store link (.claude/worktrees/node_modules), CI in .claude/hooks.
const VITEST = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const MARKER = 'ZEBRAQUOKKA';
const DAY = 24 * 3600 * 1000;

let lib: Lib;
let tmp: string;

beforeAll(async () => {
  lib = (await import(pathToFileURL(join(SUPPORT, 'flake-ledger.mjs')).href)) as Lib;
  tmp = mkdtempSync(join(tmpdir(), 'flake-ledger-'));
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const row = (key: string, ageDays: number, now: number): Row => ({
  at: new Date(now - ageDays * DAY).toISOString(), key, file: key.split(' > ')[0], line: 3, retryCount: 1, head: 'h', branch: 'b', source: 'local',
});

describe('flake-ledger lib', () => {
  it('C2: one key for one test across roots and path styles', () => {
    const a = lib.recordKey('C:\\w\\one\\.claude\\hooks', 'C:\\w\\one\\.claude\\hooks\\src\\__tests__\\x.test.ts', 'suite > case');
    const b = lib.recordKey('/home/r/two/.claude/hooks', '/home/r/two/.claude/hooks/src/__tests__/x.test.ts', 'suite > case');
    expect(a).toBe('src/__tests__/x.test.ts > suite > case');
    expect(b).toBe(a);
  });

  it('F6: a row of 6.9 days counts, a row of 7.1 days does not', () => {
    const now = Date.now();
    const rows = [row('k', 6.9, now), row('k', 7.1, now), row('other', 1, now)];
    expect(lib.countInWindow(rows, 'k', now)).toBe(1);
  });

  it('C1: two old rows and no retry pass in this run fail nothing', () => {
    const now = Date.now();
    expect(lib.verdict([], [row('A', 1, now), row('A', 2, now)], now)).toEqual([]);
  });

  it('a retry pass now fails only with a second row in 7 days', () => {
    const now = Date.now();
    const cur = row('A', 0, now);
    expect(lib.verdict([cur], [cur], now)).toEqual([]);
    const out = lib.verdict([cur], [row('A', 3, now), cur], now);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
    expect(lib.verdict([cur], [row('A', 8, now), cur], now)).toEqual([]);
  });

  it('F7: a bad ledger line is skipped and counted', () => {
    const now = Date.now();
    const text = `${JSON.stringify(row('A', 1, now))}\nnot json\n{"key":1}\n\n${JSON.stringify(row('B', 1, now))}\n`;
    const { rows, bad } = lib.parseLedger(text);
    expect(rows.map((r) => r.key)).toEqual(['A', 'B']);
    expect(bad).toBe(2);
  });

  it('F10: a failed write returns an error and the printed lines carry a WARN line', () => {
    const dirAsFile = join(tmp, 'is-a-dir');
    mkdirSync(dirAsFile);
    const now = Date.now();
    const res = lib.appendRow(dirAsFile, row('A', 0, now));
    expect(res.ok).toBe(false);
    const lines = lib.printedLines({ thisRun: [row('A', 0, now)], failing: [], warn: res.error ?? 'x', bad: 0, path: dirAsFile });
    expect(lines.some((l) => l.startsWith('FLAKE LEDGER WARN'))).toBe(true);
  });

  it('F9: printed lines name file:line and counts, never the test name', () => {
    const now = Date.now();
    const r = { ...row(`src/a.test.ts > ${MARKER} case`, 0, now), file: 'src/a.test.ts', line: 12 };
    const lines = lib.printedLines({ thisRun: [r], failing: [{ row: r, count: 2 }], warn: null, bad: 1, path: '/p' });
    expect(lines.join('\n')).not.toContain(MARKER);
    expect(lines).toContain('FLAKE LEDGER FAIL src/a.test.ts:12 (2 in 7 days)');
    expect(lines[lines.length - 1]).toMatch(/^FLAKE LEDGER: 1 retry pass\(es\) this run, 1 at the limit/);
  });

  it('F8: the ledger path follows FLAKE_LEDGER_PATH, else the shared state file', () => {
    expect(lib.ledgerPath({ FLAKE_LEDGER_PATH: '/x/y.jsonl' })).toBe('/x/y.jsonl');
    expect(lib.ledgerPath({}).replace(/\\/g, '/')).toMatch(/\/\.claude\/state\/flake-ledger\.jsonl$/);
  });
});

/** One real vitest run of the fixture project with the reporter. Every run gets a temp ledger (F8). */
function runFixture(ledger: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [VITEST, 'run', '--root', FIXTURE, '--config', join(FIXTURE, 'vitest.fixture.config.mjs'), '--retry=2',
    '--includeTaskLocation', '--reporter=default', `--reporter=${join(SUPPORT, 'flake-ledger-reporter.mjs')}`], {
    cwd: FIXTURE, encoding: 'utf8', windowsHide: true, timeout: 90_000,
    env: { ...process.env, FLAKE_LEDGER_PATH: ledger, GITHUB_STEP_SUMMARY: '', ...env },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const flakeLines = out.split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter((l) => l.startsWith('FLAKE LEDGER'));
  const rows = existsSync(ledger) && statSync(ledger).isFile() ? lib.parseLedger(readFileSync(ledger, 'utf8')).rows : [];
  return { status: r.status, out, flakeLines, rows };
}

describe('flake-ledger reporter, real vitest on the fixture (F2-F5, F8, F9, C1, C3)', () => {
  it('records a retry pass, fails the second in 7 days, ignores clean passes, and keeps names off the printed lines', () => {
    const ledger = join(tmp, 'e2e.jsonl');
    const summary = join(tmp, 'summary.md');

    // F2, F8: run 1 records exactly one row, in the temp ledger the child names.
    const r1 = runFixture(ledger);
    expect(r1.status, r1.out).toBe(0);
    expect(r1.rows).toHaveLength(1);
    expect(r1.rows[0].key).toBe(`retry-once.fixture.mjs > ${MARKER} passes on try 2`);
    expect(r1.rows[0].line).toBeGreaterThan(0);
    expect(r1.flakeLines.at(-1)).toContain(`ledger ${ledger}`);

    // F4, F5, F9, C3: run 2 fails on the second row; the summary file gets the printed lines only.
    const r2 = runFixture(ledger, { GITHUB_STEP_SUMMARY: summary });
    expect(r2.status, r2.out).not.toBe(0);
    expect(r2.flakeLines.some((l) => /^FLAKE LEDGER FAIL retry-once\.fixture\.mjs:\d+ \(2 in 7 days\)$/.test(l))).toBe(true);
    expect(r2.flakeLines.join('\n')).not.toContain(MARKER);
    const sum = readFileSync(summary, 'utf8');
    expect(sum).not.toContain(MARKER);
    expect(sum).toContain('FLAKE LEDGER FAIL retry-once.fixture.mjs:');

    // C1: history holds 2 rows of the key, this run passes at once: exit 0, no FAIL line, no new row.
    const r3 = runFixture(ledger, { FIXTURE_NO_FLAKE: '1' });
    expect(r3.status, r3.out).toBe(0);
    expect(r3.flakeLines.some((l) => l.startsWith('FLAKE LEDGER FAIL'))).toBe(false);
    expect(r3.rows).toHaveLength(2);

    // F3: a full fail, a plain pass and a skip add no row (fresh ledger; exit 1 from the full fail).
    const fresh = join(tmp, 'fresh.jsonl');
    const r4 = runFixture(fresh, { FIXTURE_FAIL: '1' });
    expect(r4.status, r4.out).not.toBe(0);
    expect(r4.rows.map((r) => r.key)).toEqual([`retry-once.fixture.mjs > ${MARKER} passes on try 2`]);
  }, 300_000);

  it('F10 end to end: an unwritable ledger warns and leaves the result at pass', () => {
    const dirAsLedger = join(tmp, 'ledger-dir');
    mkdirSync(dirAsLedger);
    const r = runFixture(dirAsLedger);
    expect(r.status, r.out).toBe(0);
    expect(r.flakeLines.some((l) => l.startsWith('FLAKE LEDGER WARN'))).toBe(true);
  }, 120_000);

  it('F11, C5: the fixture is outside the hooks test include and the gate-coverage test pattern', () => {
    const name = 'test-support/fixtures/retry-once/retry-once.fixture.mjs';
    expect(existsSync(join(HOOKS, name))).toBe(true);
    expect(/^src\/__tests__\/.*\.test\.ts$/.test(name)).toBe(false);
    expect(/\.test\.(mjs|js|cjs|ts|tsx|sh|ps1)$|\.spec\.(ts|js)$/.test(name)).toBe(false);
  });
});
