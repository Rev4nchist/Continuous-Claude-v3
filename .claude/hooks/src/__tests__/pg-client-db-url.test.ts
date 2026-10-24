/**
 * CONTINUOUS_CLAUDE_DB_URL resolution.
 *
 * A missing URL must not fall back to a credential baked into source.
 * One stderr WARN per process names the variables and not a value.
 * DB work is skipped (degraded, no connect). A set variable resolves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pgClient from '../shared/pg-client.js';
import { getPgConnectionString, withPgClientOrFallback } from '../shared/pg-client.js';

const PLACEHOLDER_URL = 'postgresql://user:PLACEHOLDER@localhost:5432/db';

const KEYS = ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL'] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const reset = (pgClient as { resetResolveDbUrlWarningForTests?: () => void }).resetResolveDbUrlWarningForTests;
  reset?.();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe('getPgConnectionString when no database URL is set', () => {
  it('warns once, names the variables, and does not return a credential', () => {
    expect(getPgConnectionString()).toBeNull();
    expect(getPgConnectionString()).toBeNull();

    const error = vi.mocked(console.error);
    expect(error).toHaveBeenCalledTimes(1);
    const text = error.mock.calls.map(call => call.map(String).join(' ')).join('\n');
    expect(text).toMatch(/WARN/);
    expect(text).toContain('CONTINUOUS_CLAUDE_DB_URL');
    expect(text).toContain('DATABASE_URL');
    expect(text).toContain('OPC_POSTGRES_URL');
    expect(text).not.toMatch(/postgresql:\/\//);
    expect(text).not.toContain('@');
    expect(text).not.toContain('PLACEHOLDER');
  });

  it('treats an empty string as unset', () => {
    process.env.CONTINUOUS_CLAUDE_DB_URL = '';
    process.env.DATABASE_URL = '   ';
    process.env.OPC_POSTGRES_URL = '';
    expect(getPgConnectionString()).toBeNull();
    const text = vi.mocked(console.error).mock.calls.map(call => call.map(String).join(' ')).join('\n');
    expect(text).not.toMatch(/postgresql:\/\//);
  });

  it('skips the connection and does not log a second warning', async () => {
    const result = await withPgClientOrFallback(async () => 'unused', 'fallback', 'missing-url');
    expect(result.degraded).toBe(true);
    expect(result.value).toBe('fallback');
    expect(result.error || '').not.toMatch(/postgresql:\/\//);
    const text = vi.mocked(console.error).mock.calls.map(call => call.map(String).join(' ')).join('\n');
    expect(text).toMatch(/WARN/);
    expect(text).not.toMatch(/degraded:/);
    expect(text).not.toMatch(/postgresql:\/\//);
  });
});

describe('getPgConnectionString when a URL is set', () => {
  it('resolves CONTINUOUS_CLAUDE_DB_URL and does not warn', () => {
    process.env.CONTINUOUS_CLAUDE_DB_URL = PLACEHOLDER_URL;
    process.env.DATABASE_URL = 'postgresql://user:OTHER@localhost:5432/other';
    expect(getPgConnectionString()).toBe(PLACEHOLDER_URL);
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
  });

  it('falls back to OPC_POSTGRES_URL when the other two are unset', () => {
    process.env.OPC_POSTGRES_URL = PLACEHOLDER_URL;
    expect(getPgConnectionString()).toBe(PLACEHOLDER_URL);
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
  });
});
