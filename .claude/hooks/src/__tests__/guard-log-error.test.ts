/**
 * logGuardError: the crash line in the guard decision log.
 *
 * Ways it can fail (one test each):
 *  1. The line has the wrong shape (kind 'error', ts, hook, message, stack; no decision field).
 *  2. The message holds more than its first line.
 *  3. A secret in the message reaches the log.
 *  4. The stack holds more than its first frame.
 *  5. A thrown value that is not an Error (string, undefined, null) breaks the logger.
 *  6. An unwritable log path throws and blocks a tool call.
 *  7. A test writes to the real log (VITEST with no override must not write).
 *  8. A crash in a built guard hook leaves no line (the hook is blind): see hook-crash-log.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logGuardError } from '../shared/guard-log.js';

const j = (...parts: string[]): string => parts.join('');

let dir: string;
let log: string;
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ CCV3_GUARD_DECISIONS_LOG: log, ...extra });
const lines = (): Array<Record<string, unknown>> =>
  readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guard-log-error-'));
  log = join(dir, 'guard-decisions.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('logGuardError', () => {
  it('writes one JSON line with ts, hook, kind "error", message and stack, and no decision field', () => {
    logGuardError('destructive-command-guard', new TypeError('boom'), { env: env() });
    logGuardError('rule-router', new Error('second'), { env: env() });
    const rows = lines();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ hook: 'destructive-command-guard', kind: 'error', message: 'boom' });
    expect(new Date(rows[0].ts as string).toISOString()).toBe(rows[0].ts);
    expect(typeof rows[0].stack).toBe('string');
    expect('decision' in rows[0]).toBe(false);
    expect(rows[1]).toMatchObject({ hook: 'rule-router', kind: 'error', message: 'second' });
  });

  it('keeps only the first line of the message', () => {
    logGuardError('h', new Error('first line\nsecond line\nthird line'), { env: env() });
    const msg = lines()[0].message as string;
    expect(msg).toBe('first line');
  });

  it('masks a secret in the message', () => {
    const token = j('gh', 'p_', 'abcdefghijklmnopqrstuvwx');
    const pw = j('hun', 'ter2');
    logGuardError('h', new Error(`fetch failed with ${token} and password=${pw}`), { env: env() });
    const raw = readFileSync(log, 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(pw);
  });

  it('keeps only the first stack frame', () => {
    const err = new Error('deep');
    err.stack = 'Error: deep\n    at first (/x/a.ts:1:1)\n    at second (/x/b.ts:2:2)\n    at third (/x/c.ts:3:3)';
    logGuardError('h', err, { env: env() });
    const stack = lines()[0].stack as string;
    expect(stack).toContain('first');
    expect(stack).not.toContain('second');
    expect(stack).not.toContain('Error: deep');
  });

  it.each([['a string', 'plain text'], ['undefined', undefined], ['null', null], ['an object', { code: 7 }]])(
    'does not crash on a thrown value that is %s',
    (_name, thrown) => {
      expect(() => logGuardError('h', thrown, { env: env() })).not.toThrow();
      const row = lines()[0];
      expect(row).toMatchObject({ hook: 'h', kind: 'error' });
      expect(typeof row.message).toBe('string');
      expect(row.stack).toBe('');
    },
  );

  it('never throws when the log path cannot be written', () => {
    const asDir = join(dir, 'is-a-dir');
    mkdirSync(asDir);
    expect(() => logGuardError('h', new Error('x'), { env: { CCV3_GUARD_DECISIONS_LOG: asDir } })).not.toThrow();
  });

  it('writes nothing under VITEST when no override is set', () => {
    logGuardError('h', new Error('x'), { env: { VITEST: 'true', HOME: dir, USERPROFILE: dir } });
    expect(existsSync(join(dir, '.claude'))).toBe(false);
  });
});
