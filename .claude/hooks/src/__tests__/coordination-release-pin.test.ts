/**
 * Card coord-file-guard-named-file (seat ruling 2026-11-15, item 3): the lease branch of the shell claim list is NOT changed
 * for an ended holder, because a session end already removes that session's claims. This file pins that reason.
 *
 * Ways it can fail (one test each):
 *  1. The SessionEnd hook stops calling releaseSessionClaims for the ending session (an ended holder would keep its claims
 *     until the lease runs out, and the guard would block on them).
 *  2. releaseSessionClaims stops deleting by session id alone (a claim filed from another folder would stay).
 *  3. The hook releases the claims of another session than the one that ends.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync as realRead } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const seen = vi.hoisted(() => ({ payload: '', released: [] as string[][], ended: [] as string[][] }));

vi.mock('../shared/db-utils-pg.js', () => ({
  releaseSessionClaims: async (id: string, reason: string) => {
    seen.released.push([id, reason]);
    return { released: 1, files: ['src/a.ts'], degraded: false };
  },
  markSessionEnded: async (id: string, reason: string) => {
    seen.ended.push([id, reason]);
    return { recorded: true, degraded: false };
  },
}));
vi.mock('fs', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('fs');
  return {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) =>
      p === 0 ? seen.payload : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readFileSync,
  };
});

afterEach(() => vi.restoreAllMocks());

describe('a session end removes the claims of that session', () => {
  it('SessionEnd calls releaseSessionClaims and markSessionEnded for the ending session', async () => {
    seen.released = [];
    seen.ended = [];
    seen.payload = JSON.stringify({ session_id: 'sess-ending-1', reason: 'logout', hook_event_name: 'SessionEnd' });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    await import('../coordination-release.js');
    await vi.waitFor(() => expect(out).toHaveBeenCalled());
    expect(seen.released).toEqual([['sess-ending-1', 'logout']]);
    expect(seen.ended).toEqual([['sess-ending-1', 'logout']]);
  });

  it('releaseSessionClaims deletes by session id alone, never by project', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = realRead(join(here, '..', 'shared', 'db-utils-pg.ts'), 'utf-8');
    const start = src.indexOf('export async function releaseSessionClaims');
    const body = src.slice(start, start + 1500);
    expect(body).toMatch(/DELETE FROM file_claims WHERE session_id = \$1\s+RETURNING/);
    expect(body).not.toMatch(/DELETE FROM file_claims[^`]*project/);
  });
});
