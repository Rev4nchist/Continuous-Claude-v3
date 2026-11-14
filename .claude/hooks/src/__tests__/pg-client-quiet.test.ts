/**
 * Card coord-file-claims-all-writers, review F4 (seat reviewer 2026-11-13): the shell branch of file-claims
 * runs on EVERY shell call, so with the database down or hung it must (1) write nothing to stderr and
 * (2) never wait more than a small cap. `withPgClientOrFallback` gets two options for that path.
 *
 * Ways it can fail (one test each):
 *  1. quiet: a refused connection still prints a "degraded" line to stderr.
 *  2. quiet: the unset-URL warning is still printed.
 *  3. totalMs: a server that accepts and never answers holds the call for the full connect timeout (2 s) or more.
 *  4. Without the options nothing changes: the old line is still printed (the Edit path keeps its warning).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'net';
import { withPgClientOrFallback, resetResolveDbUrlWarningForTests } from '../shared/pg-client.js';
import { listBlockingClaims } from '../shared/db-utils-pg.js';

const KEYS = ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL'] as const;
const saved: Record<string, string | undefined> = {};
let server: Server | undefined;

function setUrl(url: string | undefined): void {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  if (url) process.env.CONTINUOUS_CLAUDE_DB_URL = url;
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  server?.close();
  server = undefined;
  vi.restoreAllMocks();
  resetResolveDbUrlWarningForTests();
});

const noop = async () => 1;

describe('withPgClientOrFallback options', () => {
  it('quiet: a refused connection writes nothing to stderr', async () => {
    setUrl('postgresql://u:p@127.0.0.1:1/db');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await withPgClientOrFallback(noop, 0, 'ctx', { quiet: true });
    expect(r.degraded).toBe(true);
    expect(err).not.toHaveBeenCalled();
  });

  it('quiet: an unset URL writes nothing either', async () => {
    setUrl(undefined);
    resetResolveDbUrlWarningForTests();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await withPgClientOrFallback(noop, 0, 'ctx', { quiet: true });
    expect(r.degraded).toBe(true);
    expect(err).not.toHaveBeenCalled();
  });

  it('totalMs: a server that accepts and never answers is cut at the cap', async () => {
    server = createServer(() => { /* accept, never answer */ });
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    setUrl(`postgresql://u:p@127.0.0.1:${port}/db`);
    const t0 = Date.now();
    const r = await withPgClientOrFallback(noop, 0, 'ctx', { quiet: true, totalMs: 300 });
    expect(r.degraded).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1200);
  });

  it('listBlockingClaims (the real function) against a hung server: degraded within the 1 s budget and silent', async () => {
    server = createServer(() => { /* accept, never answer */ });
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    setUrl(`postgresql://u:p@127.0.0.1:${port}/db`);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t0 = Date.now();
    const r = await listBlockingClaims('me', 300000);
    expect(r).toEqual({ claims: [], degraded: true });
    expect(Date.now() - t0).toBeLessThan(1600);
    expect(err).not.toHaveBeenCalled();
  });

  it('without options the old degraded line is still printed', async () => {
    setUrl('postgresql://u:p@127.0.0.1:1/db');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withPgClientOrFallback(noop, 0, 'ctx');
    expect(err.mock.calls.some((c) => String(c[0]).includes('degraded'))).toBe(true);
  });
});
