/**
 * B5: after /compact, SessionStart hooks print nothing when healthy and do no startup-only work.
 *
 * Failure list (one test each, real functions imported):
 *   C1  the stdin payload parse throws on empty, invalid or oddly shaped JSON
 *   C2  a missing or non-string `source` is not treated as a startup
 *   C3  only the literal `compact` counts as compact (resume and clear still do startup work)
 *   C4  a healthy memory line is still printed after compact
 *   C5  a degraded memory line is hidden after compact
 *   C6  the startup output changed (healthy line must still print)
 *   C7  a compact consumes the failed-writes marker, so the next real start reports 0
 *   C8  a startup does not write the marker (failures are re-reported forever)
 *   C9  a WARN-only doctor report with the same warning set prints again after compact
 *   C10 a changed warning set stays silent after compact
 *   C11 a FAIL, a stale report or a missing report is silent after compact
 *   C12 the warning-set hash depends on the order of the checks
 *   C13 a healthy report does not clear the stored hash, so a returning warning stays silent
 *   C14 the compact line lists three names instead of the worst item with its detail
 *   C15 the state file write is not atomic or lands outside the override path
 *   C16 a startup print does not store the hash, so the first compact repeats the same set
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionSource, isCompactSource } from '../shared/session-source.js';
import { buildSessionStartOutput } from '../shared/session-start-output.js';
import { runSessionHealth, EXPECTED_SCHEMA_VERSION } from '../shared/memory-health.js';
import {
  formatCompactAlert,
  healthAlertForSource,
  problemSetHash,
} from '../shared/health-alert.js';

describe('parseSessionSource', () => {
  it('C1: empty, invalid or non-object JSON gives startup and never throws', () => {
    for (const raw of ['', '   ', '{', 'not json', 'null', '"compact"', '[]', '42']) {
      expect(parseSessionSource(raw)).toBe('startup');
    }
  });

  it('C2: a missing or non-string source gives startup', () => {
    expect(parseSessionSource('{}')).toBe('startup');
    expect(parseSessionSource('{"source":7}')).toBe('startup');
    expect(parseSessionSource('{"source":""}')).toBe('startup');
  });

  it('reads the source field', () => {
    expect(parseSessionSource('{"session_id":"a","source":"compact"}')).toBe('compact');
    expect(parseSessionSource('{"source":"startup"}')).toBe('startup');
    expect(parseSessionSource('{"source":"resume"}')).toBe('resume');
  });

  it('C3: only compact is compact', () => {
    expect(isCompactSource('compact')).toBe(true);
    for (const s of ['startup', 'resume', 'clear', '', undefined, 'COMPACT']) {
      expect(isCompactSource(s)).toBe(false);
    }
  });
});

describe('buildSessionStartOutput by source', () => {
  const healthy = { line: 'Memory: 130 lessons, newest 2h ago', warn: false };
  const sick = { line: 'Memory: UNKNOWN (ECONNREFUSED)', warn: true };

  it('C4: healthy line + no harness line after compact gives an empty object', () => {
    expect(buildSessionStartOutput('', healthy, null, 'compact')).toEqual({});
  });

  it('C4: the daemon output alone is also dropped after compact', () => {
    expect(buildSessionStartOutput('daemon started', healthy, null, 'compact')).toEqual({});
  });

  it('C5: a degraded line still prints after compact', () => {
    const out = buildSessionStartOutput('', sick, null, 'compact') as {
      systemMessage: string;
      hookSpecificOutput: { additionalContext: string };
    };
    expect(out.systemMessage).toBe(sick.line);
    expect(out.hookSpecificOutput.additionalContext).toBe(sick.line);
  });

  it('a harness line prints after compact even when memory is healthy, and the healthy line does not', () => {
    const out = buildSessionStartOutput('', healthy, 'harness: 1 fail', 'compact') as { systemMessage: string };
    expect(out.systemMessage).toBe('harness: 1 fail');
  });

  it('C6: startup prints the healthy line', () => {
    const out = buildSessionStartOutput('', healthy, null, 'startup') as { systemMessage: string };
    expect(out.systemMessage).toBe(healthy.line);
    const dflt = buildSessionStartOutput('', healthy, null) as { systemMessage: string };
    expect(dflt.systemMessage).toBe(healthy.line);
  });
});

describe('runSessionHealth marker by source', () => {
  let state: string;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'b5-health-'));
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  const runner = (async (fn: (c: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string) =>
        sql.includes('schema_meta')
          ? { rows: [{ value: EXPECTED_SCHEMA_VERSION }] }
          : { rows: [{ db: 'cc', rows: 5, newest: new Date('2026-11-07T10:00:00Z'), no_emb: 0 }] },
    })) as never;
  const NOW = new Date('2026-11-07T12:00:00Z');
  const marker = () => join(state, 'memory-health-last-session');

  function logFailure(ts: string): void {
    writeFileSync(join(state, 'memory-write-failures.jsonl'), JSON.stringify({ ts }) + '\n', { flag: 'a' });
  }
  const run = (source: string) => runSessionHealth({ stateDir: state, opcDir: null, now: NOW, runner, source });

  it('C7: compact reports the failure and leaves the marker alone, so the next startup still sees it', async () => {
    logFailure('2026-11-07T11:00:00Z');
    const a = await run('compact');
    expect(a.line).toContain('1 failed memory writes');
    expect(existsSync(marker())).toBe(false);
    const b = await run('compact');
    expect(b.line).toContain('1 failed memory writes');
    const c = await run('startup');
    expect(c.line).toContain('1 failed memory writes');
  });

  it('C8: startup writes the marker, so the next start reports none', async () => {
    logFailure('2026-11-07T11:00:00Z');
    await run('startup');
    expect(readFileSync(marker(), 'utf-8')).toBe(NOW.toISOString());
    const next = await run('startup');
    expect(next.line).not.toContain('failed memory writes');
    expect(next.warn).toBe(false);
  });

  it('resume and clear still reset the marker (new session process)', async () => {
    for (const s of ['resume', 'clear']) {
      rmSync(marker(), { force: true });
      await run(s);
      expect(existsSync(marker())).toBe(true);
    }
  });

  it('no source (older payload) behaves as startup', async () => {
    await runSessionHealth({ stateDir: state, opcDir: null, now: NOW, runner });
    expect(existsSync(marker())).toBe(true);
  });
});

describe('compact harness alert', () => {
  const NOW = new Date('2026-11-07T12:00:00Z');
  const TS = '2026-11-07T08:00:00Z';
  type Status = 'PASS' | 'WARN' | 'FAIL';
  const doc = (checks: Array<[Status, string, string, string?]>, ts = TS) => ({
    ts,
    repo: 'C:/repo',
    summary: {
      pass: checks.filter((c) => c[0] === 'PASS').length,
      warn: checks.filter((c) => c[0] === 'WARN').length,
      fail: checks.filter((c) => c[0] === 'FAIL').length,
    },
    checks: checks.map(([status, section, check, detail]) => ({ status, section, check, detail: detail ?? 'x' })),
  });
  const warnA = doc([['WARN', 'sync', 'drift'], ['WARN', 'hooks', 'stale-dist'], ['PASS', 'a', 'b']]);

  it('C9: a first-seen WARN set prints on compact and returns its hash', () => {
    const r = formatCompactAlert(warnA, NOW, undefined, '');
    expect(r.line).toContain('2 warn');
    expect(r.hash).toBe(problemSetHash(warnA));
    expect(r.hash).not.toBe('');
  });

  it('C9: the same WARN set is silent when the hash matches', () => {
    const h = problemSetHash(warnA);
    expect(formatCompactAlert(warnA, NOW, undefined, h).line).toBeNull();
  });

  it('C10: a changed WARN set prints', () => {
    const before = problemSetHash(warnA);
    const after = doc([['WARN', 'sync', 'drift'], ['WARN', 'rules', 'new-one']]);
    const r = formatCompactAlert(after, NOW, undefined, before);
    expect(r.line).toContain('2 warn');
    expect(r.hash).not.toBe(before);
  });

  it('C11: a FAIL prints even when the hash matches', () => {
    const f = doc([['FAIL', 'db', 'down'], ['PASS', 'a', 'b']]);
    expect(formatCompactAlert(f, NOW, undefined, problemSetHash(f)).line).toContain('1 fail');
  });

  it('C11: a stale report prints, a healthy fresh report is silent', () => {
    const old = doc([['PASS', 'a', 'b']], '2026-11-05T00:00:00Z');
    expect(formatCompactAlert(old, NOW, undefined, '').line).toContain('has not run since');
    expect(formatCompactAlert(doc([['PASS', 'a', 'b']]), NOW, undefined, '').line).toBeNull();
  });

  it('C11: an unreadable document is silent and keeps the old hash', () => {
    const r = formatCompactAlert({ nope: 1 }, NOW, undefined, 'keep');
    expect(r).toEqual({ line: null, hash: 'keep' });
  });

  it('C12: the hash ignores check order and the detail text', () => {
    const a = doc([['WARN', 'x', '1', 'one'], ['WARN', 'y', '2']]);
    const b = doc([['WARN', 'y', '2', 'other'], ['WARN', 'x', '1']]);
    expect(problemSetHash(a)).toBe(problemSetHash(b));
    expect(problemSetHash(doc([['PASS', 'x', '1']]))).toBe('');
  });

  it('C14: the line names the worst item (FAIL before WARN) with its detail, one line', () => {
    const d = doc([
      ['WARN', 'sync', 'drift', 'warn detail'],
      ['FAIL', 'db', 'down', 'connection refused\nsecond line'],
      ['WARN', 'a', 'b'],
    ]);
    const line = formatCompactAlert(d, NOW, undefined, '').line!;
    expect(line).toContain('db:down');
    expect(line).toContain('connection refused');
    expect(line).not.toContain('second line');
    expect(line).not.toContain('\n');
    expect(line).not.toContain('sync:drift');
    expect(line).toContain('2 more');
    expect(line).toContain('C:/repo/scripts/harness-doctor.mjs');
  });

  it('C14: a long detail is cut', () => {
    const d = doc([['FAIL', 'db', 'down', 'z'.repeat(500)]]);
    expect(formatCompactAlert(d, NOW, undefined, '').line!.length).toBeLessThan(400);
  });

  describe('healthAlertForSource with files', () => {
    let dir: string;
    let latest: string;
    let statePath: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'b5-alert-'));
      latest = join(dir, 'latest.json');
      statePath = join(dir, 'sub', 'last-session-print.txt');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const opts = () => ({ path: latest, statePath, now: NOW });
    const put = (d: unknown) => writeFileSync(latest, JSON.stringify(d));

    it('C16: a startup print stores the hash, so the next compact is silent', () => {
      put(warnA);
      expect(healthAlertForSource('startup', opts())).toContain('2 warn');
      expect(healthAlertForSource('compact', opts())).toBeNull();
    });

    it('C15: the state file lands at the override path, with no temp file left', () => {
      put(warnA);
      healthAlertForSource('compact', opts());
      expect(readFileSync(statePath, 'utf-8').trim()).toBe(problemSetHash(warnA));
      expect(readdirSync(join(dir, 'sub'))).toEqual(['last-session-print.txt']);
    });

    it('C10: compact prints once for a new set, then stays silent', () => {
      put(warnA);
      expect(healthAlertForSource('compact', opts())).toContain('2 warn');
      expect(healthAlertForSource('compact', opts())).toBeNull();
      put(doc([['WARN', 'z', 'new']]));
      expect(healthAlertForSource('compact', opts())).toContain('z:new');
    });

    it('C13: a healthy report clears the hash, so the same warning prints again later', () => {
      put(warnA);
      healthAlertForSource('compact', opts());
      put(doc([['PASS', 'a', 'b']]));
      expect(healthAlertForSource('compact', opts())).toBeNull();
      put(warnA);
      expect(healthAlertForSource('compact', opts())).toContain('2 warn');
    });

    it('C11: a missing report prints the never-run line on compact', () => {
      expect(healthAlertForSource('compact', opts())).toContain('never run');
    });

    it('startup output is the unchanged long form (first three names)', () => {
      put(doc([['WARN', 'a', '1'], ['WARN', 'b', '2'], ['WARN', 'c', '3'], ['WARN', 'd', '4']]));
      const line = healthAlertForSource('startup', opts())!;
      expect(line).toContain('a:1, b:2, c:3 and 1 more');
    });
  });
});
