/**
 * Tests for ``session-end-handoff-indexer.ts``.
 *
 * The hook is a SessionEnd handler that spawns ``index_handoffs.py`` whenever
 * a handoff file was written within ``RECENT_WINDOW_MS`` before the session
 * ended. We test the pure helpers + ``decideIndex`` so the spawn step itself
 * never needs to fire during tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

import {
  RECENT_WINDOW_MS,
  decideIndex,
  findRecentHandoff,
  resolveIndexerScript,
} from '../session-end-handoff-indexer.js';

let testDir: string;
let projectDir: string;
let opcDir: string;

function makeHandoff(rel: string, mtimeMs: number, body = 'session: x\n'): string {
  const abs = path.join(projectDir, 'thoughts', 'shared', 'handoffs', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  const stamp = new Date(mtimeMs);
  fs.utimesSync(abs, stamp, stamp);
  return abs;
}

function makeIndexerScript(): string {
  const dir = path.join(opcDir, 'scripts', 'core');
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, 'index_handoffs.py');
  fs.writeFileSync(abs, '#!/usr/bin/env python3\nprint("noop")\n');
  return abs;
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'session-end-handoff-indexer-'));
  projectDir = path.join(testDir, 'repo');
  opcDir = path.join(projectDir, 'opc');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(opcDir, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// findRecentHandoff
// ---------------------------------------------------------------------------

describe('findRecentHandoff', () => {
  it('returns null when the handoffs directory does not exist', () => {
    expect(
      findRecentHandoff({ projectDir, now: Date.now() }),
    ).toBeNull();
  });

  it('returns null when no handoff files exist', () => {
    fs.mkdirSync(path.join(projectDir, 'thoughts', 'shared', 'handoffs'), {
      recursive: true,
    });
    expect(
      findRecentHandoff({ projectDir, now: Date.now() }),
    ).toBeNull();
  });

  it('returns the newest handoff when it is within the recent window', () => {
    const now = Date.now();
    const recent = makeHandoff('auto-handoff-dir/h.yaml', now - 5_000);
    makeHandoff('kraken-x/current.md', now - 60_000);
    const found = findRecentHandoff({ projectDir, now });
    expect(found).toBe(recent);
  });

  it('returns null when the newest handoff is older than the window', () => {
    const now = Date.now();
    makeHandoff('auto-handoff-dir/h.yaml', now - RECENT_WINDOW_MS - 10_000);
    expect(findRecentHandoff({ projectDir, now })).toBeNull();
  });

  it('skips files under archive/ subdirs', () => {
    const now = Date.now();
    makeHandoff('archive/old.yaml', now - 1_000);
    // The only file is archived -> no recent handoff
    expect(findRecentHandoff({ projectDir, now })).toBeNull();
  });

  it('honours the recentMs override', () => {
    const now = Date.now();
    const recent = makeHandoff('auto-handoff-dir/h.yaml', now - 15 * 60_000);
    expect(findRecentHandoff({ projectDir, now })).toBeNull();
    expect(
      findRecentHandoff({ projectDir, now, recentMs: 20 * 60_000 }),
    ).toBe(recent);
  });

  it('finds a handoff written 8 minutes before SessionEnd (default window is about 10 minutes)', () => {
    // Live log: 103 of 103 SessionEnd runs skipped with no_recent_handoff under the 30 s window.
    const now = Date.now();
    const recent = makeHandoff('auto-handoff-dir/h.yaml', now - 8 * 60_000);
    expect(findRecentHandoff({ projectDir, now })).toBe(recent);
  });

  it('still skips a handoff written 12 minutes before SessionEnd', () => {
    const now = Date.now();
    makeHandoff('auto-handoff-dir/h.yaml', now - 12 * 60_000);
    expect(findRecentHandoff({ projectDir, now })).toBeNull();
  });

  it('ignores files with unrelated extensions', () => {
    const now = Date.now();
    const dir = path.join(projectDir, 'thoughts', 'shared', 'handoffs', 'x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'note.txt'), 'hi');
    fs.utimesSync(path.join(dir, 'note.txt'), new Date(now), new Date(now));
    expect(findRecentHandoff({ projectDir, now })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveIndexerScript
// ---------------------------------------------------------------------------

describe('resolveIndexerScript', () => {
  it('returns the path when index_handoffs.py exists under opc/scripts/core', () => {
    const script = makeIndexerScript();
    expect(resolveIndexerScript({ opcDir })).toBe(script);
  });

  it('falls back to ~/.claude/scripts/core/index_handoffs.py when opcDir has no script', () => {
    // The active install keeps the script at scripts/core, not scripts/core/core.
    const home = path.join(testDir, 'home');
    const fallback = path.join(home, '.claude', 'scripts', 'core', 'index_handoffs.py');
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.writeFileSync(fallback, 'print("noop")');
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      expect(resolveIndexerScript({ opcDir })).toBe(fallback);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('returns null when no candidate path exists', () => {
    // Stub the fallback ~/.claude path away so we don't accidentally match
    // the developer's real install.
    const stubFs = {
      existsSync: (_p: fs.PathLike): boolean => false,
    };
    expect(resolveIndexerScript({ opcDir, fsApi: stubFs })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decideIndex (top-level orchestration)
// ---------------------------------------------------------------------------

describe('decideIndex', () => {
  it('skips when no project dir is configured', () => {
    const result = decideIndex({
      projectDir: null,
      opcDir,
      now: Date.now(),
    });
    expect(result).toEqual({ action: 'skip', reason: 'no_project_dir' });
  });

  it('skips when no recent handoff is present', () => {
    makeIndexerScript();
    const result = decideIndex({ projectDir, opcDir, now: Date.now() });
    expect(result).toEqual({ action: 'skip', reason: 'no_recent_handoff' });
  });

  it('skips when the indexer script is missing', () => {
    const now = Date.now();
    makeHandoff('auto-handoff-dir/h.yaml', now - 1_000);
    // Stub fsApi so it can see the handoff but never matches any script path
    const realFs = fs;
    const handoff = path.join(
      projectDir,
      'thoughts',
      'shared',
      'handoffs',
      'auto-handoff-dir',
      'h.yaml',
    );
    const fakeFs = {
      existsSync: (p: fs.PathLike): boolean => {
        const s = String(p);
        if (s.endsWith('index_handoffs.py')) return false;
        return realFs.existsSync(s);
      },
      readdirSync: realFs.readdirSync,
      statSync: realFs.statSync,
    };
    const result = decideIndex({
      projectDir,
      opcDir,
      now,
      fsApi: fakeFs,
    });
    expect(result).toEqual({ action: 'skip', reason: 'indexer_script_missing' });
    expect(handoff).toBeTruthy(); // sanity-check the helper
  });

  it('returns index decision when handoff is recent and script exists', () => {
    const now = Date.now();
    const handoff = makeHandoff('auto-handoff-dir/h.yaml', now - 5_000);
    const script = makeIndexerScript();
    const result = decideIndex({ projectDir, opcDir, now });
    expect(result.action).toBe('index');
    if (result.action === 'index') {
      expect(result.handoffPath).toBe(handoff);
      expect(result.scriptPath).toBe(script);
    }
  });
});
