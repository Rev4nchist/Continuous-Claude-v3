/**
 * Negative control for the coordination transport's `degraded` flag.
 *
 * coordination-transport.test.ts asserts that an unreachable database reports
 * degraded: true. Every one of those assertions would still pass if the code
 * simply hardcoded degraded: true and never worked at all -- the exact shape of
 * vacuous guard that let a broken file lock show green for weeks.
 *
 * This file is the other half: with a driver that SUCCEEDS, degraded must be
 * false and the callback's real value must come back. It mocks `pg` so the
 * assertion is deterministic and needs no running container.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PLACEHOLDER_URL = 'postgresql://user:PLACEHOLDER@localhost:5432/db';
let savedDbUrl: string | undefined;

const connect = vi.fn(async () => undefined);
const end = vi.fn(async () => undefined);
const query = vi.fn(async () => ({ rows: [{ ok: true }] }));

vi.mock('pg', () => ({
  Client: class {
    connect = connect;
    end = end;
    query = query;
    on = () => this;
  },
}));

const { withPgClient, withPgClientOrFallback } = await import('../shared/pg-client.js');

beforeEach(() => {
  savedDbUrl = process.env.CONTINUOUS_CLAUDE_DB_URL;
  process.env.CONTINUOUS_CLAUDE_DB_URL = PLACEHOLDER_URL;
  connect.mockClear();
  end.mockClear();
  query.mockClear();
});

afterEach(() => {
  if (savedDbUrl === undefined) delete process.env.CONTINUOUS_CLAUDE_DB_URL;
  else process.env.CONTINUOUS_CLAUDE_DB_URL = savedDbUrl;
});

describe('withPgClientOrFallback on a working connection', () => {
  it('returns the callback value and does NOT report degraded', async () => {
    const { value, degraded, error } = await withPgClientOrFallback(
      async () => 'real answer',
      'fallback value',
      'success-control'
    );

    expect(degraded).toBe(false);
    expect(value).toBe('real answer');
    expect(error).toBeUndefined();
  });

  it('degrades when the callback itself throws, even though connecting worked', async () => {
    // Distinguishes "cannot reach the DB" from "the query failed" -- both must
    // degrade, or a broken statement would silently look like a real answer.
    const { value, degraded } = await withPgClientOrFallback(
      async () => {
        throw new Error('relation "file_claims" does not exist');
      },
      'fallback value',
      'query-failure'
    );

    expect(degraded).toBe(true);
    expect(value).toBe('fallback value');
  });
});

describe('connection lifecycle', () => {
  it('closes the client on the success path', async () => {
    await withPgClient(async (c) => c.query('SELECT 1'));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('closes the client even when the callback throws', async () => {
    // A hook process that leaks a connection per Edit would exhaust
    // max_connections and take the whole coordination layer down with it.
    await expect(
      withPgClient(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(end).toHaveBeenCalledTimes(1);
  });
});
