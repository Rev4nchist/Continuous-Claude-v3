/**
 * Memory health line for SessionStart.
 *
 * WHY: on 2026-10-24 the database was recreated. archival_memory sat empty and every
 * store and recall failed for 3 days. Nothing reported it. This module reads the store
 * through the hooks' pg client (no uv spawn), formats one line, and counts the failed
 * writes that opc/scripts/core/memory_write_log.py logged.
 *
 * Posture: fail open. A failed probe is never a clean line; it is the UNKNOWN line.
 * Nothing here throws.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { withPgClient } from './pg-client.js';
import { needsBackup, newestBackup, restoreCommand, spawnBackup } from './memory-backup.js';

/** The one copy of the expected schema version. docker/init-schema.sql must carry the same string. */
export const EXPECTED_SCHEMA_VERSION = '2026-10-27.1';
export const STALE_DAYS = 14;
export const PROBE_TIMEOUT_MS = 3000;
const DAY_MS = 24 * 3600_000;

export type MemoryProbe =
  | { kind: 'unknown'; reason: string }
  | { kind: 'ok'; database: string; rows: number; newest: Date | null; noEmbedding: number; schema: string };

export interface HealthContext {
  now: Date;
  failedWrites: number;
  failureLogPath: string;
  restoreCommand: string | null;
}

export interface HealthLine {
  line: string;
  /** True for EMPTY, UNKNOWN, schema MISMATCH and failed writes. The hook sets systemMessage for these. */
  warn: boolean;
}

type PgRunner = <T>(fn: (client: { query: (sql: string) => Promise<{ rows: any[] }> }) => Promise<T>) => Promise<T>;

const MAIN_SQL =
  'SELECT current_database() AS db, count(*)::int AS rows, max(created_at) AS newest, ' +
  'count(*) FILTER (WHERE embedding IS NULL)::int AS no_emb FROM archival_memory';
const SCHEMA_SQL = "SELECT value FROM schema_meta WHERE key = 'schema_version'";

/** Short reason for the UNKNOWN line. Never carries a URL. */
function shortReason(err: unknown): string {
  const e = err as { code?: string; message?: string } | undefined;
  const raw = e?.code || e?.message || (err instanceof Error ? err.name : String(err));
  return String(raw).replace(/postgres(?:ql)?(?:\+\w+)?:\/\/\S+/gi, '<db-url>').split('\n')[0].slice(0, 80);
}

async function readSchemaVersion(client: { query: (sql: string) => Promise<{ rows: any[] }> }): Promise<string> {
  try {
    const res = await client.query(SCHEMA_SQL);
    return res.rows[0]?.value ?? 'none';
  } catch (err) {
    if ((err as { code?: string })?.code === '42P01') return 'none';
    throw err;
  }
}

/** Read the store once. Hard timeout: `timeoutMs`. Never throws. */
export async function probeMemory(
  runner: PgRunner = withPgClient as unknown as PgRunner,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<MemoryProbe> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<MemoryProbe>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unknown', reason: `timeout after ${timeoutMs} ms` }), timeoutMs);
    timer.unref?.();
  });
  const work = (async (): Promise<MemoryProbe> => {
    try {
      return await runner(async (client) => {
        const row = (await client.query(MAIN_SQL)).rows[0];
        const schema = await readSchemaVersion(client);
        return {
          kind: 'ok' as const,
          database: String(row.db),
          rows: Number(row.rows),
          newest: row.newest ? new Date(row.newest) : null,
          noEmbedding: Number(row.no_emb),
          schema,
        };
      });
    } catch (err) {
      return { kind: 'unknown', reason: shortReason(err) };
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ageText(newest: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - newest.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

function okLine(p: Extract<MemoryProbe, { kind: 'ok' }>, ctx: HealthContext): { text: string; warn: boolean } {
  const mismatch = p.schema !== EXPECTED_SCHEMA_VERSION;
  const schema = mismatch
    ? `schema MISMATCH (found ${p.schema}, expected ${EXPECTED_SCHEMA_VERSION})`
    : `schema ${p.schema}`;
  const age = p.newest ? ageText(p.newest, ctx.now) : 'never';
  let text = `Memory: ${p.rows} lessons, newest ${age}, ${p.noEmbedding} without embeddings, ${schema} (db ${p.database})`;
  const staleDays = p.newest ? Math.floor((ctx.now.getTime() - p.newest.getTime()) / DAY_MS) : 0;
  if (staleDays > STALE_DAYS) text += `, no new lesson in ${staleDays} days`;
  return { text, warn: mismatch };
}

function emptyLine(p: Extract<MemoryProbe, { kind: 'ok' }>, ctx: HealthContext): string {
  let text = 'Memory: EMPTY — archival_memory has 0 rows. Recall returns nothing.';
  if (ctx.restoreCommand) text += ` Restore the newest backup with: ${ctx.restoreCommand}`;
  if (p.schema !== EXPECTED_SCHEMA_VERSION) {
    text += ` schema MISMATCH (found ${p.schema}, expected ${EXPECTED_SCHEMA_VERSION}).`;
  }
  return text;
}

export function formatHealthLine(probe: MemoryProbe, ctx: HealthContext): HealthLine {
  let text: string;
  let warn: boolean;
  if (probe.kind === 'unknown') {
    text = `Memory: UNKNOWN (probe failed: ${probe.reason})`;
    warn = true;
  } else if (probe.rows === 0) {
    text = emptyLine(probe, ctx);
    warn = true;
  } else {
    const ok = okLine(probe, ctx);
    text = ok.text;
    warn = ok.warn;
  }
  if (ctx.failedWrites > 0) {
    const failed = `${ctx.failedWrites} failed memory writes since last session (see ${ctx.failureLogPath})`;
    text += (probe.kind === 'ok' && probe.rows === 0 ? ' ' : ', ') + failed;
    warn = true;
  }
  return { line: text, warn };
}

// ---------------------------------------------------------------------------
// Failed-write log (written by opc/scripts/core/memory_write_log.py)
// ---------------------------------------------------------------------------

export function defaultStateDir(): string {
  return join(homedir(), '.claude', 'state');
}

/** Lines in the failure log with ts newer than the marker. No marker counts every valid line. */
export function countFailedWritesSince(logPath: string, markerPath: string): number {
  let since = 0;
  try {
    const parsed = Date.parse(readFileSync(markerPath, 'utf-8').trim());
    since = Number.isNaN(parsed) ? 0 : parsed;
  } catch { /* no marker yet */ }
  let text: string;
  try {
    text = readFileSync(logPath, 'utf-8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ts = Date.parse(JSON.parse(line).ts);
      if (!Number.isNaN(ts) && ts > since) count += 1;
    } catch { /* malformed line */ }
  }
  return count;
}

/** Record "now" so the next SessionStart counts only newer failures. Never throws. */
export function markSessionStart(markerPath: string, now: Date): void {
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, now.toISOString());
  } catch { /* a missing marker only means the next count starts earlier */ }
}

// ---------------------------------------------------------------------------
// One call for the SessionStart hook
// ---------------------------------------------------------------------------

export interface SessionHealthOptions {
  stateDir?: string;
  opcDir: string | null;
  now?: Date;
  runner?: PgRunner;
  spawnFn?: (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/**
 * Probe, format, update the marker and start a background backup when one is due.
 * Never throws: any failure is the UNKNOWN line.
 */
export async function runSessionHealth(opts: SessionHealthOptions): Promise<HealthLine> {
  try {
    const stateDir = opts.stateDir ?? defaultStateDir();
    const now = opts.now ?? new Date();
    const probe = await probeMemory(opts.runner);
    const logPath = join(stateDir, 'memory-write-failures.jsonl');
    const markerPath = join(stateDir, 'memory-health-last-session');
    const failedWrites = countFailedWritesSince(logPath, markerPath);
    markSessionStart(markerPath, now);
    const newest = newestBackup(stateDir);
    const hasRows = probe.kind === 'ok' && probe.rows > 0;
    if (hasRows && opts.opcDir && needsBackup(newest, now)) spawnBackup(opts.opcDir, opts.spawnFn);
    const restore = newest ? restoreCommand(opts.opcDir, newest.path) : null;
    return formatHealthLine(probe, { now, failedWrites, failureLogPath: logPath, restoreCommand: restore });
  } catch (err) {
    return formatHealthLine({ kind: 'unknown', reason: shortReason(err) }, {
      now: new Date(), failedWrites: 0, failureLogPath: '', restoreCommand: null,
    });
  }
}
