/**
 * Tests for session-bus-id (WS-2 Phase A.0).
 *
 * getBusId() derives a stable per-(user, project, session) id used by the
 * Phase A.1 context bus to compute its session-scoped file path:
 *   .claude/cache/session/<bus_id>/context.json
 *
 * Windows-correctness requirements under test (findings #11/#12):
 *  - USERPROFILE honored when HOME is unset (HOME alone -> /tmp on Windows).
 *  - Per-project isolation via sha256(realpath(cwd).toLowerCase()), NOT inode
 *    (cwd_inode is 0 on NTFS, giving zero isolation).
 *  - Case-insensitive: same path, different case -> same bus_id.
 *  - Fail-open: realpath throwing must NOT throw out of getBusId().
 *
 * Runner is vitest (NOT jest); globals enabled via vitest.config.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getBusId,
  hashProjectPath,
  sanitizeBusPart,
} from '../shared/session-bus-id.js';

// Snapshot/restore the env keys getBusId reads, so mutating them per-test is safe.
const ENV_KEYS = [
  'USERPROFILE',
  'HOME',
  'COORDINATION_SESSION_ID',
  'BRAINTRUST_SPAN_ID',
  'CLAUDE_PROJECT_DIR',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Deterministic baseline: pin a stable session signal, clear the rest.
  delete process.env.HOME;
  delete process.env.BRAINTRUST_SPAN_ID;
  delete process.env.CLAUDE_PROJECT_DIR;
  process.env.USERPROFILE = 'C:/Users/test-user';
  process.env.COORDINATION_SESSION_ID = 's-fixed1';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('getBusId — basic contract', () => {
  it('returns a non-empty string', () => {
    const id = getBusId({ cwd: 'C:/Users/test-user/projects/alpha' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('contains only filesystem-safe characters (usable as a directory name)', () => {
    const id = getBusId({ cwd: 'C:/Users/test-user/projects/alpha' });
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('getBusId — session signal (#11 USERPROFILE)', () => {
  it('is stable when USERPROFILE is set and HOME is unset', () => {
    delete process.env.HOME;
    process.env.USERPROFILE = 'C:/Users/test-user';
    const a = getBusId({ cwd: 'C:/Users/test-user/projects/alpha' });
    const b = getBusId({ cwd: 'C:/Users/test-user/projects/alpha' });
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('changes when the session signal changes (different project unchanged)', () => {
    const cwd = 'C:/Users/test-user/projects/alpha';
    process.env.COORDINATION_SESSION_ID = 's-aaa';
    const a = getBusId({ cwd });
    process.env.COORDINATION_SESSION_ID = 's-bbb';
    const b = getBusId({ cwd });
    expect(a).not.toBe(b);
  });
});

describe('getBusId — project isolation (#12)', () => {
  it('two different cwd paths produce different bus_ids', () => {
    const a = getBusId({ cwd: 'C:/Users/test-user/projects/alpha' });
    const b = getBusId({ cwd: 'C:/Users/test-user/projects/beta' });
    expect(a).not.toBe(b);
  });

  it('same path with different case produces the SAME bus_id (NTFS case-insensitive)', () => {
    // Use the raw-cwd fail-open path (inject a realpath that returns its input
    // unchanged) so the test is deterministic regardless of the real fs layout.
    const passthrough = (p: string) => p;
    const lower = getBusId({ cwd: 'C:/Users/test-user/projects/alpha', realpath: passthrough });
    const upper = getBusId({ cwd: 'C:/USERS/TEST-USER/PROJECTS/ALPHA', realpath: passthrough });
    expect(lower).toBe(upper);
  });
});

describe('getBusId — stability', () => {
  it('is stable across repeated calls within the same session + project', () => {
    const cwd = 'C:/Users/test-user/projects/gamma';
    const ids = [getBusId({ cwd }), getBusId({ cwd }), getBusId({ cwd })];
    expect(new Set(ids).size).toBe(1);
  });
});

describe('getBusId — fail-open (never throws)', () => {
  it('falls back to hashing the raw cwd when realpath throws, and does not throw', () => {
    const throwing = () => {
      throw new Error('ENOENT: simulated missing path');
    };
    let id = '';
    expect(() => {
      id = getBusId({ cwd: 'C:/Users/test-user/projects/missing', realpath: throwing });
    }).not.toThrow();
    expect(id.length).toBeGreaterThan(0);
  });

  it('fail-open result is itself stable and case-insensitive', () => {
    const throwing = () => {
      throw new Error('boom');
    };
    const a = getBusId({ cwd: 'C:/Users/test-user/projects/missing', realpath: throwing });
    const b = getBusId({ cwd: 'C:/USERS/TEST-USER/PROJECTS/MISSING', realpath: throwing });
    expect(a).toBe(b);
  });

  it('never throws even with no options and no env at all', () => {
    delete process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.COORDINATION_SESSION_ID;
    expect(() => getBusId()).not.toThrow();
    expect(getBusId().length).toBeGreaterThan(0);
  });
});

describe('sanitizeBusPart — can never emit `..` (finding #3 hardening)', () => {
  it('collapses a bare `..` so it cannot become a traversal segment', () => {
    const out = sanitizeBusPart('..');
    expect(out).not.toBe('..');
    expect(out).not.toContain('..');
  });

  it('collapses any run of dots to a single dot', () => {
    expect(sanitizeBusPart('a..b')).not.toContain('..');
    expect(sanitizeBusPart('a...b')).not.toContain('..');
    expect(sanitizeBusPart('....')).not.toContain('..');
  });

  it('still strips path separators and unsafe characters', () => {
    expect(sanitizeBusPart('a/b')).not.toContain('/');
    expect(sanitizeBusPart('a\\b')).not.toContain('\\');
    expect(sanitizeBusPart('a b!@#')).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('leaves an already-safe single-dot value alone', () => {
    expect(sanitizeBusPart('v1.2.3')).toBe('v1.2.3');
  });

  it('getBusId never embeds `..` even when the session signal is hostile', () => {
    // A session signal of ".." must not survive into the bus id as a traversal.
    process.env.COORDINATION_SESSION_ID = '..';
    const id = getBusId({ cwd: 'C:/Users/test-user/projects/alpha', realpath: (p) => p });
    expect(id).not.toContain('..');
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('hashProjectPath — helper', () => {
  it('returns a hex prefix of stable length', () => {
    const h = hashProjectPath('C:/Users/test-user/projects/alpha', (p) => p);
    expect(h).toMatch(/^[0-9a-f]+$/);
    expect(h.length).toBe(12);
  });

  it('is case-insensitive', () => {
    const a = hashProjectPath('C:/Users/test-user/projects/alpha', (p) => p);
    const b = hashProjectPath('C:/USERS/TEST-USER/PROJECTS/ALPHA', (p) => p);
    expect(a).toBe(b);
  });

  it('differs for different paths', () => {
    const a = hashProjectPath('C:/a', (p) => p);
    const b = hashProjectPath('C:/b', (p) => p);
    expect(a).not.toBe(b);
  });

  it('falls back to the raw path when realpath throws', () => {
    const viaRealpath = hashProjectPath('C:/x', (p) => p);
    const viaFallback = hashProjectPath('C:/x', () => {
      throw new Error('no such path');
    });
    // Same input string, one resolved by passthrough realpath, one by raw
    // fallback -> identical hash (both hash the same lowercased raw string).
    expect(viaFallback).toBe(viaRealpath);
  });
});
