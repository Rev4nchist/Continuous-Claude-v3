/**
 * Identity-file contract (~/.claude/state/identity/<uuid>.json).
 *
 * Failure list, one test each:
 *   I1  a write drops a stored previous/endedAt that the writer did not name
 *   I2  null does not clear a field (a SessionStart cannot reopen an ended session)
 *   I3  a corrupt file throws instead of reading as absent
 *   I4  a uuid with a path part writes outside the identity folder
 *   I5  lastCustomTitle returns an earlier title, or breaks on a cut tail line
 *   I6  /clear picks a session that is old, in another cwd, ended for another reason, or itself
 *   I7  /clear does not pick the newest of two candidates
 *   I8  resume reads the current session id as the previous one
 *   I9  a name over 16 chars is not clipped, or an unnamed label shows "unnamed"
 *   I10 adopt runs without the new id in the env, or runs when lane.mjs is missing
 *   I11 /clear adopts the wrong session: two clears in one cwd, or a clear another session already claimed
 *   I12 resume names a session far back in the history, not the direct parent
 *   I13 the id rule lets through a non-hex id; a name keeps stray whitespace
 *   I14 a hidden spawn timeout option that does nothing is passed to the adopt child
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLEAR_WINDOW_MS, clipName, label, lastCustomTitle, previousFromClear, previousFromTranscript,
  readIdentity, resolveName, resolvePrevious, runAdopt, writeIdentity,
} from '../shared/session-identity.js';

const A = '11111111-aaaa-4bbb-8ccc-222222222222';
const B = '33333333-aaaa-4bbb-8ccc-444444444444';
const C = '55555555-aaaa-4bbb-8ccc-666666666666';
let dir: string;
const saved = { id: process.env.CCV3_IDENTITY_DIR, repo: process.env.CCV3_REPO };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ident-'));
  process.env.CCV3_IDENTITY_DIR = join(dir, 'identity');
});
afterEach(() => {
  if (saved.id === undefined) delete process.env.CCV3_IDENTITY_DIR; else process.env.CCV3_IDENTITY_DIR = saved.id;
  if (saved.repo === undefined) delete process.env.CCV3_REPO; else process.env.CCV3_REPO = saved.repo;
  rmSync(dir, { recursive: true, force: true });
});

const jsonl = (rows: object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

describe('identity file merge', () => {
  it('I1: a write that names only the name keeps previous and endedAt', () => {
    writeIdentity(A, { previous: B, endedAt: '2026-11-03T10:00:00.000Z', endReason: 'clear', cwd: 'C:/x' });
    writeIdentity(A, { name: 'trex' });
    expect(readIdentity(A)).toMatchObject({
      uuid: A, short: '11111111', name: 'trex', previous: B,
      endedAt: '2026-11-03T10:00:00.000Z', endReason: 'clear', cwd: 'C:/x',
    });
  });

  it('I2: null clears a field', () => {
    writeIdentity(A, { endedAt: '2026-11-03T10:00:00.000Z', endReason: 'clear' });
    writeIdentity(A, { endedAt: null, endReason: null });
    expect(readIdentity(A)).toMatchObject({ endedAt: null, endReason: null });
  });

  it('I3: a corrupt file reads as absent and the next write replaces it', () => {
    mkdirSync(process.env.CCV3_IDENTITY_DIR!, { recursive: true });
    writeFileSync(join(process.env.CCV3_IDENTITY_DIR!, `${A}.json`), '{not json');
    expect(readIdentity(A)).toBeNull();
    expect(writeIdentity(A, { name: 'trex' })?.name).toBe('trex');
  });

  it('I4: a uuid with a path part is refused', () => {
    expect(writeIdentity('../evil', { name: 'x' })).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('lastCustomTitle', () => {
  it('I5: returns the last title, skips a cut line, and reads only the tail of a big file', () => {
    const f = join(dir, 't.jsonl');
    const filler = { type: 'user', text: 'x'.repeat(2000) };
    const rows = Array.from({ length: 400 }, () => filler); // about 800 KB, over the 256 KB tail
    const cut = '{"type":"custom-title","customTi';
    writeFileSync(f, jsonl([{ type: 'custom-title', customTitle: 'old' }, ...rows,
      { type: 'custom-title', customTitle: 'first' }, filler, { type: 'custom-title', customTitle: 'last' }]) + cut);
    expect(lastCustomTitle(f)).toBe('last');
    writeFileSync(f, jsonl([{ type: 'custom-title', customTitle: 'old' }, ...rows]));
    expect(lastCustomTitle(f)).toBeNull(); // the only title is outside the tail window
    expect(lastCustomTitle(join(dir, 'missing.jsonl'))).toBeNull();
  });

  it('resolveName prefers session_title over the transcript', () => {
    const f = join(dir, 't.jsonl');
    writeFileSync(f, jsonl([{ type: 'custom-title', customTitle: 'from-file' }]));
    expect(resolveName('from-hook', f)).toBe('from-hook');
    expect(resolveName(undefined, f)).toBe('from-file');
    expect(resolveName('', undefined)).toBeNull();
  });
});

describe('previous session', () => {
  const now = Date.parse('2026-11-03T12:00:00.000Z');
  const ended = (uuid: string, agoMs: number, cwd: string, reason = 'clear') =>
    writeIdentity(uuid, { endedAt: new Date(now - agoMs).toISOString(), endReason: reason, cwd });
  const NEW = '99999999-0000-4000-8000-000000000000';

  it('I6: /clear ignores old, other-cwd, other-reason and self; accepts a slash and case variant of the cwd', () => {
    ended(A, CLEAR_WINDOW_MS + 1000, 'C:/Work/Repo');
    ended(B, 5000, 'C:/Other');
    ended(C, 5000, 'C:/Work/Repo', 'logout');
    expect(previousFromClear(NEW, 'C:/Work/Repo', now)).toBeNull();
    ended(A, 5000, 'C:\\work\\repo\\');
    expect(previousFromClear(NEW, 'c:/Work/Repo', now)).toBe(A);
    expect(previousFromClear(A, 'c:/Work/Repo', now)).toBeNull();
  });

  it('I7+I11: two clears in one cwd inside the window are ambiguous, so no adopt', () => {
    ended(A, 30000, 'C:/r');
    ended(B, 10000, 'C:/r');
    expect(previousFromClear(C, 'C:/r', now)).toBeNull();
    expect(resolvePrevious('clear', C, undefined, 'C:/r', now)).toBeNull();
  });

  it('I11: one clear is adopted', () => {
    ended(A, 10000, 'C:/r');
    expect(previousFromClear(C, 'C:/r', now)).toBe(A);
  });

  it('I11: a clear another identity already names as previous is skipped', () => {
    ended(A, 30000, 'C:/r');
    ended(B, 10000, 'C:/r');
    writeIdentity(NEW, { previous: B });
    expect(previousFromClear(C, 'C:/r', now)).toBe(A);
    // the asking session own file does not hide its own previous (SessionStart fired twice)
    expect(previousFromClear(NEW, 'C:/r', now)).toBeNull();
  });

  it('I11: with a name, candidates that carry the same name win; no name match keeps all', () => {
    writeIdentity(A, { name: 'trex' });
    writeIdentity(B, { name: 'other' });
    ended(A, 30000, 'C:/r');
    ended(B, 10000, 'C:/r');
    expect(previousFromClear(C, 'C:/r', now, 'trex')).toBe(A);
    expect(previousFromClear(C, 'C:/r', now, '  trex ')).toBe(A);
    expect(previousFromClear(C, 'C:/r', now, 'nomatch')).toBeNull();
    expect(resolvePrevious('clear', C, undefined, 'C:/r', now, 'trex')).toBe(A);
  });

  it('I8: resume never names the current session as the previous one', () => {
    const f = join(dir, 't.jsonl');
    writeFileSync(f, jsonl([{ sessionId: C }]));
    expect(previousFromTranscript(f, C)).toBeNull();
    writeFileSync(f, jsonl([{ sessionId: A }, { sessionId: C }]));
    expect(resolvePrevious('startup', C, f, 'C:/r', now)).toBeNull();
    expect(resolvePrevious('resume', C, f, 'C:/r', now)).toBe(A);
  });

  it('I12: resume returns the direct parent, the last other id before the current one first appears', () => {
    const f = join(dir, 't.jsonl');
    writeFileSync(f, jsonl([{ type: 'summary' }, { sessionId: A }, { sessionId: A }, { sessionId: B }, { sessionId: C }, { sessionId: A }]));
    expect(previousFromTranscript(f, C)).toBe(B);
    // an older id seen again after the current one does not count
    writeFileSync(f, jsonl([{ sessionId: A }, { sessionId: B }, { sessionId: A }, { sessionId: C }]));
    expect(previousFromTranscript(f, C)).toBe(A);
  });

  it('I12: when the current id never appears, the last distinct other id in the window is the parent', () => {
    const f = join(dir, 't.jsonl');
    writeFileSync(f, jsonl([{ sessionId: A }, { sessionId: A }, { sessionId: B }, { sessionId: B }]));
    expect(previousFromTranscript(f, C)).toBe(B);
  });
});

describe('label', () => {
  it('I9: clips the name to 16 chars and shows #sid8 alone when unnamed', () => {
    expect(label(A, 'a-very-long-session-name')).toBe('a-very-long-sess #11111111');
    expect(label(A, null)).toBe('#11111111');
    expect(label(A)).toBe('#11111111');
    writeIdentity(A, { name: 'trex' });
    expect(label(A)).toBe('trex #11111111');
  });
});

describe('runAdopt', () => {
  it('I10: passes the old id as an arg and the new id in the env; skips when lane.mjs is missing', () => {
    process.env.CCV3_REPO = join(dir, 'repo');
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const fake = ((_cmd: string, args: readonly string[], o: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: o.env ?? {} });
      return { on() {}, unref() {} };
    }) as unknown as Parameters<typeof runAdopt>[2];
    expect(runAdopt(B, A, fake)).toBe(false);
    expect(calls).toHaveLength(0);
    mkdirSync(join(dir, 'repo', 'scripts', 'coordination'), { recursive: true });
    writeFileSync(join(dir, 'repo', 'scripts', 'coordination', 'lane.mjs'), '');
    expect(runAdopt(B, A, fake)).toBe(true);
    expect(calls[0].args.slice(1)).toEqual(['adopt', '--from', A]);
    expect(calls[0].env.CLAUDE_CODE_SESSION_ID).toBe(B);
  });
});

describe('shared rules', () => {
  it('I13: the id rule is 8-64 hex or dash; a non-hex or short id is refused', () => {
    expect(writeIdentity('not-a-hex-id-zzzz', { name: 'x' })).toBeNull();
    expect(writeIdentity('abc', { name: 'x' })).toBeNull();
    expect(writeIdentity('a'.repeat(65), { name: 'x' })).toBeNull();
    expect(readIdentity('..')).toBeNull();
    expect(writeIdentity('abcdef12', { name: 'x' })?.name).toBe('x');
  });

  it('I13: the file name is the identity, not a uuid written inside the file', () => {
    mkdirSync(process.env.CCV3_IDENTITY_DIR!, { recursive: true });
    writeFileSync(join(process.env.CCV3_IDENTITY_DIR!, `${A}.json`), JSON.stringify({ uuid: B, name: 'x' }));
    expect(readIdentity(A)?.uuid).toBe(A);
  });

  it('I13: a name collapses whitespace, trims and clips to 16', () => {
    expect(clipName(['  a', '\t', ' b  '].join('\n'))).toBe('a b');
    expect(clipName('x'.repeat(40))).toBe('x'.repeat(16));
    expect(clipName('   ')).toBeNull();
  });

  it('I14: the adopt child gets no spawn timeout option', () => {
    process.env.CCV3_REPO = join(dir, 'repo');
    mkdirSync(join(dir, 'repo', 'scripts', 'coordination'), { recursive: true });
    writeFileSync(join(dir, 'repo', 'scripts', 'coordination', 'lane.mjs'), '');
    let opts: Record<string, unknown> = {};
    const fake = ((_c: string, _a: readonly string[], o: Record<string, unknown>) => {
      opts = o;
      return { on() {}, unref() {} };
    }) as unknown as Parameters<typeof runAdopt>[2];
    runAdopt(B, A, fake);
    expect(opts).not.toHaveProperty('timeout');
  });
});
