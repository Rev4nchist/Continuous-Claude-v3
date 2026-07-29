/**
 * lane-context — carries the coordination board INTO each session.
 *
 * WHY A HOOK AND NOT JUST THE CLI
 * -------------------------------
 * `scripts/coordination/lane.mjs` can answer every question this hook answers.
 * That is exactly why the CLI alone is not enough: it requires a session to
 * remember to ask. The predecessor of this whole layer was a markdown file at
 * the repo root, and its fatal flaw was not its format — it was that nothing
 * carried it into a session that did not think to open it. Coordination that
 * depends on remembering to look is coordination that fails on the busy day.
 *
 * So the board is pushed, once per turn, unprompted.
 *
 * WHAT IT INJECTS
 * ---------------
 *   SessionStart      the full picture: lanes I hold, who else is live and on
 *                     what, and what is claimable.
 *   UserPromptSubmit  the DELTA only — events since my watermark. Silence when
 *                     nothing changed, because a banner that prints every turn
 *                     regardless is one the model learns to skip.
 *
 * It also renews my lane leases on every prompt. A session actively working
 * should never lose its lane to a lapse; the lease exists to release the lanes
 * of sessions that have STOPPED, and the cheapest proof that I have not stopped
 * is that I am still taking turns.
 *
 * FAILURE POSTURE — SILENT, ALWAYS
 * --------------------------------
 * This runs in EVERY Claude Code session on this machine, including projects
 * that have nothing to do with lanes. Every failure path — no database, no
 * tables, wrong project, slow connect — exits 0 with empty output. An
 * instrumentation hook may never be the reason a session cannot start, and a
 * coordination banner is worth strictly less than the turn it would interrupt.
 * The connect timeout is deliberately shorter than the file-claims path's,
 * because unlike a claim check, being late here costs a turn and buys nothing.
 */

import { Client } from 'pg';

/**
 * The context-injection output shape.
 *
 * Declared locally rather than imported: `HookOutput` in shared/types.ts is a
 * union of the PreToolUse permission shape and the legacy result shape, and
 * models neither `additionalContext` nor SessionStart. Casting through it would
 * have been a lie the compiler correctly refused.
 */
interface ContextInjectionOutput {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

/** Shorter than the claim path's 2000ms: a missed banner is free, a stalled prompt is not. */
const CONNECT_TIMEOUT_MS = 1200;
const QUERY_TIMEOUT_MS = 1500;
const LEASE_MINUTES = 90;
const STALE_MINUTES = 5;
/** Past this, an injected digest stops being a summary and starts being a wall. */
const MAX_EVENTS = 12;

interface LaneRow {
  id: string; title: string; track: string; state: string;
  scope: string | null; note: string | null;
  owner_session_id: string | null; lease_expires_at: string | null;
}
interface EventRow {
  id: number; occurred_at: string; lane_id: string | null; kind: string;
  session_id: string; to_session_id: string | null; body: string | null;
}

function connString(): string {
  return process.env.CONTINUOUS_CLAUDE_DB_URL
    || process.env.DATABASE_URL
    || process.env.OPC_POSTGRES_URL
    || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
}

const short = (s: string | null): string => (s ? s.slice(0, 8) : '--------');

/** Echo back the event we were actually invoked for — a SessionStart injection
 *  labelled UserPromptSubmit is a mismatch the harness has no reason to honour. */
function emit(context: string, eventName: string): void {
  if (!context.trim()) { process.stdout.write('{}'); return; }
  const out: ContextInjectionOutput = {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: { session_id?: string; hook_event_name?: string } = {};
  try { payload = JSON.parse(raw); } catch { /* fall through to the guard below */ }

  /**
   * The payload uuid, and nothing else.
   *
   * NOT ~/.claude/.coordination-session-id: that path is global, so with two
   * sessions live every one of them would read the same id and the board would
   * show one session coordinating with itself. That is the precise shape of the
   * identity bug this project spent a session root-causing.
   */
  const me = payload.session_id;
  if (!me) { process.stdout.write('{}'); return; }

  const eventName = payload.hook_event_name || 'UserPromptSubmit';
  const isStart = eventName === 'SessionStart';

  const client = new Client({
    connectionString: connString(),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });

  try {
    await client.connect();

    // Proof of life for my own lanes. Harmless when I hold none.
    await client.query(
      `UPDATE agentic_os.lane
         SET lease_expires_at = now() + interval '${LEASE_MINUTES} minutes'
       WHERE owner_session_id = $1 AND state <> 'done'`,
      [me],
    );

    const unread = (await client.query<EventRow>(
      `SELECT e.* FROM agentic_os.lane_event e
       WHERE e.id > COALESCE((SELECT last_event_id FROM agentic_os.lane_watermark WHERE session_id=$1),0)
         AND e.session_id <> $1
         AND (e.to_session_id IS NULL OR e.to_session_id = $1)
       ORDER BY e.id`,
      [me],
    )).rows;

    const mine = (await client.query<LaneRow>(
      `SELECT * FROM agentic_os.lane WHERE owner_session_id=$1 AND state<>'done' ORDER BY priority, id`,
      [me],
    )).rows;

    // Only peers that are BOTH alive and holding something. A live session with
    // no lane is not a collision risk and does not need a line.
    //
    // "Alive" is GREATEST(last_heartbeat, last_activity_at), never the heartbeat
    // alone: heartbeat.ts fires on UserPromptSubmit only, so a peer that has been
    // editing continuously for 25 minutes without its human typing reads as dead
    // and is silently DROPPED from this warning -- the one place the collision
    // was supposed to surface. GREATEST returns NULL only when both are NULL, so
    // pre-writer rows degrade to the old behaviour rather than to "never alive".
    const peers = (await client.query<{ sid: string; lanes: string; scopes: string }>(
      `SELECT s.id AS sid,
              string_agg(l.id, ', ' ORDER BY l.id)              AS lanes,
              string_agg(COALESCE(l.scope,''), ' | ')           AS scopes
       FROM sessions s
       JOIN agentic_os.lane l ON l.owner_session_id = s.id AND l.state <> 'done'
       WHERE GREATEST(s.last_heartbeat, s.last_activity_at) > now() - interval '${STALE_MINUTES} minutes'
         AND s.id <> $1
       GROUP BY s.id`,
      [me],
    )).rows;

    const lines: string[] = [];

    if (isStart) {
      const claimable = (await client.query<LaneRow>(
        `SELECT * FROM agentic_os.lane
         WHERE state IN ('ready','backlog') AND owner_session_id IS NULL
         ORDER BY priority, id LIMIT 5`,
      )).rows;

      lines.push('## Lane board (concurrent sessions on this branch)');
      lines.push(`You are session ${short(me)}.`);
      lines.push('');
      lines.push(mine.length
        ? `You hold: ${mine.map((l) => l.id).join(', ')}`
        : 'You hold no lane. Claim one before starting work: `node scripts/coordination/lane.mjs next`');
      if (peers.length) {
        lines.push('');
        lines.push('Other live sessions and their scope — do not edit inside these:');
        for (const p of peers) {
          lines.push(`  ${short(p.sid)} holds ${p.lanes}`);
          const sc = (p.scopes || '').split('|').map((s) => s.trim()).filter(Boolean).join(' | ');
          if (sc) lines.push(`     scope: ${sc}`);
        }
      } else {
        lines.push('');
        lines.push('No other session currently holds a lane.');
      }
      if (claimable.length) {
        lines.push('');
        lines.push('Claimable next:');
        for (const l of claimable) lines.push(`  ${l.id.padEnd(28)} ${l.title}`);
      }
      lines.push('');
      lines.push('Commands: lane.mjs board | next | claim <id> | note <id> "..." | say "..." | done <id>');
      lines.push('Serialize commits — same branch, two committers race .git/index.lock.');
    }

    if (unread.length) {
      if (lines.length) lines.push('');
      lines.push(`## ${unread.length} lane update(s) since you last looked`);
      for (const e of unread.slice(-MAX_EVENTS)) {
        const who = short(e.session_id);
        const dm = e.to_session_id ? ' (direct to you)' : '';
        const lane = e.lane_id ? ` [${e.lane_id}]` : '';
        lines.push(`- ${who} ${e.kind}${lane}${dm}: ${e.body || ''}`);
      }
      if (unread.length > MAX_EVENTS) {
        lines.push(`  (${unread.length - MAX_EVENTS} older suppressed — \`lane.mjs inbox --peek\` for all)`);
      }
    }

    // Advance the watermark only for what was actually injected. Nothing was
    // shown on a turn that produced no output, so nothing may be marked read.
    if (unread.length && lines.length) {
      await client.query(
        `INSERT INTO agentic_os.lane_watermark (session_id, last_event_id, updated_at)
         VALUES ($1,$2,now())
         ON CONFLICT (session_id) DO UPDATE SET last_event_id=EXCLUDED.last_event_id, updated_at=now()`,
        [me, unread[unread.length - 1].id],
      );
    }

    emit(lines.join('\n'), eventName);
  } catch {
    // Silent by contract. No database, no tables, no lanes, slow connect — all
    // the same answer: say nothing and let the turn proceed.
    process.stdout.write('{}');
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch(() => process.stdout.write('{}'));
