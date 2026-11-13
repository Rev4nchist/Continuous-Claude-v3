/**
 * PostgreSQL database utilities for Claude Code hooks.
 *
 * Migrated from SQLite (db-utils.ts) to PostgreSQL.
 * Uses coordination_pg.py via Python subprocess for queries.
 *
 * Exports:
 * - getPgConnectionString(): Returns PostgreSQL connection string
 * - runPgQuery(): Executes async Python query via coordination_pg
 * - getActiveAgentCountPg(): Returns count of running agents from PostgreSQL
 * - queryBroadcasts(): Query blackboard messages for swarm coordination
 * - queryPipelineArtifacts(): Query pipeline artifacts for upstream context
 */

import type { Client, QueryConfig } from 'pg';
import { spawnSync } from 'child_process';
import type { QueryResult } from './types.js';
import { requireOpcDir } from './opc-path.js';
import { getPgConnectionString, withPgClient, withPgClientOrFallback } from './pg-client.js';
import { recordEventInTransaction } from './coordination-events.js';
import { leaseFor, type LeaseClass } from './leases.js';

// Re-export SAFE_ID_PATTERN and isValidId from pattern-router for convenience
export { SAFE_ID_PATTERN, isValidId } from './pattern-router.js';

// getPgConnectionString now lives in pg-client.ts, which owns the transport, but
// it stays exported from here so existing importers do not have to move.
export { getPgConnectionString };

/**
 * Execute a PostgreSQL query via coordination_pg.py.
 *
 * Uses spawnSync with uv run to execute async Python code.
 * The Python code receives arguments via sys.argv.
 *
 * @param pythonCode - Python code to execute (receives args via sys.argv)
 * @param args - Arguments passed to Python (sys.argv[1], sys.argv[2], ...)
 * @returns QueryResult with success, stdout, and stderr
 */
export function runPgQuery(pythonCode: string, args: string[] = []): QueryResult {
  const connectionString = getPgConnectionString();
  if (!connectionString) {
    return {
      success: false,
      stdout: '',
      stderr: 'database URL unset',
    };
  }
  const opcDir = requireOpcDir();

  // Wrap the Python code to use asyncio.run() for async queries
  const wrappedCode = `
import sys
import os
import asyncio
import json

# Add opc to path for imports
sys.path.insert(0, '${opcDir.replace(/\\/g, '/')}')
os.chdir('${opcDir.replace(/\\/g, '/')}')

# The URL is passed in the spawn environment by the TypeScript caller.
# There is no literal default in this string. If every variable is unset the
# caller does not spawn; an empty pg_url means "do not connect".
pg_url = os.environ.get("CONTINUOUS_CLAUDE_DB_URL") or os.environ.get("DATABASE_URL") or os.environ.get("OPC_POSTGRES_URL") or ""

${pythonCode}
`;

  try {
    const result = spawnSync('uv', ['run', 'python', '-c', wrappedCode, ...args], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      timeout: 3000,  // 3 second timeout (reduced for faster startup)
      cwd: opcDir,
      env: {
        ...process.env,
        CONTINUOUS_CLAUDE_DB_URL: connectionString,
      },
    });

    return {
      success: result.status === 0,
      stdout: result.stdout?.trim() || '',
      stderr: result.stderr || '',
    };
  } catch (err) {
    return {
      success: false,
      stdout: '',
      stderr: String(err),
    };
  }
}

/**
 * Query broadcasts/blackboard messages from PostgreSQL.
 *
 * Queries the blackboard table for messages in a swarm that
 * the current agent hasn't read yet.
 *
 * @param swarmId - Swarm identifier
 * @param agentId - Current agent identifier (to exclude from sender)
 * @param limit - Maximum number of messages to return
 * @returns Array of broadcast messages
 */
export function queryBroadcasts(
  swarmId: string,
  agentId: string,
  limit: number = 10
): { success: boolean; broadcasts: BroadcastMessage[] } {
  const pythonCode = `
from scripts.agentica_patterns.coordination_pg import CoordinationDBPg
import json

swarm_id = sys.argv[1]
agent_id = sys.argv[2]
limit = int(sys.argv[3])

async def main():
    async with CoordinationDBPg() as db:
        # Query blackboard for messages this agent hasn't read
        messages = await db.read_from_blackboard(swarm_id, agent_id)

        # Limit results
        messages = messages[:limit]

        # Convert to JSON-serializable format
        result = []
        for msg in messages:
            result.append({
                'sender': msg.sender_agent,
                'type': msg.message_type,
                'payload': msg.payload,
                'time': msg.created_at.isoformat() if msg.created_at else None
            })

        print(json.dumps(result))

asyncio.run(main())
`;

  const result = runPgQuery(pythonCode, [swarmId, agentId, String(limit)]);

  if (!result.success) {
    return { success: false, broadcasts: [] };
  }

  try {
    const broadcasts = JSON.parse(result.stdout || '[]') as BroadcastMessage[];
    return { success: true, broadcasts };
  } catch {
    return { success: false, broadcasts: [] };
  }
}

/**
 * Query pipeline artifacts from PostgreSQL.
 *
 * Queries the pipeline_artifacts table for artifacts from upstream stages.
 *
 * @param pipelineId - Pipeline identifier
 * @param currentStage - Current stage index (will get artifacts from earlier stages)
 * @returns Array of pipeline artifacts
 */
export function queryPipelineArtifacts(
  pipelineId: string,
  currentStage: number
): { success: boolean; artifacts: PipelineArtifact[] } {
  const pythonCode = `
import asyncpg
import json
import os

pipeline_id = sys.argv[1]
current_stage = int(sys.argv[2])

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Query pipeline artifacts from upstream stages
        rows = await conn.fetch('''
            SELECT stage_index, artifact_type, artifact_path, artifact_content, created_at
            FROM pipeline_artifacts
            WHERE pipeline_id = $1 AND stage_index < $2
            ORDER BY stage_index ASC, created_at DESC
        ''', pipeline_id, current_stage)

        artifacts = []
        for row in rows:
            artifacts.append({
                'stage': row['stage_index'],
                'type': row['artifact_type'],
                'path': row['artifact_path'],
                'content': row['artifact_content'],
                'time': row['created_at'].isoformat() if row['created_at'] else None
            })

        print(json.dumps(artifacts))
    finally:
        await conn.close()

asyncio.run(main())
`;

  const result = runPgQuery(pythonCode, [pipelineId, String(currentStage)]);

  if (!result.success) {
    return { success: false, artifacts: [] };
  }

  try {
    const artifacts = JSON.parse(result.stdout || '[]') as PipelineArtifact[];
    return { success: true, artifacts };
  } catch {
    return { success: false, artifacts: [] };
  }
}

/**
 * Get count of active (running) agents from PostgreSQL.
 *
 * Queries the agents table for agents with status='running'.
 *
 * @returns Number of running agents, or 0 on any error
 */
export function getActiveAgentCountPg(): number {
  const pythonCode = `
from scripts.agentica_patterns.coordination_pg import CoordinationDBPg
import json

async def main():
    async with CoordinationDBPg() as db:
        agents = await db.get_running_agents()
        print(len(agents))

asyncio.run(main())
`;

  const result = runPgQuery(pythonCode);

  if (!result.success) {
    return 0;
  }

  const count = parseInt(result.stdout, 10);
  return isNaN(count) ? 0 : count;
}

/**
 * Register a new agent in PostgreSQL.
 *
 * @param agentId - Unique agent identifier
 * @param sessionId - Session that spawned the agent
 * @param pattern - Coordination pattern (swarm, hierarchical, etc.)
 * @param pid - Process ID for orphan detection
 * @returns Object with success boolean and any error message
 */
export function registerAgentPg(
  agentId: string,
  sessionId: string,
  pattern: string | null = null,
  pid: number | null = null
): { success: boolean; error?: string } {
  const pythonCode = `
from scripts.agentica_patterns.coordination_pg import CoordinationDBPg
import json

agent_id = sys.argv[1]
session_id = sys.argv[2]
pattern = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != 'null' else None
pid = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] != 'null' else None

async def main():
    try:
        async with CoordinationDBPg() as db:
            await db.register_agent(
                agent_id=agent_id,
                session_id=session_id,
                pattern=pattern,
                pid=pid
            )
        print('ok')
    except Exception as e:
        print(f'error: {e}')

asyncio.run(main())
`;

  const args = [
    agentId,
    sessionId,
    pattern || 'null',
    pid !== null ? String(pid) : 'null',
  ];

  const result = runPgQuery(pythonCode, args);

  if (!result.success || result.stdout !== 'ok') {
    return {
      success: false,
      error: result.stderr || result.stdout || 'Unknown error',
    };
  }

  return { success: true };
}

/**
 * Mark an agent as completed in PostgreSQL.
 *
 * @param agentId - Agent identifier to complete
 * @param status - Final status ('completed' or 'failed')
 * @param errorMessage - Optional error message for failed status
 * @returns Object with success boolean and any error message
 */
export function completeAgentPg(
  agentId: string,
  status: string = 'completed',
  errorMessage: string | null = null
): { success: boolean; error?: string } {
  const pythonCode = `
from scripts.agentica_patterns.coordination_pg import CoordinationDBPg
import json

agent_id = sys.argv[1]
status = sys.argv[2]
error_message = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != 'null' else None

async def main():
    try:
        async with CoordinationDBPg() as db:
            await db.complete_agent(
                agent_id=agent_id,
                status=status,
                result_summary=error_message
            )
        print('ok')
    except Exception as e:
        print(f'error: {e}')

asyncio.run(main())
`;

  const args = [
    agentId,
    status,
    errorMessage || 'null',
  ];

  const result = runPgQuery(pythonCode, args);

  if (!result.success || result.stdout !== 'ok') {
    return {
      success: false,
      error: result.stderr || result.stdout || 'Unknown error',
    };
  }

  return { success: true };
}

// Type definitions for broadcast messages
export interface BroadcastMessage {
  sender: string;
  type: string;
  payload: Record<string, unknown>;
  time: string | null;
}

// Type definitions for pipeline artifacts
export interface PipelineArtifact {
  stage: number;
  type: string;
  path: string | null;
  content: string | null;
  time: string | null;
}

// =============================================================================
// COORDINATION LAYER: Session Registration
// =============================================================================

/**
 * Register a session in the coordination layer.
 *
 * @param sessionId - Unique session identifier
 * @param project - Project directory path
 * @param workingOn - Description of current task
 * @param opts - When set, run one SELECT on the same client for the automatic-name pick (see below)
 * @returns Object with success boolean, any error message, and the live-session snapshot when asked for
 */
export async function registerSession(
  sessionId: string,
  project: string,
  workingOn: string = '',
  opts?: { previousId?: string | null }
): Promise<{ success: boolean; error?: string; live?: LiveSession[] }> {
  try {
    let live: LiveSession[] | undefined;
    await withPgClient(async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          working_on TEXT,
          started_at TIMESTAMP DEFAULT NOW(),
          last_heartbeat TIMESTAMP DEFAULT NOW()
        )
      `);

      await client.query(
        `INSERT INTO sessions (id, project, working_on, started_at, last_heartbeat)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
             working_on = EXCLUDED.working_on,
             last_heartbeat = NOW()`,
        [sessionId, project, workingOn]
      );

      if (opts) live = await selectLiveSessions(client, sessionId, opts.previousId ?? null);
    });
    return live ? { success: true, live } : { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** One other session, for the automatic-name pick. `alive`: active in the last 5 minutes (STALE_MINUTES). */
export interface LiveSession {
  id: string;
  alive: boolean;
}

/** The query cap for the live-session SELECT. The whole SessionStart hook has a 10 s budget. */
const LIVE_SELECT_TIMEOUT_MS = 1500;

/**
 * Sessions seen in the last 2 hours (the `say --to` window), plus the fork parent whatever its age.
 * Same liveness predicate as everywhere else: GREATEST(last_heartbeat, last_activity_at).
 * A failed or slow SELECT returns undefined: the caller falls back to the identity folder.
 * It never makes the registration itself fail.
 */
async function selectLiveSessions(
  client: Client,
  selfId: string,
  previousId: string | null
): Promise<LiveSession[] | undefined> {
  try {
    // pg reads a per-query query_timeout; its QueryConfig type does not list it.
    const config: QueryConfig & { query_timeout: number } = {
      text: `SELECT id,
                    GREATEST(last_heartbeat, last_activity_at) > now() - interval '5 minutes' AS alive
               FROM sessions
              WHERE id <> $1
                AND (GREATEST(last_heartbeat, last_activity_at) > now() - interval '2 hours' OR id = $2::text)
              LIMIT 500`,
      values: [selfId, previousId],
      query_timeout: LIVE_SELECT_TIMEOUT_MS,
    };
    const res = await client.query(config);
    return res.rows.map((r: { id: string; alive: boolean }) => ({ id: r.id, alive: r.alive === true }));
  } catch {
    return undefined;
  }
}

/**
 * Get active sessions from the coordination layer.
 *
 * @param project - Optional project filter
 * @returns Array of active sessions
 */
export async function getActiveSessions(project?: string): Promise<{
  success: boolean;
  sessions: SessionInfo[];
}> {
  // The cutoff is computed by the DATABASE rather than by the hook process. The
  // Python version subtracted from datetime.utcnow() and compared against a
  // `timestamp without time zone` column written by NOW(); that is only correct
  // while the container's TimeZone is UTC. It is (verified 2026-07-26:
  // current_setting('TimeZone') = Etc/UTC), so this was NOT a live bug -- but it
  // was a correct answer resting on an unstated assumption, and NOW() - INTERVAL
  // inside the query removes the assumption entirely.
  const { value, degraded } = await withPgClientOrFallback(
    async (client) => {
      // Same AT TIME ZONE 'UTC' cast as RESOLVE_CLAIM_SQL, for the same reason:
      // these are `timestamp without time zone` holding UTC, and node-postgres
      // parses that type as LOCAL, so an uncast value came back five hours in
      // the future and .toISOString() then stamped a Z on the wrong instant.
      // No live caller renders these two fields today, but SessionInfo is an
      // exported shape and the next board that consumes it would inherit the
      // future-dated display that has already shipped twice.
      const sql = `
        SELECT id, project, working_on,
               started_at     AT TIME ZONE 'UTC' AS started_at,
               last_heartbeat AT TIME ZONE 'UTC' AS last_heartbeat
        FROM sessions
        WHERE GREATEST(last_heartbeat, last_activity_at) > NOW() - INTERVAL '5 minutes'
        ${project ? 'AND project = $1' : ''}
        ORDER BY started_at DESC
      `;
      const res = await client.query(sql, project ? [project] : []);
      return res.rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        project: row.project as string,
        working_on: row.working_on as string,
        started_at: row.started_at ? (row.started_at as Date).toISOString() : null,
        last_heartbeat: row.last_heartbeat ? (row.last_heartbeat as Date).toISOString() : null,
      }));
    },
    [] as SessionInfo[],
    'getActiveSessions'
  );

  return { success: !degraded, sessions: value };
}

/**
 * Check if a session is still active (heartbeat within threshold).
 *
 * @param sessionId - Session ID to check
 * @param thresholdMs - Maximum age of heartbeat in milliseconds (default 5 min)
 * @returns true if session is active, false if stale or not found
 */
export async function isSessionActive(
  sessionId: string,
  thresholdMs: number = 5 * 60 * 1000
): Promise<boolean> {
  const thresholdSeconds = Math.floor(thresholdMs / 1000);

  // Liveness is decided entirely inside the query, against the same clock that
  // wrote the columns -- no client-side subtraction, no timezone assumption.
  //
  // GREATEST(last_heartbeat, last_activity_at), not bare last_heartbeat: the
  // heartbeat is written on UserPromptSubmit ONLY, so it measures the HUMAN
  // typing, not the agent working. Measured peak staleness during a 12-agent
  // workflow: 505s, while the session was continuously editing. Keying liveness
  // on the heartbeat alone classifies a working session as dead. GREATEST
  // ignores NULLs and returns NULL only when EVERY argument is NULL, so rows
  // predating the last_activity_at writer reduce exactly to the old behaviour.
  const { value } = await withPgClientOrFallback(
    async (client) => {
      const res = await client.query(
        `SELECT GREATEST(last_heartbeat, last_activity_at) >= NOW() - make_interval(secs => $2) AS active
         FROM sessions WHERE id = $1`,
        [sessionId, thresholdSeconds]
      );
      return res.rows.length > 0 && res.rows[0].active === true;
    },
    false,
    `isSessionActive(${sessionId})`
  );

  return value;
}

// =============================================================================
// COORDINATION LAYER: File Claims
// =============================================================================

/**
 * Check if a file is claimed by another session.
 *
 * @param filePath - Path to the file
 * @param project - Project directory
 * @param mySessionId - Current session ID
 * @returns Claim info if claimed by another session
 */
export async function checkFileClaim(
  filePath: string,
  project: string,
  mySessionId: string
): Promise<{ claimed: boolean; claimedBy?: string; claimedAt?: string; degraded?: boolean }> {
  // `degraded` distinguishes "nobody holds this file" from "we could not find
  // out". Both still permit the edit -- a stopped Postgres container must not
  // make the machine unable to work -- but only one of them is a real answer,
  // and the caller says so out loud instead of permitting silently.
  const { value, degraded } = await withPgClientOrFallback(
    async (client) => {
      // This is the only place that creates file_claims, so it has to create
      // the CURRENT shape. It used to declare the four pre-lease columns, which
      // meant that on any database where migration 001 had not been applied by
      // hand -- a fresh machine following BOOTSTRAP.md, a rebuilt container, a
      // restored dump -- the table came into existence WITHOUT expires_at,
      // fence or lease_class. Every RESOLVE_CLAIM_SQL then failed on a missing
      // column, degraded, and permitted every edit while reporting the DB as
      // unreachable. A guard that silently does not fire, diagnosed as the
      // wrong thing: the exact shape this codebase has shipped three times.
      await client.query(`CREATE SEQUENCE IF NOT EXISTS coordination_fence_seq AS BIGINT`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS file_claims (
          file_path TEXT,
          project TEXT,
          session_id TEXT,
          claimed_at TIMESTAMP DEFAULT NOW(),
          expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '10 minutes',
          fence BIGINT DEFAULT nextval('coordination_fence_seq'),
          lease_class TEXT DEFAULT 'file',
          PRIMARY KEY (file_path, project)
        )
      `);

      const res = await client.query(
        // AT TIME ZONE 'UTC' for the same reason as everywhere else in this
        // file: without it claimedAt is reported five hours in the future,
        // which reads as a corrupt row rather than as a timezone bug.
        `SELECT session_id, claimed_at AT TIME ZONE 'UTC' AS claimed_at
           FROM file_claims
         WHERE file_path = $1 AND project = $2 AND session_id <> $3`,
        [filePath, project, mySessionId]
      );

      if (res.rows.length === 0) return { claimed: false as const };

      const row = res.rows[0];
      return {
        claimed: true as const,
        claimedBy: row.session_id as string,
        claimedAt: row.claimed_at ? (row.claimed_at as Date).toISOString() : undefined,
      };
    },
    { claimed: false as const },
    `checkFileClaim(${filePath})`
  );

  return degraded ? { ...value, degraded: true } : value;
}

/**
 * The claim decision, in one statement, with its conflict event.
 *
 * WHAT THIS REPLACES
 * ------------------
 * checkFileClaim -> isSessionActive -> claimFile: three round trips with two
 * races in the gaps.
 *
 *   1. Two sessions both see an UNCLAIMED file and both write. ON CONFLICT DO
 *      UPDATE made the last writer win silently, and BOTH were told to go
 *      ahead. The load probe never caught this because it always starts from a
 *      file that is already held.
 *   2. The holder's liveness was read after the claim row, so the answer could
 *      already be stale when it was used.
 *
 * One `INSERT ... ON CONFLICT DO UPDATE ... WHERE` closes both. It takes a row
 * lock and re-evaluates its WHERE against the LATEST committed row rather than
 * the statement snapshot, so concurrent callers serialize on the conflicting
 * row. **Zero rows returned means somebody else holds it.**
 *
 * Verified by scripts/coordination/claim-sql-probe.mjs, whose case 5 races 24
 * live sessions for one unclaimed file: exactly 1 granted, 23 blocked.
 *
 * WHY THE EVENT IS WRITTEN HERE
 * -----------------------------
 * This is the only place that knows a conflict occurred, and it already owns a
 * transaction. Writing the event anywhere else would mean it could disagree
 * with the decision. Only conflicts and degradations are recorded — never the
 * ordinary grant, which would be one row per Edit and would recreate exactly
 * the unbounded accumulation that left file_claims with 8,170 dead rows.
 */
export type ClaimOutcome = 'granted' | 'renewed' | 'takeover' | 'blocked' | 'degraded';

export interface ClaimDecision {
  outcome: ClaimOutcome;
  /** Who held the claim before this attempt. Set for blocked and takeover. */
  holder?: string;
  /** When they last touched it, ISO. */
  holderClaimedAt?: string;
  /** When the holder's lease runs out, ISO. Set for blocked — it is the answer
   *  to "how long do I have to wait?", which the old message could not give. */
  holderExpiresAt?: string;
  /** The lease generation now in force. See the fence note below. */
  fence?: number;
  /** The generation this replaced, when custody changed hands. */
  priorFence?: number;
  /** The lease class applied to this path. */
  leaseClass?: LeaseClass;
  /** Was the holder's lease already expired? One half of the reclamation rule. */
  leaseExpired?: boolean;
  /** Had the holder stopped heartbeating? The other half. */
  holderStale?: boolean;
  /** True when the takeover happened only because break-glass was set. */
  breakGlass?: boolean;
  /** False when the conflict happened but could not be written down. */
  eventRecorded?: boolean;
}

/**
 * RECLAMATION REQUIRES BOTH CONDITIONS.
 *
 * `file_claims.expires_at < NOW()` **AND** the holder's session heartbeat stale.
 * Either one alone is what produced the original false positives:
 *
 *   - Heartbeat alone (what this used to do): heartbeat only refreshed on
 *     UserPromptSubmit, so a session went "stale" during any long agent turn and
 *     its own claims became reclaimable WHILE it was actively editing. Measured
 *     at 652s mid-work on 2026-07-26.
 *   - Expiry alone: a file lease is 10 minutes but the interval it protects is a
 *     human reading and thinking, so the lease can lapse while somebody is
 *     simply looking at the file.
 *
 * Requiring both means a preemption needs the holder to be BOTH out of lease AND
 * showing no sign of life. This is strictly more conservative than the previous
 * behaviour — a file whose holder is stale but whose lease is still live now
 * BLOCKS where it used to be taken over.
 *
 * THE FENCE
 * ---------
 * A lease generation, minted on every change of custody and preserved across
 * renewals. Be precise about what it is not: it is NOT a Kleppmann fencing
 * token, because there is no mediated resource that could reject a stale one —
 * nothing can stop a process writing to the filesystem with an out-of-date
 * number. It buys detection and evidence: a monotonic, globally unique id for
 * "this particular grant", so an event row is unambiguous on its own.
 *
 * It is monotonic but NOT contiguous. Postgres evaluates the VALUES list —
 * including nextval() — before it detects the conflict, so every renewal and
 * every blocked attempt burns a sequence value it does not use. Gaps are
 * expected; ordering is the only property relied on.
 *
 * THE SNAPSHOT TRAP (found by adversarial review, then reproduced)
 * ---------------------------------------------------------------
 * `prior` and `upsert` are CTEs of ONE statement, so they share the statement
 * snapshot — but the ON CONFLICT WHERE does NOT. It re-reads the latest
 * committed row, which is exactly what makes the serialization work. The two
 * therefore disagree under precisely the contention this design exists for.
 *
 * Measured: 24 sessions racing for one UNCLAIMED file. All 24 snapshot an empty
 * table, so `prior` is empty for every one of them. One wins; the other 23 wait
 * on its speculative tuple, then correctly block against its committed row — and
 * report prior_owner = NULL. The deny message rendered "held by session
 * undefined" and the event stored NULL for holder, leaseExpired and holderStale:
 * the three fields it exists to record, absent in the only case that matters.
 *
 * So `prior` is used ONLY as a fast path. When it is empty but the statement
 * demonstrably contended, the facts are re-read below in a SECOND statement,
 * which under READ COMMITTED takes a fresh snapshot and sees the winner.
 */
const RESOLVE_CLAIM_SQL = `
WITH prior AS (
  SELECT session_id, claimed_at, expires_at, fence
  FROM file_claims
  WHERE file_path = $1 AND project = $2
),
upsert AS (
  INSERT INTO file_claims
    (file_path, project, session_id, claimed_at, expires_at, fence, lease_class)
  VALUES
    ($1, $2, $3, NOW(), NOW() + make_interval(secs => $5),
     nextval('coordination_fence_seq'), $6)
  ON CONFLICT (file_path, project) DO UPDATE
    SET session_id  = EXCLUDED.session_id,
        claimed_at  = NOW(),
        expires_at  = NOW() + make_interval(secs => $5),
        lease_class = EXCLUDED.lease_class,
        -- A renewal is the SAME lease, so it keeps its generation. Only a
        -- change of custody advances it.
        fence = CASE WHEN file_claims.session_id = EXCLUDED.session_id
                     THEN file_claims.fence
                     ELSE EXCLUDED.fence
                END
    WHERE file_claims.session_id = EXCLUDED.session_id
       OR $7::boolean
       OR (
            -- A row with no lease at all is treated as EXPIRED, not as
            -- infinite. NULL < NOW() is NULL, which would make the whole OR
            -- branch unknown and leave that file blocked FOREVER -- no
            -- heartbeat, no expiry and no release could ever free it. Every
            -- writer sets the column today (it has a DEFAULT), so this is
            -- unreachable in principle; it is here because "unreachable" and
            -- "permanently wedged if reached" is a bad pair. Degrading to the
            -- heartbeat-only rule is the safe direction.
            (file_claims.expires_at IS NULL OR file_claims.expires_at < NOW())
            AND NOT EXISTS (
              SELECT 1 FROM sessions s
              WHERE s.id = file_claims.session_id
                AND GREATEST(s.last_heartbeat, s.last_activity_at) >= NOW() - make_interval(secs => $4)
            )
          )
  -- xmax <> 0 is the standard idiom for "this row came from the ON CONFLICT
  -- branch, not the INSERT branch". It is load-bearing: under contention the
  -- prior CTE can be EMPTY for a row that nonetheless already existed by the
  -- time the upsert ran (see the snapshot note above), and without this the
  -- classifier reads prior_owner = NULL and calls a genuine change of custody a
  -- first-time grant.
  --
  -- (No backticks in this comment. It lives inside a TS template literal, so an
  -- unescaped one silently truncates the statement -- which is exactly what
  -- happened here: tsc reported TS1005, esbuild swallowed it and emitted
  -- something that worked by luck, and claim-sql-probe's extractor stopped
  -- mid-sentence and handed Postgres a fragment.)
  RETURNING session_id, fence, (xmax <> 0) AS was_update
)
SELECT (SELECT session_id FROM upsert) AS new_owner,
       (SELECT fence      FROM upsert) AS new_fence,
       (SELECT was_update FROM upsert) AS was_update,
       (SELECT session_id FROM prior)  AS prior_owner,
       (SELECT fence      FROM prior)  AS prior_fence,

       -- AT TIME ZONE 'UTC' is not cosmetic. These columns are
       -- \`timestamp without time zone\` holding UTC values, and node-postgres
       -- parses that type by interpreting it as LOCAL time -- so on this machine
       -- (UTC-5) a raw Date came back five hours wrong, and .toISOString() then
       -- printed that wrong instant with a Z on it. The cast produces a real
       -- timestamptz, which the driver reads correctly. The same confusion put a
       -- future date on the lane board on 2026-07-26.
       (SELECT claimed_at AT TIME ZONE 'UTC' FROM prior) AS prior_claimed_at,
       (SELECT expires_at AT TIME ZONE 'UTC' FROM prior) AS prior_expires_at,

       -- The two halves of the reclamation rule, evaluated by the DATABASE
       -- against its own clock. Returned separately so the caller can say WHICH
       -- condition held without re-deriving it client-side against a different
       -- clock -- and so a break-glass override can be identified as an override
       -- rather than inferred.
       (SELECT expires_at IS NULL OR expires_at < NOW() FROM prior) AS prior_lease_expired,
       (SELECT NOT EXISTS (
          SELECT 1 FROM sessions s
          WHERE s.id = prior.session_id
            AND GREATEST(s.last_heartbeat, s.last_activity_at) >= NOW() - make_interval(secs => $4)
        ) FROM prior) AS prior_holder_stale
`;

export async function resolveFileClaim(
  filePath: string,
  project: string,
  sessionId: string,
  staleThresholdMs: number,
  toolName: string,
  options: { breakGlass?: boolean } = {},
): Promise<ClaimDecision> {
  const staleSeconds = Math.floor(staleThresholdMs / 1000);
  const { leaseClass, ttlMs } = leaseFor(filePath);
  const ttlSeconds = Math.floor(ttlMs / 1000);
  const breakGlass = options.breakGlass === true;

  const { value, degraded } = await withPgClientOrFallback<ClaimDecision | null>(
    async (client) => {
      await client.query('BEGIN');
      try {
        const res = await client.query(RESOLVE_CLAIM_SQL, [
          filePath, project, sessionId, staleSeconds, ttlSeconds, leaseClass, breakGlass,
        ]);
        const row = res.rows[0] as {
          new_owner: string | null;
          new_fence: string | number | null;
          was_update: boolean | null;
          prior_owner: string | null;
          prior_claimed_at: Date | null;
          prior_expires_at: Date | null;
          prior_fence: string | number | null;
          prior_lease_expired: boolean | null;
          prior_holder_stale: boolean | null;
        };

        // Did this statement contend with a row our snapshot could not see?
        // Either we were blocked (somebody holds it, but `prior` is empty), or
        // we won via the UPDATE branch against a row that was not in our
        // snapshot. Both mean prior_* is missing rather than genuinely absent.
        const contendedUnseen =
          row.prior_owner === null &&
          (row.new_owner === null || row.was_update === true);

        let facts = {
          owner: row.prior_owner,
          claimedAt: row.prior_claimed_at,
          expiresAt: row.prior_expires_at,
          fence: row.prior_fence,
          leaseExpired: row.prior_lease_expired,
          holderStale: row.prior_holder_stale,
        };

        // A SEPARATE statement, so under READ COMMITTED it takes a fresh
        // snapshot and sees whatever committed while we were waiting. Only runs
        // on the contended path, which is rare -- the ordinary claim still costs
        // exactly one round trip.
        //
        // Honest about what this is: for a BLOCKED caller it is the true current
        // holder. For a caller that WON against an unseen row, the row now holds
        // us, so the displaced holder is genuinely unrecoverable -- we record
        // that we cannot name them rather than reporting nobody was there.
        if (contendedUnseen && row.new_owner === null) {
          const again = await client.query(
            `SELECT session_id,
                    claimed_at AT TIME ZONE 'UTC' AS claimed_at,
                    expires_at AT TIME ZONE 'UTC' AS expires_at,
                    fence,
                    (expires_at IS NULL OR expires_at < NOW()) AS lease_expired,
                    NOT EXISTS (
                      SELECT 1 FROM sessions s
                      WHERE s.id = file_claims.session_id
                        AND GREATEST(s.last_heartbeat, s.last_activity_at) >= NOW() - make_interval(secs => $3)
                    ) AS holder_stale
               FROM file_claims
              WHERE file_path = $1 AND project = $2`,
            [filePath, project, staleSeconds],
          );
          if (again.rows.length > 0) {
            const r = again.rows[0];
            facts = {
              owner: r.session_id,
              claimedAt: r.claimed_at,
              expiresAt: r.expires_at,
              fence: r.fence,
              leaseExpired: r.lease_expired,
              holderStale: r.holder_stale,
            };
          }
        }

        const holder = facts.owner ?? undefined;
        const holderClaimedAt = facts.claimedAt ? facts.claimedAt.toISOString() : undefined;
        const holderExpiresAt = facts.expiresAt ? facts.expiresAt.toISOString() : undefined;

        // node-postgres returns BIGINT as a string to avoid silently losing
        // precision past 2^53. These counters will never come close, but the
        // conversion is explicit so the value is a number everywhere above.
        const num = (v: string | number | null) =>
          v === null || v === undefined ? undefined : Number(v);

        // Classification keys off was_update, NOT off prior_owner alone. A row
        // that already existed but was invisible to our snapshot used to be
        // classified `granted` -- which writes no event and prints no warning,
        // so a break-glass override that displaced a live holder left no mark at
        // all. Reproduced 2 times in 12 randomized trials before this fix.
        let outcome: ClaimOutcome;
        if (row.new_owner === null) outcome = 'blocked';
        else if (row.was_update !== true) outcome = 'granted';
        else if (facts.owner === sessionId) outcome = 'renewed';
        else outcome = 'takeover';

        // We changed custody away from somebody we could not name.
        const priorHolderUnobservable =
          outcome === 'takeover' && facts.owner === null;

        // A takeover the two-condition rule would NOT have permitted, which
        // happened only because break-glass was set. Both halves come from the
        // database's own clock -- never re-derived here, where the timezone
        // would be wrong. Recorded so an override is never silent: the whole
        // point of a break-glass is that pulling it leaves a mark.
        const wouldHaveReclaimed =
          facts.leaseExpired === true && facts.holderStale === true;
        const forced = outcome === 'takeover' && breakGlass && !wouldHaveReclaimed;

        // Running this hook at all proves the session is alive, so renew its
        // heartbeat even when it was blocked. Without this the lock is only
        // real for ~5 minutes after each user message -- heartbeat otherwise
        // fires on UserPromptSubmit alone, so during a long agent turn a
        // session goes stale and its own claims become reclaimable WHILE it is
        // actively editing (measured 652s mid-work, 2026-07-26). Upsert rather
        // than UPDATE: a session whose SessionStart never ran would otherwise
        // hold claims with no sessions row at all.
        await client.query(
          `INSERT INTO sessions (id, project, last_heartbeat)
           VALUES ($1, $2, NOW())
           ON CONFLICT (id) DO UPDATE SET last_heartbeat = NOW()`,
          [sessionId, project],
        );

        let eventRecorded: boolean | undefined;
        if (outcome === 'blocked' || outcome === 'takeover') {
          eventRecorded = await recordEventInTransaction(client, {
            kind: forced
              ? 'claim_break_glass'
              : outcome === 'blocked'
                ? 'claim_blocked'
                : 'claim_takeover',
            sessionId,
            project,
            filePath,
            holderSessionId: holder ?? null,
            toolName,
            detail: {
              holderClaimedAt: holderClaimedAt ?? null,
              holderExpiresAt: holderExpiresAt ?? null,
              // Which half of the rule held. A block with leaseExpired=true and
              // holderStale=false is the NEW behaviour doing its job (an idle
              // but alive holder); the old code would have preempted them here.
              leaseExpired: facts.leaseExpired,
              holderStale: facts.holderStale,
              leaseClass,
              leaseTtlSeconds: ttlSeconds,
              fenceFrom: num(facts.fence) ?? null,
              fenceTo: num(row.new_fence) ?? null,
              staleThresholdSeconds: staleSeconds,
              // True when custody changed away from a holder this statement
              // could not observe. Says "we could not name them" rather than
              // letting a null holder read as "nobody was there".
              priorHolderUnobservable: priorHolderUnobservable || undefined,
              // True when the holder facts came from the follow-up read rather
              // than the statement's own snapshot -- a post-image, not the true
              // pre-image at decision time.
              holderReadAfterContention: contendedUnseen || undefined,
            },
          });
        }

        await client.query('COMMIT');
        return {
          outcome,
          holder,
          holderClaimedAt,
          holderExpiresAt,
          fence: num(row.new_fence),
          priorFence: num(facts.fence),
          leaseClass,
          leaseExpired: facts.leaseExpired ?? undefined,
          holderStale: facts.holderStale ?? undefined,
          breakGlass: forced ? true : undefined,
          eventRecorded,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* connection already gone */ });
        throw err;
      }
    },
    null,
    `resolveFileClaim(${filePath})`,
  );

  if (degraded || value === null) return { outcome: 'degraded' };
  return value;
}

/**
 * Give back every claim this session holds.
 *
 * WHY THIS HAD TO EXIST BEFORE LEASES COULD
 * -----------------------------------------
 * Nothing has ever released a file claim on this machine. Claims were only ever
 * written, and the only thing that removed one was a manual run of
 * cleanup_sessions.py with a 24-hour cutoff — which is how file_claims reached
 * 8,170 rows of which zero were live-owned.
 *
 * That was survivable while reclamation needed only a stale heartbeat: an
 * abandoned claim became reclaimable five minutes later. It is NOT survivable
 * now. Reclamation requires the lease to expire too, so an abandoned claim on a
 * harness file is genuinely held for a full hour. Making leases longer without
 * making them releasable would have converted a rare annoyance into a routine
 * one, so this ships in the same change.
 *
 * Deleted by session_id ALONE, not (session_id, project): a session's claims are
 * its own wherever it filed them, and scoping by the cwd at exit would silently
 * strand claims made from a different directory earlier in the session.
 */
export async function releaseSessionClaims(
  sessionId: string,
  reason: string,
): Promise<{ released: number; files: string[]; degraded: boolean }> {
  const { value, degraded } = await withPgClientOrFallback(
    async (client) => {
      await client.query('BEGIN');
      try {
        const res = await client.query(
          `DELETE FROM file_claims WHERE session_id = $1
           RETURNING file_path, lease_class`,
          [sessionId],
        );

        const files = res.rows.map((r: Record<string, unknown>) => r.file_path as string);

        // Silence when there was nothing to release. A row per session exit
        // regardless of whether anything happened is the same unbounded-growth
        // mistake as a row per Edit, one level up.
        if (files.length > 0) {
          await recordEventInTransaction(client, {
            kind: 'claim_released',
            sessionId,
            detail: {
              reason,
              count: files.length,
              // Capped so one session that touched a thousand files cannot put
              // a megabyte of jsonb in an event row. The count above is exact
              // either way.
              files: files.slice(0, 50),
              truncated: files.length > 50,
            },
          });
        }

        await client.query('COMMIT');
        return files;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* connection already gone */ });
        throw err;
      }
    },
    [] as string[],
    `releaseSessionClaims(${sessionId})`,
  );

  return { released: value.length, files: value, degraded };
}

/**
 * Record that a session ENDED, and Claude Code's own word for why.
 *
 * WHY THIS EXISTS
 * ---------------
 * `sessions` recorded four kinds of beginning-or-middle (started_at,
 * last_heartbeat, last_activity_at, memory_extracted_at) and no kind of end.
 * Liveness was therefore inferred ENTIRELY from a read-side window: a terminal
 * you closed deliberately read "active" for up to fifteen minutes, and a session
 * that crashed was indistinguishable from one that exited cleanly — permanently,
 * not just for those fifteen minutes.
 *
 * coordination-release.ts has received Claude Code's `reason` string on every
 * SessionEnd since leases landed and passed it only into a `claim_released`
 * event, which is not queryable as session state and does not exist at all when
 * the session happened to hold no claims.
 *
 * WHAT NULL MEANS (the part that must not be got wrong downstream)
 * ---------------------------------------------------------------
 * A written `ended_at` is a POSITIVE signal and is trustworthy. Its ABSENCE is
 * UNKNOWN, never "crashed": the session may still be running, or the process may
 * have been killed outright so no SessionEnd ever fired — the lease expiry
 * remains the backstop for that case, which is why the backstop still exists —
 * or the row may simply predate this writer, which was true of all 2,453 rows
 * the day it shipped.
 *
 * WHY UPDATE-ONLY (never INSERT)
 * ------------------------------
 * Same rule as shared/session-touch.ts: row creation belongs to
 * session-register.ts / heartbeat.ts, which own `project` and its canonical-path
 * normalization. A second module with its own opinion about project spelling is
 * how the 115-alias mess was made. An UPDATE against an id that never registered
 * is a harmless zero-row no-op, which is the right outcome for a session the
 * coordination layer never knew about.
 *
 * WHY NOTHING HAS TO CLEAR IT ON RESUME
 * -------------------------------------
 * `claude --resume` re-registers the same id, and hooks can race. Readers
 * therefore define "ended" RELATIVELY —
 *   `ended_at IS NOT NULL AND ended_at >= GREATEST(last_heartbeat, last_activity_at)`
 * — so any later sign of life un-ends the session on its own. No clearing write,
 * no ordering requirement between hooks, and session-register/heartbeat stay
 * untouched. Do not "fix" this by adding a clearing UPDATE somewhere.
 *
 * NOW() is evaluated by the DATABASE. `ended_at` is `timestamp without time
 * zone` holding UTC; computing it in this process would reintroduce the exact
 * client-side timezone assumption the rest of this file was corrected to remove.
 */
export async function markSessionEnded(
  sessionId: string,
  reason: string,
): Promise<{ recorded: boolean; degraded: boolean }> {
  if (!sessionId || sessionId === 'unknown') return { recorded: false, degraded: false };

  const { value, degraded } = await withPgClientOrFallback(
    async (client) => {
      const res = await client.query(
        `UPDATE sessions SET ended_at = NOW(), end_reason = $2 WHERE id = $1`,
        [sessionId, reason],
      );
      return res.rowCount ?? 0;
    },
    0,
    `markSessionEnded(${sessionId})`,
  );

  return { recorded: value > 0, degraded };
}

/**
 * Claim a file for the current session.
 *
 * Superseded on the hook path by resolveFileClaim, which decides and claims in
 * one statement. Retained because it is a stable exported surface with tests
 * against it, and because a plain unconditional claim is still the right
 * primitive for callers that have already made their decision.
 *
 * @param filePath - Path to the file
 * @param project - Project directory
 * @param sessionId - Session claiming the file
 */
export async function claimFile(
  filePath: string,
  project: string,
  sessionId: string
): Promise<{ success: boolean }> {
  const { value } = await withPgClientOrFallback(
    async (client) => {
      await client.query('BEGIN');
      try {
        // The lease columns are set on BOTH branches, and the update branch is
        // the one that matters. Column DEFAULTs apply only to an INSERT, never
        // to ON CONFLICT DO UPDATE -- so a version of this that named them
        // nowhere left a change of custody carrying the PREVIOUS holder's
        // lease: an already-lapsed expiry (a claim expired at birth), or an
        // inherited 60-minute harness lease on an ordinary file. leaseFor() was
        // never consulted on this path at all, so even the insert misclassified
        // harness paths as 10-minute file leases.
        const { leaseClass, ttlMs } = leaseFor(filePath);
        await client.query(
          `INSERT INTO file_claims
             (file_path, project, session_id, claimed_at, expires_at, fence, lease_class)
           VALUES ($1, $2, $3, NOW(), NOW() + make_interval(secs => $4),
                   nextval('coordination_fence_seq'), $5)
           ON CONFLICT (file_path, project) DO UPDATE SET
               session_id  = EXCLUDED.session_id,
               claimed_at  = NOW(),
               expires_at  = EXCLUDED.expires_at,
               lease_class = EXCLUDED.lease_class,
               fence = CASE WHEN file_claims.session_id = EXCLUDED.session_id
                            THEN file_claims.fence
                            ELSE EXCLUDED.fence
                       END`,
          [filePath, project, sessionId, Math.floor(ttlMs / 1000), leaseClass]
        );

        // Claiming a file IS activity, so it renews the owner's heartbeat.
        // Without this the lock is only real for ~5 minutes after each user
        // message: heartbeat fires on UserPromptSubmit alone, so during a long
        // agent turn the session goes stale and its claims become reclaimable
        // WHILE it is actively editing. Measured 2026-07-26 -- 652s since the
        // last prompt, mid-work, claims already reclaimable. Same transaction as
        // the claim, so there is no window where a claim exists whose owner
        // looks dead. Upsert rather than UPDATE: a session whose SessionStart
        // never ran would otherwise hold claims with no sessions row at all.
        await client.query(
          `INSERT INTO sessions (id, project, last_heartbeat)
           VALUES ($1, $2, NOW())
           ON CONFLICT (id) DO UPDATE SET last_heartbeat = NOW()`,
          [sessionId, project]
        );

        await client.query('COMMIT');
        return true;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* connection already gone */ });
        throw err;
      }
    },
    false,
    `claimFile(${filePath})`
  );

  return { success: value };
}

// =============================================================================
// COORDINATION LAYER: Findings
// =============================================================================

/**
 * Broadcast a finding to the coordination layer.
 *
 * @param sessionId - Session that discovered the finding
 * @param topic - Topic/category of the finding
 * @param finding - The finding content
 * @param relevantTo - Array of files/topics this is relevant to
 */
export function broadcastFinding(
  sessionId: string,
  topic: string,
  finding: string,
  relevantTo: string[] = []
): { success: boolean } {
  const pythonCode = `
import asyncpg
import os
import json

session_id = sys.argv[1]
topic = sys.argv[2]
finding = sys.argv[3]
relevant_to = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Create table if not exists
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS findings (
                id SERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                topic TEXT NOT NULL,
                finding TEXT NOT NULL,
                relevant_to TEXT[],
                created_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        await conn.execute('''
            INSERT INTO findings (session_id, topic, finding, relevant_to)
            VALUES ($1, $2, $3, $4)
        ''', session_id, topic, finding, relevant_to)
        print('ok')
    finally:
        await conn.close()

asyncio.run(main())
`;

  const result = runPgQuery(pythonCode, [
    sessionId,
    topic,
    finding,
    JSON.stringify(relevantTo),
  ]);
  return { success: result.success && result.stdout === 'ok' };
}

/**
 * Get relevant findings for a topic or file.
 *
 * @param query - Topic or file path to search for
 * @param excludeSessionId - Session to exclude (usually current session)
 * @param limit - Maximum findings to return
 */
export function getRelevantFindings(
  query: string,
  excludeSessionId: string,
  limit: number = 5
): { success: boolean; findings: FindingInfo[] } {
  const pythonCode = `
import asyncpg
import os
import json

query = sys.argv[1]
exclude_session = sys.argv[2]
limit = int(sys.argv[3])

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Search by topic match or relevance
        rows = await conn.fetch('''
            SELECT session_id, topic, finding, relevant_to, created_at
            FROM findings
            WHERE session_id != $1
              AND (topic ILIKE '%' || $2 || '%'
                   OR $2 = ANY(relevant_to)
                   OR finding ILIKE '%' || $2 || '%')
            ORDER BY created_at DESC
            LIMIT $3
        ''', exclude_session, query, limit)

        findings = []
        for row in rows:
            findings.append({
                'session_id': row['session_id'],
                'topic': row['topic'],
                'finding': row['finding'],
                'relevant_to': row['relevant_to'],
                'created_at': row['created_at'].isoformat() if row['created_at'] else None
            })

        print(json.dumps(findings))
    except Exception as e:
        print(json.dumps([]))
    finally:
        await conn.close()

asyncio.run(main())
`;

  const result = runPgQuery(pythonCode, [query, excludeSessionId, String(limit)]);

  if (!result.success) {
    return { success: false, findings: [] };
  }

  try {
    const findings = JSON.parse(result.stdout || '[]') as FindingInfo[];
    return { success: true, findings };
  } catch {
    return { success: false, findings: [] };
  }
}

// Type definitions for sessions
export interface SessionInfo {
  id: string;
  project: string;
  working_on: string;
  started_at: string | null;
  last_heartbeat: string | null;
}

// Type definitions for findings
export interface FindingInfo {
  session_id: string;
  topic: string;
  finding: string;
  relevant_to: string[];
  created_at: string | null;
}

// =============================================================================
// COORDINATION LAYER: Agent Messaging (LISTEN/NOTIFY)
// =============================================================================

// Type definitions for agent messages
export interface AgentMessage {
  id: number;
  channel: string;
  sender_id: string;
  recipient_id: string | null;
  message_type: string;
  payload: Record<string, unknown>;
  created_at: string | null;
  read_at: string | null;
}

/**
 * Send a message to an agent or broadcast to a channel.
 *
 * Uses PostgreSQL LISTEN/NOTIFY for real-time delivery.
 *
 * @param channel - Channel name (e.g., 'swarm_123', 'project_abc')
 * @param senderId - Sender agent/session ID
 * @param messageType - Type of message (e.g., 'task_complete', 'error', 'status')
 * @param payload - Message payload object
 * @param recipientId - Optional specific recipient (null = broadcast)
 * @returns Object with success boolean and message ID
 */
export function sendAgentMessage(
  channel: string,
  senderId: string,
  messageType: string,
  payload: Record<string, unknown> = {},
  recipientId: string | null = null
): { success: boolean; messageId?: number; error?: string } {
  const pythonCode = `
import asyncpg
import os
import json

channel = sys.argv[1]
sender_id = sys.argv[2]
message_type = sys.argv[3]
payload = json.loads(sys.argv[4])
recipient_id = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] != 'null' else None

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Insert message (trigger will send NOTIFY)
        row = await conn.fetchrow('''
            INSERT INTO agent_messages (channel, sender_id, recipient_id, message_type, payload)
            VALUES ($1, $2, $3, $4, $5::jsonb)
            RETURNING id
        ''', channel, sender_id, recipient_id, message_type, json.dumps(payload))

        print(json.dumps({'success': True, 'id': row['id']}))
    except Exception as e:
        print(json.dumps({'success': False, 'error': str(e)}))
    finally:
        await conn.close()

asyncio.run(main())
`;

  const result = runPgQuery(pythonCode, [
    channel,
    senderId,
    messageType,
    JSON.stringify(payload),
    recipientId || 'null'
  ]);

  if (!result.success) {
    return { success: false, error: result.stderr || 'Query failed' };
  }

  try {
    const parsed = JSON.parse(result.stdout || '{}');
    if (parsed.success) {
      return { success: true, messageId: parsed.id };
    }
    return { success: false, error: parsed.error || 'Unknown error' };
  } catch {
    return { success: false, error: 'Failed to parse response' };
  }
}

/**
 * Get unread messages for an agent/session.
 *
 * @param recipientId - Recipient agent/session ID
 * @param channel - Optional channel filter
 * @param markAsRead - Whether to mark messages as read (default: true)
 * @returns Array of unread messages
 */
export function getAgentMessages(
  recipientId: string,
  channel: string | null = null,
  markAsRead: boolean = true
): { success: boolean; messages: AgentMessage[] } {
  const pythonCode = `
import asyncpg
import os
import json

recipient_id = sys.argv[1]
channel = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != 'null' else None
mark_as_read = sys.argv[3] == 'true' if len(sys.argv) > 3 else True

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Build query based on filters
        if channel:
            rows = await conn.fetch('''
                SELECT id, channel, sender_id, recipient_id, message_type, payload, created_at, read_at
                FROM agent_messages
                WHERE (recipient_id = $1 OR recipient_id IS NULL)
                  AND channel = $2
                  AND read_at IS NULL
                ORDER BY created_at ASC
            ''', recipient_id, channel)
        else:
            rows = await conn.fetch('''
                SELECT id, channel, sender_id, recipient_id, message_type, payload, created_at, read_at
                FROM agent_messages
                WHERE (recipient_id = $1 OR recipient_id IS NULL)
                  AND read_at IS NULL
                ORDER BY created_at ASC
            ''', recipient_id)

        messages = []
        ids = []
        for row in rows:
            ids.append(row['id'])
            messages.append({
                'id': row['id'],
                'channel': row['channel'],
                'sender_id': row['sender_id'],
                'recipient_id': row['recipient_id'],
                'message_type': row['message_type'],
                'payload': dict(row['payload']) if row['payload'] else {},
                'created_at': row['created_at'].isoformat() if row['created_at'] else None,
                'read_at': None
            })

        # Mark as read if requested
        if mark_as_read and ids:
            await conn.execute('''
                UPDATE agent_messages SET read_at = NOW()
                WHERE id = ANY($1)
            ''', ids)

        print(json.dumps(messages))
    finally:
        await conn.close()

asyncio.run(main())
`;

  const result = runPgQuery(pythonCode, [
    recipientId,
    channel || 'null',
    markAsRead ? 'true' : 'false'
  ]);

  if (!result.success) {
    return { success: false, messages: [] };
  }

  try {
    const messages = JSON.parse(result.stdout || '[]') as AgentMessage[];
    return { success: true, messages };
  } catch {
    return { success: false, messages: [] };
  }
}

/**
 * Subscribe to a channel and get the LISTEN command.
 *
 * Note: For real-time listening, agents need to maintain a persistent connection.
 * This function returns the SQL command to execute for LISTEN.
 *
 * @param channel - Channel name to subscribe to
 * @returns LISTEN command string
 */
export function getListenCommand(channel: string): string {
  return `LISTEN agent_${channel};`;
}

// =============================================================================
// COORDINATION LAYER: Agent Tracking
// =============================================================================

// Type definitions for agents
export interface AgentInfo {
  id: string;
  session_id: string;
  parent_agent_id: string | null;
  agent_type: string;
  status: 'running' | 'completed' | 'failed' | 'stalled';
  task_description: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  result_summary: string | null;
}

/**
 * Register a new agent for tracking.
 *
 * @param agentId - Unique agent identifier
 * @param sessionId - Parent session ID
 * @param agentType - Type of agent (kraken, spark, arbiter, etc.)
 * @param taskDescription - Description of the task
 * @param parentAgentId - Optional parent agent ID for hierarchical tracking
 */
export function trackAgent(
  agentId: string,
  sessionId: string,
  agentType: string,
  taskDescription: string | null = null,
  parentAgentId: string | null = null
): { success: boolean; error?: string } {
  const pythonCode = `
import asyncpg
import os

agent_id = sys.argv[1]
session_id = sys.argv[2]
agent_type = sys.argv[3]
task_description = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != 'null' else None
parent_agent_id = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] != 'null' else None

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        await conn.execute('''
            INSERT INTO agents (id, session_id, agent_type, task_description, parent_agent_id, status)
            VALUES ($1, $2, $3, $4, $5, 'running')
            ON CONFLICT (id) DO UPDATE SET
                status = 'running',
                task_description = EXCLUDED.task_description,
                started_at = NOW(),
                completed_at = NULL,
                error_message = NULL
        ''', agent_id, session_id, agent_type, task_description, parent_agent_id)
        print('ok')
    except Exception as e:
        print(f'error: {e}')
    finally:
        await conn.close()

asyncio.run(main())
`;

  const result = runPgQuery(pythonCode, [
    agentId,
    sessionId,
    agentType,
    taskDescription || 'null',
    parentAgentId || 'null'
  ]);

  if (!result.success || result.stdout !== 'ok') {
    return { success: false, error: result.stderr || result.stdout };
  }
  return { success: true };
}

/**
 * Update agent status (completed or failed).
 *
 * @param agentId - Agent identifier
 * @param status - New status
 * @param errorMessage - Error message if failed
 * @param resultSummary - Summary of results if completed
 */
export function updateAgentStatus(
  agentId: string,
  status: 'completed' | 'failed' | 'stalled',
  errorMessage: string | null = null,
  resultSummary: string | null = null
): { success: boolean; error?: string } {
  const pythonCode = `
import asyncpg
import os

agent_id = sys.argv[1]
status = sys.argv[2]
error_message = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != 'null' else None
result_summary = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != 'null' else None

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        await conn.execute('''
            UPDATE agents SET
                status = $2,
                completed_at = NOW(),
                error_message = $3,
                result_summary = $4
            WHERE id = $1
        ''', agent_id, status, error_message, result_summary)
        print('ok')
    except Exception as e:
        print(f'error: {e}')
    finally:
        await conn.close()

asyncio.run(main())
`;

  const result = runPgQuery(pythonCode, [
    agentId,
    status,
    errorMessage || 'null',
    resultSummary || 'null'
  ]);

  if (!result.success || result.stdout !== 'ok') {
    return { success: false, error: result.stderr || result.stdout };
  }
  return { success: true };
}

/**
 * Get agents for a session, optionally filtered by status.
 *
 * @param sessionId - Session ID to query
 * @param status - Optional status filter
 * @returns List of agents
 */
export function getSessionAgents(
  sessionId: string,
  status: string | null = null
): { success: boolean; agents: AgentInfo[] } {
  const pythonCode = `
import asyncpg
import os
import json

session_id = sys.argv[1]
status_filter = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != 'null' else None

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        if status_filter:
            rows = await conn.fetch('''
                SELECT id, session_id, parent_agent_id, agent_type, status,
                       task_description, started_at, completed_at, error_message, result_summary
                FROM agents
                WHERE session_id = $1 AND status = $2
                ORDER BY started_at DESC
            ''', session_id, status_filter)
        else:
            rows = await conn.fetch('''
                SELECT id, session_id, parent_agent_id, agent_type, status,
                       task_description, started_at, completed_at, error_message, result_summary
                FROM agents
                WHERE session_id = $1
                ORDER BY started_at DESC
            ''', session_id)

        agents = []
        for row in rows:
            agents.append({
                'id': row['id'],
                'session_id': row['session_id'],
                'parent_agent_id': row['parent_agent_id'],
                'agent_type': row['agent_type'],
                'status': row['status'],
                'task_description': row['task_description'],
                'started_at': row['started_at'].isoformat() if row['started_at'] else None,
                'completed_at': row['completed_at'].isoformat() if row['completed_at'] else None,
                'error_message': row['error_message'],
                'result_summary': row['result_summary']
            })
        print(json.dumps(agents))
    finally:
        await conn.close()

asyncio.run(main())
`;

  const result = runPgQuery(pythonCode, [sessionId, status || 'null']);

  if (!result.success) {
    return { success: false, agents: [] };
  }

  try {
    const agents = JSON.parse(result.stdout || '[]') as AgentInfo[];
    return { success: true, agents };
  } catch {
    return { success: false, agents: [] };
  }
}

/**
 * Get failed or stalled agents that can be resumed.
 *
 * @param sessionId - Optional session filter
 * @returns List of resumable agents
 */
export function getResumableAgents(
  sessionId: string | null = null
): { success: boolean; agents: AgentInfo[] } {
  const pythonCode = `
import asyncpg
import os
import json
from datetime import datetime, timezone, timedelta

session_id = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != 'null' else None

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Get failed agents and stalled running agents (no update in 10 min)
        stale_threshold = datetime.now(timezone.utc) - timedelta(minutes=10)

        if session_id:
            rows = await conn.fetch('''
                SELECT id, session_id, parent_agent_id, agent_type, status,
                       task_description, started_at, completed_at, error_message, result_summary
                FROM agents
                WHERE session_id = $1
                  AND (status IN ('failed', 'stalled')
                       OR (status = 'running' AND started_at < $2))
                ORDER BY started_at DESC
            ''', session_id, stale_threshold)
        else:
            rows = await conn.fetch('''
                SELECT id, session_id, parent_agent_id, agent_type, status,
                       task_description, started_at, completed_at, error_message, result_summary
                FROM agents
                WHERE status IN ('failed', 'stalled')
                   OR (status = 'running' AND started_at < $1)
                ORDER BY started_at DESC
                LIMIT 20
            ''', stale_threshold)

        agents = []
        for row in rows:
            agents.append({
                'id': row['id'],
                'session_id': row['session_id'],
                'parent_agent_id': row['parent_agent_id'],
                'agent_type': row['agent_type'],
                'status': row['status'] if row['status'] != 'running' else 'stalled',
                'task_description': row['task_description'],
                'started_at': row['started_at'].isoformat() if row['started_at'] else None,
                'completed_at': row['completed_at'].isoformat() if row['completed_at'] else None,
                'error_message': row['error_message'],
                'result_summary': row['result_summary']
            })
        print(json.dumps(agents))
    finally:
        await conn.close()

asyncio.run(main())
`;

  const result = runPgQuery(pythonCode, [sessionId || 'null']);

  if (!result.success) {
    return { success: false, agents: [] };
  }

  try {
    const agents = JSON.parse(result.stdout || '[]') as AgentInfo[];
    return { success: true, agents };
  } catch {
    return { success: false, agents: [] };
  }
}

/** A claim that another session holds and the two-condition rule would NOT let this session reclaim. */
export interface BlockingClaim {
  filePath: string;
  sessionId: string;
  /** The claim's project key (normalized common dir of its repo). */
  project: string;
}

/**
 * The claims, in EVERY project, that a session other than `sessionId` holds right now: the lease is live OR the holder
 * is alive. This is the exact negation of the reclaim rule in RESOLVE_CLAIM_SQL (reclaim needs an
 * expired lease AND a stale holder). Read only: it changes no row and takes no lock. File-claims
 * uses it for shell text, where no path is named (card coord-file-claims-all-writers). Every
 * project, because a command can name a file in a repo other than the one of its cwd.
 * `degraded: true` means the query did not run; the caller continues silently.
 */
export async function listBlockingClaims(
  sessionId: string,
  staleThresholdMs: number,
): Promise<{ claims: BlockingClaim[]; degraded: boolean }> {
  const staleSeconds = Math.floor(staleThresholdMs / 1000);
  const { value, degraded } = await withPgClientOrFallback<BlockingClaim[]>(
    async (client) => {
      const res = await client.query(
        `SELECT fc.file_path, fc.session_id, fc.project
           FROM file_claims fc
          WHERE fc.session_id <> $1
            AND ( (fc.expires_at IS NOT NULL AND fc.expires_at > NOW())
                  OR EXISTS (SELECT 1 FROM sessions s
                              WHERE s.id = fc.session_id
                                AND GREATEST(s.last_heartbeat, s.last_activity_at) >= NOW() - make_interval(secs => $2)) )
          LIMIT 500`,
        [sessionId, staleSeconds],
      );
      return res.rows.map((r: { file_path: string; session_id: string; project: string }) => ({ filePath: r.file_path, sessionId: r.session_id, project: r.project }));
    },
    [] as BlockingClaim[],
    'listBlockingClaims',
  );
  return { claims: value, degraded };
}
