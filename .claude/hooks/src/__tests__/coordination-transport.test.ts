/**
 * Guards on the coordination transport (Step 1b, 2026-07-26).
 *
 * The claim path used to reach Postgres through `uv run python -c` with a
 * 3-second spawnSync timeout. Under concurrency that budget is missed, the
 * failure is read as "no claim exists", and the file lock silently opens --
 * measured at 6/60 intruders ALLOWED onto a file an active session held.
 *
 * These tests cover the two properties that are cheap to assert in-process:
 *   1. the coordination calls are async, so nobody can quietly reintroduce a
 *      blocking subprocess and call it done;
 *   2. an unreachable database degrades LOUDLY -- returns the fallback, reports
 *      degraded, and carries a diagnosable reason.
 *
 * They deliberately do NOT cover the property that actually broke, because it
 * only appears under concurrency across real processes. That gate is
 * `scripts/coordination/load-probe.mjs`, and it must be run against a built
 * dist after any change to the claim path:
 *
 *   node scripts/coordination/load-probe.mjs --hook <dist/file-claims.mjs> --n 20
 *
 * A green run of THIS file is not evidence the lock holds.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkFileClaim,
  claimFile,
  isSessionActive,
  registerSession,
  getActiveSessions,
} from '../shared/db-utils-pg.js';
import { withPgClientOrFallback, getPgConnectionString } from '../shared/pg-client.js';

// A port nothing listens on, so every call takes the failure path deterministically
// without needing (or touching) the real coordination database.
const DEAD_URL = 'postgresql://claude:claude_dev@127.0.0.1:59999/continuous_claude';

let savedUrl: string | undefined;
let savedDatabaseUrl: string | undefined;

beforeEach(() => {
  savedUrl = process.env.CONTINUOUS_CLAUDE_DB_URL;
  savedDatabaseUrl = process.env.DATABASE_URL;
  process.env.CONTINUOUS_CLAUDE_DB_URL = DEAD_URL;
  // Degradation is reported on stderr by design; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (savedUrl === undefined) delete process.env.CONTINUOUS_CLAUDE_DB_URL;
  else process.env.CONTINUOUS_CLAUDE_DB_URL = savedUrl;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  vi.restoreAllMocks();
});

describe('coordination calls are async', () => {
  // The regression this blocks: reverting any of these to a synchronous
  // spawnSync helper. A sync function returns a plain object here, not a
  // thenable, so the assertion fails immediately.
  const cases: Array<[string, () => unknown]> = [
    ['checkFileClaim', () => checkFileClaim('f.ts', 'p', 's')],
    ['claimFile', () => claimFile('f.ts', 'p', 's')],
    ['isSessionActive', () => isSessionActive('s')],
    ['registerSession', () => registerSession('s', 'p')],
    ['getActiveSessions', () => getActiveSessions('p')],
  ];

  for (const [name, call] of cases) {
    it(`${name} returns a Promise`, async () => {
      const returned = call();
      expect(typeof (returned as Promise<unknown>)?.then).toBe('function');
      await returned; // settle it so the dead connection cannot leak into another test
    });
  }
});

describe('unreachable database degrades loudly, not silently', () => {
  it('checkFileClaim reports degraded rather than claiming the file is free', async () => {
    const result = await checkFileClaim('f.ts', 'p', 's');

    // Still permits the edit -- a stopped container must not brick editing ...
    expect(result.claimed).toBe(false);
    // ... but the caller can now tell "nobody holds it" from "I could not ask",
    // which is the distinction whose absence hid a broken lock for weeks.
    expect(result.degraded).toBe(true);
  });

  // The matching negative control -- that `degraded` is false on success rather
  // than pinned true -- cannot live in this file: withPgClientOrFallback connects
  // BEFORE running its callback, so the dead URL above degrades every call no
  // matter what the callback returns. It lives in pg-client-success.test.ts,
  // which mocks the driver. Without that companion, every assertion here would
  // pass on a function that hardcoded `degraded: true`.

  it('the degraded reason is diagnosable, not an empty string', async () => {
    // Node's happy-eyeballs connect throws an AggregateError whose own .message
    // is empty; reading it naively logs "degraded:" and nothing else.
    const { degraded, error } = await withPgClientOrFallback(
      async () => 'unused',
      null,
      'connect-failure'
    );
    expect(degraded).toBe(true);
    expect(error).toBeTruthy();
    expect(error).toMatch(/ECONNREFUSED/);
  });

  it('registerSession surfaces the failure instead of reporting success', async () => {
    const result = await registerSession('s', 'p');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('claimFile reports failure when it could not write', async () => {
    const result = await claimFile('f.ts', 'p', 's');
    expect(result.success).toBe(false);
  });

  it('isSessionActive treats an unreachable DB as "not provably alive"', async () => {
    // False here means the caller takes over a stale lock. That is the correct
    // bias when the DB is down: it keeps a dead session from holding files
    // hostage. It is only dangerous when it happens under LOAD against a live
    // DB -- which is exactly what the transport swap removed.
    expect(await isSessionActive('s')).toBe(false);
  });
});

describe('connection string resolution', () => {
  it('prefers CONTINUOUS_CLAUDE_DB_URL over DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://other/db';
    expect(getPgConnectionString()).toBe(DEAD_URL);
  });

  it('falls back to DATABASE_URL when the canonical var is unset', () => {
    delete process.env.CONTINUOUS_CLAUDE_DB_URL;
    process.env.DATABASE_URL = 'postgresql://other/db';
    expect(getPgConnectionString()).toBe('postgresql://other/db');
  });
});
