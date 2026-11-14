/**
 * Card coord-file-claim-release-one: a holder frees ONE file claim early (shared/claim-release.ts and the
 * CLI entry release-claim.ts). The database and the claim-key readers are mocked here; the real SQL is
 * proved by scripts/coordination/release-one-probe.mjs on a scratch database.
 *
 * Ways it can fail (one or more tests each):
 *  1. A tracked path, a raw `.claude/cache` path (slash, backslash, absolute, relative) or a Git Bash drive
 *     path does not find the stored row.
 *  2. Case is folded on Linux, or is not folded on win32.
 *  3. Seat rule: a loose spelling that fits MORE than one own row frees one of them (or all of them).
 *  4. The exact key is ignored when loose rows also fit.
 *  5. A non-holder frees a row, or learns about another session's other files.
 *  6. The delete and the event are not one transaction (order, no event on 0 rows, rollback on error or
 *     on a dropped event, a takeover between the read and the delete).
 *  7. The CLI exit codes, the usage errors, the own-rows-only output, the one-line database error.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: [] as { file_path: string; project: string; session_id: string }[],
  log: [] as { sql: string; params: unknown[] }[],
  down: false,
  failOn: null as string | null,
  eventOk: true,
  beforeDelete: null as null | (() => void),
  pgOptions: undefined as unknown,
}));

vi.mock('../shared/pg-client.js', () => ({
  withPgClientOrFallback: async (
    fn: (c: unknown) => Promise<unknown>,
    fallback: unknown,
    _ctx: string,
    options?: unknown,
  ) => {
    h.pgOptions = options;
    if (h.down) return { value: fallback, degraded: true, error: 'down' };
    try {
      return { value: await fn(fakeClient), degraded: false };
    } catch {
      return { value: fallback, degraded: true, error: 'failed' };
    }
  },
}));

vi.mock('../shared/coordination-events.js', () => ({
  recordEventInTransaction: async (_c: unknown, event: unknown) => {
    h.log.push({ sql: 'EVENT', params: [event] });
    return h.eventOk;
  },
}));

vi.mock('../shared/claim-target.js', () => ({ resolveClaimKey: vi.fn() }));
vi.mock('../shared/session-id.js', () => ({ canonicalProject: vi.fn(() => 'c:/proj') }));

const fakeClient = {
  query: async (sql: string, params: unknown[] = []) => {
    h.log.push({ sql: sql.trim(), params });
    if (h.failOn && sql.includes(h.failOn)) throw new Error('boom');
    if (sql.startsWith('SELECT file_path')) {
      return { rows: h.db.filter((r) => r.session_id === params[0]).map(({ file_path, project }) => ({ file_path, project })) };
    }
    if (sql.startsWith('SELECT session_id')) {
      return { rows: h.db.filter((r) => r.file_path === params[0] && r.project === params[1]).map((r) => ({ session_id: r.session_id })) };
    }
    if (sql.startsWith('DELETE')) {
      h.beforeDelete?.();
      const byHolder = /session_id\s*=\s*\$3/.test(sql);
      const i = h.db.findIndex((r) => r.file_path === params[0] && r.project === params[1] && (!byHolder || r.session_id === params[2]));
      if (i < 0) return { rows: [] };
      const [gone] = h.db.splice(i, 1);
      return { rows: [{ file_path: gone.file_path }] };
    }
    return { rows: [] };
  },
};

import { resolveClaimKey } from '../shared/claim-target.js';
import { canonicalProject } from '../shared/session-id.js';
import { candidateKeys, matchOwnRows, releaseOwnClaim, listOwnClaims } from '../shared/claim-release.js';
import { run } from '../release-claim.js';

const keyOf = resolveClaimKey as unknown as ReturnType<typeof vi.fn>;
const win = { platform: 'win32' as const };
const row = (file_path: string, project = 'c:/proj') => ({ file_path, project });
const kinds = () => h.log.map((q) => q.sql.split(' ')[0]);

beforeEach(() => {
  h.db = [];
  h.log = [];
  h.down = false;
  h.failOn = null;
  h.eventOk = true;
  h.beforeDelete = null;
  h.pgOptions = undefined;
  keyOf.mockReset();
  keyOf.mockReturnValue(null);
  (canonicalProject as unknown as ReturnType<typeof vi.fn>).mockReturnValue('c:/proj');
});

describe('candidateKeys and matchOwnRows (pure)', () => {
  it('a tracked path matches the exact (file_path, project) pair', () => {
    keyOf.mockReturnValue({ filePath: 'src/a.ts', project: 'c:/repo' });
    const rows = [row('src/b.ts', 'c:/repo'), row('src/a.ts', 'c:/repo'), row('src/a.ts', 'c:/other')];
    expect(candidateKeys('C:/repo/src/A.ts', 'C:/repo', win).exact).toEqual(row('src/a.ts', 'c:/repo'));
    expect(matchOwnRows('C:/repo/src/A.ts', 'C:/repo', rows, win)).toEqual({ kind: 'delete', row: rows[1], tier: 'exact' });
  });

  it('SEAT F1: a repo-relative row of ANOTHER project is never freed by a path typed in this project', () => {
    // Own row: README.md in repo B only. Typed from repo A, where the session holds no claim.
    keyOf.mockReturnValue({ filePath: 'readme.md', project: 'c:/repoa' });
    const rows = [row('readme.md', 'c:/repob')];
    expect(matchOwnRows('README.md', 'C:/repoA', rows, win)).toEqual({ kind: 'none' });
    expect(matchOwnRows('C:/repoA/README.md', 'C:/repoA', rows, win)).toEqual({ kind: 'none' });
  });

  it('SEAT F1: the same repo-relative key held in repo A and repo B: the exact tier frees repo A only', () => {
    keyOf.mockReturnValue({ filePath: 'readme.md', project: 'c:/repoa' });
    const rows = [row('readme.md', 'c:/repob'), row('readme.md', 'c:/repoa')];
    expect(matchOwnRows('README.md', 'C:/repoA', rows, win)).toEqual({ kind: 'delete', row: rows[1], tier: 'exact' });
  });

  it('SEAT F1: a stored absolute path keeps the loose rule across projects (a cache claim)', () => {
    const rows = [row('C:/w/.claude/cache/x.log', 'c:/p1')];
    expect(matchOwnRows('C:\\w\\.claude\\cache\\x.log', 'C:/elsewhere', rows, win)).toMatchObject({ kind: 'delete', tier: 'loose' });
  });

  it('a raw cache path (no key) is the raw string plus the cwd project', () => {
    const typed = 'C:/w/.claude/cache/x.log';
    expect(candidateKeys(typed, 'C:/w', win).exact).toEqual(row(typed));
    expect(matchOwnRows(typed, 'C:/w', [row(typed)], win)).toMatchObject({ kind: 'delete', tier: 'exact' });
  });

  it('a raw cache claim stored with backslashes is found by a slash spelling, and the reverse', () => {
    const stored = [row('C:\\w\\.claude\\cache\\x.log')];
    expect(matchOwnRows('C:/w/.claude/cache/x.log', 'C:/w', stored, win)).toMatchObject({ kind: 'delete', tier: 'loose' });
    expect(matchOwnRows('C:\\w\\.claude\\cache\\x.log', 'C:/w', [row('C:/w/.claude/cache/x.log')], win)).toMatchObject({ kind: 'delete', tier: 'loose' });
  });

  it('a relative cache path is found through the absolute spelling', () => {
    const m = matchOwnRows('.claude/cache/x.log', 'C:/w', [row('C:/w/.claude/cache/x.log')], win);
    expect(m).toMatchObject({ kind: 'delete', tier: 'loose' });
  });

  it('the Git Bash drive form /c/Users/x is converted to C:/Users/x first (win32 only)', () => {
    const stored = [row('C:/Users/x/repo/.claude/cache/a.log')];
    expect(matchOwnRows('/c/Users/x/repo/.claude/cache/a.log', 'C:/Users/x/repo', stored, win)).toMatchObject({ kind: 'delete', tier: 'loose' });
    expect(matchOwnRows('/c/Users/x/repo/.claude/cache/a.log', '/home/x', stored, { platform: 'linux' })).toEqual({ kind: 'none' });
  });

  it('case folds on win32 and darwin, not on linux', () => {
    const stored = [row('c:/w/file.log')];
    expect(matchOwnRows('C:/W/File.LOG', 'C:/w', stored, win)).toMatchObject({ kind: 'delete' });
    expect(matchOwnRows('C:/W/File.LOG', 'C:/w', stored, { platform: 'darwin' })).toMatchObject({ kind: 'delete' });
    expect(matchOwnRows('C:/W/File.LOG', 'C:/w', stored, { platform: 'linux' })).toEqual({ kind: 'none' });
  });

  it('SEAT RULE: a loose spelling that fits two own rows frees nothing and returns both rows', () => {
    const rows = [row('C:/w/x.log', 'c:/p1'), row('C:\\w\\x.log', 'c:/p2'), row('C:/w/other.log', 'c:/p1')];
    const m = matchOwnRows('c:/w/x.log', 'C:/w', rows, win);
    expect(m).toEqual({ kind: 'ambiguous', rows: [rows[0], rows[1]] });
  });

  it('SEAT RULE: the raw string stored in two projects is ambiguous too', () => {
    const rows = [row('C:/w/x.log', 'c:/p1'), row('C:/w/x.log', 'c:/p2')];
    expect(matchOwnRows('C:/w/x.log', 'C:/w', rows, win)).toMatchObject({ kind: 'ambiguous' });
  });

  it('an exact match still deletes when loose rows also fit', () => {
    const rows = [row('C:\\w\\x.log', 'c:/q'), row('C:/w/x.log', 'c:/proj')];
    expect(matchOwnRows('C:/w/x.log', 'C:/w', rows, win)).toEqual({ kind: 'delete', row: rows[1], tier: 'exact' });
  });

  it('a path no own row fits is none', () => {
    expect(matchOwnRows('src/z.ts', 'C:/w', [row('src/a.ts')], win)).toEqual({ kind: 'none' });
  });
});

describe('releaseOwnClaim (mocked database)', () => {
  const ME = 'me-1';
  const seed = () => {
    h.db = [
      { file_path: 'src/a.ts', project: 'p', session_id: ME },
      { file_path: 'src/b.ts', project: 'p', session_id: ME },
      { file_path: 'src/c.ts', project: 'p', session_id: 'other-9' },
      { file_path: 'secret/notes.md', project: 'p', session_id: 'other-9' },
    ];
    keyOf.mockImplementation((t: string) => ({ filePath: t, project: 'p' }));
  };

  it('frees one claim: BEGIN, read own rows, DELETE, one event, COMMIT; the other claim stays', async () => {
    seed();
    const r = await releaseOwnClaim(ME, ['src/a.ts'], '/w', 'one-file', win);
    expect(r).toEqual([{ typed: 'src/a.ts', outcome: 'freed', file: 'src/a.ts' }]);
    expect(kinds()).toEqual(['BEGIN', 'SELECT', 'DELETE', 'EVENT', 'COMMIT']);
    expect(h.db.map((x) => x.file_path)).toEqual(['src/b.ts', 'src/c.ts', 'secret/notes.md']);
    const del = h.log.find((q) => q.sql.startsWith('DELETE'))!;
    expect(del.params).toEqual(['src/a.ts', 'p', ME]);
    expect(h.log.find((q) => q.sql === 'EVENT')!.params[0]).toMatchObject({
      kind: 'claim_released', sessionId: ME, detail: { reason: 'one-file', count: 1, files: ['src/a.ts'] },
    });
    expect(h.pgOptions).toMatchObject({ quiet: true });
  });

  it('two paths, one event with count 2', async () => {
    seed();
    await releaseOwnClaim(ME, ['src/a.ts', 'src/b.ts'], '/w', 'one-file', win);
    expect(h.log.filter((q) => q.sql === 'EVENT')).toHaveLength(1);
    expect(h.log.find((q) => q.sql === 'EVENT')!.params[0]).toMatchObject({ detail: { count: 2, files: ['src/a.ts', 'src/b.ts'] } });
  });

  it('a path typed twice is freed once and reported freed twice', async () => {
    seed();
    const r = await releaseOwnClaim(ME, ['src/a.ts', 'src/a.ts'], '/w', 'one-file', win);
    expect(r.map((x) => x.outcome)).toEqual(['freed', 'freed']);
    expect(h.log.filter((q) => q.sql.startsWith('DELETE'))).toHaveLength(1);
  });

  it('a non-holder frees nothing, gets the holder label of THAT key only, and no event', async () => {
    seed();
    const r = await releaseOwnClaim(ME, ['src/c.ts'], '/w', 'one-file', win);
    expect(r).toEqual([{ typed: 'src/c.ts', outcome: 'not-holder', heldBy: 'other-9' }]);
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(kinds()).not.toContain('DELETE');
    expect(kinds()).not.toContain('EVENT');
    expect(h.db).toHaveLength(4);
    const reads = h.log.filter((q) => q.sql.startsWith('SELECT session_id'));
    expect(reads.map((q) => q.params)).toEqual([['src/c.ts', 'p']]);
  });

  it('a path nobody holds is none', async () => {
    seed();
    const r = await releaseOwnClaim(ME, ['src/zzz.ts'], '/w', 'one-file', win);
    expect(r).toEqual([{ typed: 'src/zzz.ts', outcome: 'none' }]);
    expect(kinds()).not.toContain('EVENT');
  });

  it('ambiguous: returns the own rows only, issues no DELETE and no event', async () => {
    h.db = [
      { file_path: 'C:/w/x.log', project: 'p1', session_id: ME },
      { file_path: 'C:\\w\\x.log', project: 'p2', session_id: ME },
      { file_path: 'C:/w/x.log', project: 'p3', session_id: 'other-9' },
    ];
    const r = await releaseOwnClaim(ME, ['c:/w/x.log'], 'C:/w', 'one-file', win);
    expect(r[0]).toEqual({
      typed: 'c:/w/x.log', outcome: 'ambiguous',
      rows: [row('C:/w/x.log', 'p1'), row('C:\\w\\x.log', 'p2')],
    });
    expect(JSON.stringify(r)).not.toContain('p3');
    expect(kinds()).toEqual(['BEGIN', 'SELECT', 'COMMIT']);
  });

  it('a takeover between the read and the delete frees nothing and writes no event', async () => {
    seed();
    h.beforeDelete = () => { h.db[0].session_id = 'thief-3'; };
    const r = await releaseOwnClaim(ME, ['src/a.ts'], '/w', 'one-file', win);
    expect(r).toEqual([{ typed: 'src/a.ts', outcome: 'not-holder', heldBy: 'thief-3' }]);
    expect(kinds()).not.toContain('EVENT');
    expect(h.db[0].session_id).toBe('thief-3');
  });

  it('an error in the transaction rolls back and never commits', async () => {
    seed();
    h.failOn = 'DELETE';
    const r = await releaseOwnClaim(ME, ['src/a.ts'], '/w', 'one-file', win);
    expect(r).toEqual([{ typed: 'src/a.ts', outcome: 'degraded' }]);
    expect(kinds()).toContain('ROLLBACK');
    expect(kinds()).not.toContain('COMMIT');
  });

  it('a dropped event (recordEventInTransaction returns false) rolls the delete back too', async () => {
    seed();
    h.eventOk = false;
    const r = await releaseOwnClaim(ME, ['src/a.ts'], '/w', 'one-file', win);
    expect(r[0].outcome).toBe('degraded');
    expect(kinds()).toEqual(['BEGIN', 'SELECT', 'DELETE', 'EVENT', 'ROLLBACK']);
  });

  it('database down: every path is degraded', async () => {
    h.down = true;
    const r = await releaseOwnClaim(ME, ['a', 'b'], '/w', 'one-file', win);
    expect(r.map((x) => x.outcome)).toEqual(['degraded', 'degraded']);
  });

  it('listOwnClaims returns the caller rows only', async () => {
    seed();
    const r = await listOwnClaims(ME);
    expect(r).toEqual({ rows: [row('src/a.ts', 'p'), row('src/b.ts', 'p')], degraded: false });
    expect(h.log.find((q) => q.sql.startsWith('SELECT'))!.params).toEqual([ME]);
  });
});

describe('release-claim CLI run()', () => {
  const lines: { out: string[]; err: string[] } = { out: [], err: [] };
  const out = { log: (s: string) => lines.out.push(s), err: (s: string) => lines.err.push(s) };
  const env = { CLAUDE_CODE_SESSION_ID: 'me-1' };
  beforeEach(() => {
    lines.out = [];
    lines.err = [];
    h.db = [
      { file_path: 'src/a.ts', project: 'p', session_id: 'me-1' },
      { file_path: 'src/b.ts', project: 'p', session_id: 'me-1' },
      { file_path: 'src/c.ts', project: 'p', session_id: 'other-9' },
      { file_path: 'secret/notes.md', project: 'p', session_id: 'other-9' },
    ];
    keyOf.mockImplementation((t: string) => ({ filePath: t, project: 'p' }));
  });
  const all = () => [...lines.out, ...lines.err].join('\n');

  it('exit 0 when every path is freed', async () => {
    expect(await run(['src/a.ts', 'src/b.ts'], env, '/w', out)).toBe(0);
    expect(all()).toContain('src/a.ts');
    expect(h.db.map((x) => x.session_id)).toEqual(['other-9', 'other-9']);
  });

  it('exit 4 for a non-holder; the message names the holder and no other file', async () => {
    expect(await run(['src/c.ts'], env, '/w', out)).toBe(4);
    expect(all()).toContain('other-9');
    expect(all()).not.toContain('secret');
    expect(all()).not.toContain('src/b.ts');
  });

  it('exit 4 when nobody holds the path', async () => {
    expect(await run(['src/none.ts'], env, '/w', out)).toBe(4);
  });

  it('exit 4 for an ambiguous path and it prints the own rows only', async () => {
    h.db = [
      { file_path: 'C:/w/x.log', project: 'p1', session_id: 'me-1' },
      { file_path: 'C:\\w\\x.log', project: 'p2', session_id: 'me-1' },
      { file_path: 'C:/w/x.log', project: 'p3', session_id: 'other-9' },
    ];
    keyOf.mockReturnValue(null);
    const code = await run(['c:/w/x.log'], env, 'C:/w', out);
    if (process.platform === 'win32') {
      expect(code).toBe(4);
      expect(all()).toContain('p1');
      expect(all()).toContain('p2');
      expect(all()).not.toContain('p3');
      expect(all()).not.toContain('other-9');
    } else {
      expect(code).toBe(4); // on Linux the case differs: not held at all
    }
    expect(h.db).toHaveLength(3);
  });

  it('--list prints the caller rows only', async () => {
    expect(await run(['--list'], env, '/w', out)).toBe(0);
    expect(all()).toContain('src/a.ts');
    expect(all()).toContain('src/b.ts');
    expect(all()).not.toContain('src/c.ts');
    expect(all()).not.toContain('secret');
  });

  it('exit 1 with ONE short line on stderr when the database is down, and nothing on stdout', async () => {
    h.down = true;
    expect(await run(['src/a.ts'], env, '/w', out)).toBe(1);
    expect(lines.out).toEqual([]);
    expect(lines.err).toHaveLength(1);
    expect(lines.err[0]).not.toContain('\n');
  });

  it('exit 1 for --list with the database down', async () => {
    h.down = true;
    expect(await run(['--list'], env, '/w', out)).toBe(1);
    expect(lines.err).toHaveLength(1);
  });

  it('exit 2 with no session id', async () => {
    expect(await run(['src/a.ts'], {}, '/w', out)).toBe(2);
    expect(lines.err.join('\n')).toMatch(/session/i);
    expect(h.log).toEqual([]);
  });

  it('falls back to COORDINATION_SESSION_ID', async () => {
    expect(await run(['src/a.ts'], { COORDINATION_SESSION_ID: 'me-1' }, '/w', out)).toBe(0);
  });

  it('exit 2 for no paths and for an unknown flag', async () => {
    expect(await run([], env, '/w', out)).toBe(2);
    expect(await run(['--bogus', 'src/a.ts'], env, '/w', out)).toBe(2);
    expect(h.log).toEqual([]);
  });
});
