#!/usr/bin/env node
/**
 * Session End Handoff Indexer Hook
 *
 * After a SessionEnd event, scans ``thoughts/shared/handoffs/`` for a handoff
 * file that was written within the last 30 seconds and (if found) spawns the
 * Python indexer to push that handoff's fields into ``archival_memory``.
 *
 * This complements ``session-end-extract`` (which extracts learnings from the
 * transcript itself) and ``handoff-index`` (the PostToolUse hook that writes a
 * filesystem JSON sidecar for each handoff).
 *
 * Design notes:
 *   - Fire-and-forget: never blocks SessionEnd (which has a 30-60s budget).
 *   - Fail-open: any error -> log + exit 0.
 *   - Idempotent: ``index_handoffs.py`` skips entries already present in
 *     ``archival_memory`` (matched by ``(handoff_path, handoff_field)``),
 *     so re-runs do no harm.
 *
 * Phase 1.7 of the memory hardening v2 plan (Task #8 / G7).
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { spawnDetachedHidden } from './lib/spawn-hidden.js';

interface SessionEndInput {
  session_id?: string;
  type?: string;
  transcript_path?: string;
}

// A handoff written more than this many ms before SessionEnd is treated as
// "already indexed by a previous run" and skipped. 30 seconds matches the
// PostToolUse handoff-index hook's typical lag.
export const RECENT_WINDOW_MS = 30_000;

// File extensions we consider as handoff payloads.
export const HANDOFF_EXTS = ['.yaml', '.yml', '.md'] as const;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

export interface FindRecentHandoffInput {
  /** Repo root or any directory containing ``thoughts/shared/handoffs/``. */
  projectDir: string;
  /** ``Date.now()`` at hook invocation; can be injected in tests. */
  now: number;
  /** How recently the file must have been modified (ms). */
  recentMs?: number;
  /** Filesystem dependency injection for tests. */
  fsApi?: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'statSync'>;
}

/**
 * Walk ``<projectDir>/thoughts/shared/handoffs/`` and return the most recently
 * modified handoff file iff its mtime is within ``recentMs`` of ``now``.
 *
 * Returns ``null`` when:
 *   - the handoffs directory doesn't exist
 *   - no handoff files exist
 *   - the newest handoff is older than ``recentMs``
 */
export function findRecentHandoff(input: FindRecentHandoffInput): string | null {
  const recentMs = input.recentMs ?? RECENT_WINDOW_MS;
  const fsApi = input.fsApi ?? fs;
  const handoffsDir = path.join(input.projectDir, 'thoughts', 'shared', 'handoffs');

  if (!fsApi.existsSync(handoffsDir)) return null;

  let newest: { abs: string; mtimeMs: number } | null = null;

  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return; // hard cap to avoid pathological deep trees
    let entries: fs.Dirent[];
    try {
      entries = fsApi.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip archive directories
        if (entry.name.toLowerCase() === 'archive') continue;
        walk(child, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!HANDOFF_EXTS.includes(ext as (typeof HANDOFF_EXTS)[number])) continue;
      try {
        const stat = fsApi.statSync(child);
        if (newest === null || stat.mtimeMs > newest.mtimeMs) {
          newest = { abs: child, mtimeMs: stat.mtimeMs };
        }
      } catch {
        // ignore stat failures
      }
    }
  };

  walk(handoffsDir, 0);

  if (newest === null) return null;
  if (input.now - (newest as { mtimeMs: number }).mtimeMs > recentMs) return null;
  return (newest as { abs: string }).abs;
}

export interface ResolveIndexerScriptInput {
  /** ``CLAUDE_OPC_DIR`` or its default if unset. */
  opcDir: string;
  fsApi?: Pick<typeof fs, 'existsSync'>;
}

/**
 * Locate ``index_handoffs.py`` (the new bulk indexer).
 *
 * We prefer ``<opcDir>/scripts/core/index_handoffs.py`` (the canonical
 * location for repo-level work) but fall back to the active install at
 * ``~/.claude/scripts/core/core/index_handoffs.py`` so the hook still
 * works after a forward sync.
 */
export function resolveIndexerScript(input: ResolveIndexerScriptInput): string | null {
  const fsApi = input.fsApi ?? fs;
  const candidates = [
    path.join(input.opcDir, 'scripts', 'core', 'index_handoffs.py'),
    path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.claude',
      'scripts',
      'core',
      'core',
      'index_handoffs.py',
    ),
  ];
  for (const c of candidates) {
    if (c && fsApi.existsSync(c)) return c;
  }
  return null;
}

export function getOpcDir(): string {
  if (process.env.CLAUDE_OPC_DIR) return process.env.CLAUDE_OPC_DIR;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, 'continuous-claude', 'opc');
}

export function getLogPath(projectDir: string): string {
  return path.join(projectDir, '.claude', 'logs', 'handoff-indexer.log');
}

export function appendLog(logPath: string, message: string): void {
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} ${message}\n`;
    fs.appendFileSync(logPath, line);
  } catch {
    // never throw from a logging helper
  }
}

// ---------------------------------------------------------------------------
// Spawn the indexer (kept as a thin wrapper so tests can stub it)
// ---------------------------------------------------------------------------

export interface SpawnIndexerInput {
  scriptPath: string;
  handoffPath: string;
  opcDir: string;
  /** Spawn dependency injection for tests. */
  spawnFn?: typeof spawn;
}

export function spawnIndexer(input: SpawnIndexerInput): void {
  const spawner = input.spawnFn ?? spawn;
  const child = spawnDetachedHidden(
    'uv',
    [
      'run',
      'python',
      input.scriptPath,
      '--apply',
      '--only-path',
      input.handoffPath,
    ],
    {
      cwd: input.opcDir,
      stdio: 'ignore',
      env: { ...process.env, PYTHONPATH: input.opcDir },
    },
    spawner,
  );
  child.unref?.();
}

// ---------------------------------------------------------------------------
// Decision logic (pure, easy to test)
// ---------------------------------------------------------------------------

export type Decision =
  | { action: 'skip'; reason: string }
  | { action: 'index'; handoffPath: string; scriptPath: string };

export interface DecideInput {
  projectDir: string | null;
  opcDir: string;
  now: number;
  recentMs?: number;
  fsApi?: Pick<typeof fs, 'existsSync' | 'readdirSync' | 'statSync'>;
}

export function decideIndex(input: DecideInput): Decision {
  if (!input.projectDir) {
    return { action: 'skip', reason: 'no_project_dir' };
  }
  const handoffPath = findRecentHandoff({
    projectDir: input.projectDir,
    now: input.now,
    recentMs: input.recentMs,
    fsApi: input.fsApi,
  });
  if (!handoffPath) {
    return { action: 'skip', reason: 'no_recent_handoff' };
  }
  const scriptPath = resolveIndexerScript({
    opcDir: input.opcDir,
    fsApi: input.fsApi,
  });
  if (!scriptPath) {
    return { action: 'skip', reason: 'indexer_script_missing' };
  }
  return { action: 'index', handoffPath, scriptPath };
}

// ---------------------------------------------------------------------------
// Main (only runs when invoked as a hook, not from tests)
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main(): Promise<void> {
  let input: SessionEndInput = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw) as SessionEndInput;
  } catch {
    // Fall through: empty input is treated as "no recent handoff"
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const opcDir = getOpcDir();
  const logPath = getLogPath(projectDir);

  try {
    const decision = decideIndex({
      projectDir,
      opcDir,
      now: Date.now(),
    });

    if (decision.action === 'skip') {
      appendLog(
        logPath,
        `skip session=${input.session_id ?? '<unknown>'} reason=${decision.reason}`,
      );
      console.log(JSON.stringify({ result: 'continue' }));
      return;
    }

    appendLog(
      logPath,
      `index session=${input.session_id ?? '<unknown>'} ` +
        `handoff=${decision.handoffPath}`,
    );

    spawnIndexer({
      scriptPath: decision.scriptPath,
      handoffPath: decision.handoffPath,
      opcDir,
    });
  } catch (err) {
    appendLog(logPath, `error: ${(err as Error).message ?? err}`);
  }

  console.log(JSON.stringify({ result: 'continue' }));
}

// Only run main() when invoked directly. Vitest imports this module to test
// the pure helpers; we must not consume stdin or spawn anything then.
const invokedDirectly = (() => {
  try {
    const argvFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
    // ``import.meta.url`` would be ideal but adds ESM complexity; resolved
    // filename matching is robust enough for the hook's bundled output.
    return argvFile.endsWith('session-end-handoff-indexer.mjs') ||
      argvFile.endsWith('session-end-handoff-indexer.js') ||
      argvFile.endsWith('session-end-handoff-indexer.ts');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error('session-end-handoff-indexer error:', err);
    console.log(JSON.stringify({ result: 'continue' }));
  });
}
