/**
 * Backup trigger for the memory store (TypeScript side).
 *
 * The backup itself is opc/scripts/core/memory_backup.py. This file only finds the
 * newest backup file and decides whether to start a new one in the background.
 * It never restores: a restore is a command the health line prints for Dave.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { spawnDetachedHidden } from '../lib/spawn-hidden.js';

/** A backup older than this is replaced at the next SessionStart. */
export const BACKUP_MAX_AGE_MS = 24 * 3600_000;
const BACKUP_FILE = /^archival_memory-\d{8}\.jsonl$/;

export interface BackupFile {
  path: string;
  mtimeMs: number;
}

export function backupDir(stateDir: string): string {
  return join(stateDir, 'memory-backup');
}

/** Newest backup by modification time, or null when the folder is missing or empty. */
export function newestBackup(stateDir: string): BackupFile | null {
  const dir = backupDir(stateDir);
  let best: BackupFile | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!BACKUP_FILE.test(name)) continue;
      const path = join(dir, name);
      const mtimeMs = statSync(path).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    }
  } catch {
    return null;
  }
  return best;
}

export function needsBackup(newest: BackupFile | null, now: Date): boolean {
  return newest === null || now.getTime() - newest.mtimeMs > BACKUP_MAX_AGE_MS;
}

type SpawnFn = (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Start `memory_backup.py backup` detached and hidden. Returns true when it started. */
export function spawnBackup(opcDir: string, spawnFn: SpawnFn = spawn): boolean {
  try {
    const child = spawnDetachedHidden(
      'uv',
      ['run', 'python', 'scripts/core/memory_backup.py', 'backup'],
      { cwd: opcDir, stdio: 'ignore', env: { ...process.env, PYTHONPATH: opcDir } },
      spawnFn,
    );
    child.on?.('error', () => { /* relay failure: the next SessionStart tries again */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The exact command that restores `file`. Never adds --yes. */
export function restoreCommand(opcDir: string | null, file: string): string {
  const dir = opcDir ? ` --directory "${opcDir}"` : '';
  return `uv run${dir} python scripts/core/memory_backup.py restore --file "${file}"`;
}
