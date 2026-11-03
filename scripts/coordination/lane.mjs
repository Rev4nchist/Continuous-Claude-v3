#!/usr/bin/env node
/**
 * lane -- the coordination surface for concurrent sessions on one branch.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two or more Claude Code sessions run on this branch at once and cannot see
 * each other's conversation. This is how they see each other: a lane is a
 * durable, human-named work thread with a declared scope, and a session claims
 * one before it starts. The claim is atomic, so two sessions racing produce
 * exactly one winner and one loser that is TOLD it lost, by name.
 *
 * Schema and the full design rationale: apps/agentic-os/src/db/schema/lane.ts.
 *
 * IDENTITY -- READ THIS BEFORE CHANGING IT
 * ----------------------------------------
 * The session id comes from `CLAUDE_CODE_SESSION_ID`, the per-process uuid
 * Claude Code injects into every Bash/PowerShell call. It matches the uuid the
 * hooks coordinate on and the one in `sessions.id`.
 *
 * It must NEVER fall back to `~/.claude/.coordination-session-id`. That file is
 * a SINGLE GLOBAL PATH: with two sessions live, whichever registered last owns
 * it, so every session reading it would answer with the same id and the lock
 * would be coordinating one imaginary session with itself. That is precisely the
 * identity bug this project spent a session root-causing (8,179 claims, 0 owned
 * by a live session). Explicit `--as <id>` is the only override.
 *
 * FAILURE POSTURE
 * ---------------
 * This is a CLI a human or agent runs deliberately, not a hook in the Edit path,
 * so it fails LOUD -- a coordination command that silently no-ops is worse than
 * one that errors, because the caller would proceed believing it had the lane.
 *
 * USAGE
 *   node scripts/coordination/lane.mjs board            # everything, grouped by track
 *   node scripts/coordination/lane.mjs next             # highest-priority claimable lane
 *   node scripts/coordination/lane.mjs mine             # my lanes + lease time left
 *   node scripts/coordination/lane.mjs claim <id> [--note "..."]
 *   node scripts/coordination/lane.mjs note  <id> "status line"
 *   node scripts/coordination/lane.mjs state <id> <backlog|ready|active|blocked|review|done>
 *   node scripts/coordination/lane.mjs release <id> [--note "why"]
 *   node scripts/coordination/lane.mjs done <id> [--note "evidence"]
 *   node scripts/coordination/lane.mjs renew            # push my leases out
 *   node scripts/coordination/lane.mjs say "message" [--to <name|sid-prefix>] [--lane <id>]
 *   node scripts/coordination/lane.mjs inbox [--peek]   # unread; advances watermark unless --peek
 *   node scripts/coordination/lane.mjs add <id> --title "..." [--track t] [--scope "..."] [--priority N]
 *   node scripts/coordination/lane.mjs seed <file.json> # idempotent bulk add
 *   node scripts/coordination/lane.mjs peers            # who else is live right now
 *   node scripts/coordination/lane.mjs whoami           # my label, uuid and lanes
 *   node scripts/coordination/lane.mjs adopt --from <old-uuid>
 *                                                       # take over lanes + unread DMs after /clear, resume, fork
 *   node scripts/coordination/lane.mjs apply-kanban <file.json> [--dry-run] [--json]
 *                                                       # carry Dave's kanban changes into the lanes
 *
 * Global flags: --as <session-id>, --json
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planKanban } from './kanban-apply.mjs';
import {
  adoptAllowed, isSafeId, label, labelWithAgent, listIdentities, readIdentity, resolveName, short, validAgent,
} from './session-label.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

/**
 * `pg` is not a dependency of the repo root -- it lives in the hooks bundle and
 * in apps/agentic-os. Resolve from whichever is present rather than adding a
 * third copy, and say so clearly if neither is.
 */
function loadPg() {
  const candidates = [
    join(REPO, '.claude', 'hooks', 'package.json'),
    join(REPO, 'apps', 'agentic-os', 'package.json'),
  ];
  for (const anchor of candidates) {
    try {
      return createRequire(pathToFileURL(anchor)).call(null, 'pg');
    } catch { /* try the next anchor */ }
  }
  throw new Error(
    'cannot resolve the `pg` module. Looked in .claude/hooks and apps/agentic-os.\n' +
    'Run `npm install` in one of them.',
  );
}

const LANE_STATES = ['backlog', 'ready', 'active', 'blocked', 'review', 'done'];

/** 90 minutes. Long on purpose: a lane spans hours of work across many edits,
 *  so a file-lock-sized lease would lapse mid-thought and invite a takeover of
 *  work still in flight. See the schema comment. */
const LEASE_MINUTES = 90;
/** A session quiet for this long is treated as gone, matching the file-claims rule. */
const STALE_MINUTES = 5;

function connString() {
  return process.env.CONTINUOUS_CLAUDE_DB_URL
    || process.env.DATABASE_URL
    || process.env.OPC_POSTGRES_URL
    || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';
}

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  } else positional.push(a);
}
const JSON_OUT = flags.json === true;

function me() {
  const id = typeof flags.as === 'string' ? flags.as : process.env.CLAUDE_CODE_SESSION_ID;
  if (!id) {
    throw new Error(
      'no session id. CLAUDE_CODE_SESSION_ID is unset and --as was not given.\n' +
      'Deliberately NOT falling back to ~/.claude/.coordination-session-id -- that\n' +
      'file is global and would make every session claim the same identity.',
    );
  }
  return id;
}

// Session names live in identity files (session-label.mjs). Read once per run.
let IDS = null;
const ids = () => (IDS ??= listIdentities());
const L = (uuid) => label(uuid, ids());
const nameOf = (uuid) => ids().get(uuid)?.name || null;
/** --agent <type> tags a subagent's say/note. An invalid value is ignored. */
const agentDetail = () => { const a = validAgent(flags.agent); return a ? { agent: a } : {}; };

/** Inbox times: America/Chicago, with the zone abbreviation that is in force (CST or CDT). */
function chicagoTime(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(new Date(d));
  const p = (t) => parts.find((x) => x.type === t)?.value;
  return `${p('hour')}:${p('minute')} ${p('timeZoneName')}`;
}

// ---------------------------------------------------------------- db

async function withDb(fn) {
  const { Client } = loadPg();
  const client = new Client({
    connectionString: connString(),
    connectionTimeoutMillis: 4000,
    query_timeout: 8000,
  });
  await client.connect();
  try { return await fn(client); } finally { await client.end().catch(() => {}); }
}

/** Record a lane event. Never throws into the caller's result path -- a failed
 *  log line must not make a successful claim look like a failure. */
async function logEvent(c, { laneId = null, kind, sessionId, to = null, body = null, detail = {} }) {
  try {
    await c.query(
      `INSERT INTO agentic_os.lane_event (lane_id, kind, session_id, to_session_id, body, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [laneId, kind, sessionId, to, body, JSON.stringify(detail)],
    );
  } catch (e) {
    process.stderr.write(`[lane] warn: event not recorded (${e.message})\n`);
  }
}

/**
 * WHEN A SESSION WAS LAST ALIVE -- one expression, so no reader invents its own.
 *
 * NOT bare `last_heartbeat`. `heartbeat.ts` fires on UserPromptSubmit ONLY, so
 * that column measures the HUMAN typing, not the agent working. Measured peak
 * staleness during a 12-agent workflow: 505s, while the session was editing
 * continuously. Keying liveness on it alone means a session that is mid-edit
 * reads as dead and its lane or file claim becomes reclaimable out from under it
 * -- demonstrated live on session 079ae1e7 (heartbeat age 1521s, activity age
 * 25s, lock said dead, truth said alive).
 *
 * GREATEST ignores NULLs and returns NULL only when EVERY argument is NULL, so
 * rows written before `last_activity_at` had a writer degrade exactly to the old
 * behaviour rather than to "never alive".
 *
 * Takes the table alias so the SAME text is used in every query. The reason this
 * bug existed at all is that the predicate was spelled out at eight separate
 * sites and only some were updated; `scripts/coordination/liveness-predicate-guard.mjs`
 * now asserts a nonzero count of this form and zero of the bare form.
 */
const ALIVE_AT = (alias = '') => `GREATEST(${alias}last_heartbeat, ${alias}last_activity_at)`;

/**
 * The reclaimability predicate, in one place so every query agrees.
 *
 * BOTH conditions, never either: an expired lease on a live session means the
 * owner is still working and merely slow, and a dead session inside its lease is
 * still dead. This mirrors the rule that shipped for file_claims -- when the two
 * layers disagree about what "abandoned" means, the humans reading them stop
 * trusting either.
 */
const RECLAIMABLE = `(
  l.owner_session_id IS NULL
  OR (
    (l.lease_expires_at IS NULL OR l.lease_expires_at < now())
    AND NOT EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = l.owner_session_id
        AND ${ALIVE_AT('s.')} > now() - interval '${STALE_MINUTES} minutes'
    )
  )
)`;

// ---------------------------------------------------------------- render

const STATE_MARK = {
  backlog: '·', ready: 'o', active: '>', blocked: '!', review: '?', done: 'x',
};

function laneLine(l, myId) {
  const mine = l.owner_session_id === myId;
  const who = l.owner_session_id ? (mine ? 'YOU' : L(l.owner_session_id)) : '';
  const lease = l.lease_expires_at
    ? Math.round((new Date(l.lease_expires_at) - Date.now()) / 60000)
    : null;
  const leaseTag = l.owner_session_id
    ? (lease === null ? '' : lease > 0 ? ` ${lease}m` : ` LAPSED`)
    : '';
  const head = `${STATE_MARK[l.state] || '·'} ${l.id.padEnd(26)} ${String(l.state).padEnd(8)} ${(who + leaseTag).padEnd(30)}`;
  const lines = [`${head} ${l.title}`];
  if (l.note) lines.push(`${' '.repeat(30)}${l.note}`);
  if (l.scope) lines.push(`${' '.repeat(30)}scope: ${l.scope}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- commands

const commands = {
  async board(c) {
    const myId = me();
    const { rows } = await c.query(
      `SELECT l.* FROM agentic_os.lane l
       WHERE ($1::boolean OR l.state <> 'done')
       ORDER BY l.track, l.priority, l.id`,
      [flags.all === true],
    );
    const peers = (await c.query(
      `SELECT id, working_on FROM sessions
       WHERE ${ALIVE_AT()} > now() - interval '${STALE_MINUTES} minutes'
       ORDER BY ${ALIVE_AT()} DESC`,
    )).rows;

    if (JSON_OUT) {
      return {
        lanes: rows.map((l) => ({ ...l, owner_name: l.owner_session_id ? nameOf(l.owner_session_id) : null })),
        peers,
        me: myId,
        me_short: short(myId),
        me_name: nameOf(myId),
      };
    }

    const out = [];
    out.push(`LANE BOARD   me=${L(myId)}   ${rows.length} open lane(s)   ${peers.length} live session(s)`);
    let track = null;
    for (const l of rows) {
      if (l.track !== track) { track = l.track; out.push(``, `-- ${track} ${'-'.repeat(Math.max(0, 60 - track.length))}`); }
      out.push(laneLine(l, myId));
    }
    const unread = (await c.query(
      `SELECT count(*)::int AS n FROM agentic_os.lane_event e
       WHERE e.id > COALESCE((SELECT last_event_id FROM agentic_os.lane_watermark WHERE session_id=$1),0)
         AND e.session_id <> $1
         AND (e.to_session_id IS NULL OR e.to_session_id = $1)`, [myId],
    )).rows[0].n;
    out.push(``, unread > 0 ? `${unread} unread -- run: lane.mjs inbox` : `inbox empty`);
    return out.join('\n');
  },

  async peers(c) {
    const myId = me();
    const { rows } = await c.query(
      `SELECT s.id, s.working_on, ${ALIVE_AT('s.')} AS last_alive,
              (SELECT string_agg(l.id, ', ' ORDER BY l.id) FROM agentic_os.lane l
                WHERE l.owner_session_id = s.id AND l.state <> 'done') AS lanes
       FROM sessions s
       WHERE ${ALIVE_AT('s.')} > now() - interval '${STALE_MINUTES} minutes'
       ORDER BY ${ALIVE_AT('s.')} DESC`,
    );
    if (JSON_OUT) return rows.map((r) => ({ ...r, name: nameOf(r.id), label: L(r.id) }));
    return rows.map((r) => {
      const held = r.lanes ? r.lanes.split(', ') : [];
      const lanes = held.length ? `${held[0]}${held.length > 1 ? ` +${held.length - 1}` : ''}` : '(none)';
      return `${r.id === myId ? '*' : ' '} ${L(r.id)}  lanes: ${lanes}`;
    }).join('\n') || 'no live sessions';
  },

  /** Who am I: the label, the full uuid and the lanes I hold. */
  async whoami(c) {
    const myId = me();
    const held = (await c.query(
      `SELECT id FROM agentic_os.lane WHERE owner_session_id=$1 AND state <> 'done' ORDER BY id`, [myId],
    )).rows.map((r) => r.id);
    if (JSON_OUT) return { label: L(myId), uuid: myId, short: short(myId), name: nameOf(myId), lanes: held };
    return [L(myId), `uuid: ${myId}`, `lanes: ${held.join(', ') || '(none)'}`].join('\n');
  },

  /**
   * Take over the open lanes, unread direct messages and inbox cursor of a session
   * that /clear, resume or fork replaced. Hooks call this at SessionStart.
   *
   * Refused unless the two identity files agree it is the same session (see
   * adoptAllowed) AND the old session has ended (endedAt, or quiet for STALE_MINUTES):
   * this moves another session's lanes, so a stranger or a live session gets nothing.
   * One transaction. A second run finds nothing left to move. The cursor is carried
   * only when the new session has none, so an adopt cannot rewind a live inbox; if
   * the new session already read past a moved message, the cursor steps back to it.
   */
  async adopt(c) {
    const newId = me();
    const oldId = flags.from;
    if (typeof oldId !== 'string') throw new Error('usage: lane.mjs adopt --from <old-session-uuid>');
    if (oldId === newId) throw new Error('adopt --from must be a different session than me');
    if (!isSafeId(oldId)) throw new Error(`adopt --from "${oldId}" is not a session id`);
    const oldIdentity = readIdentity(oldId);
    if (!adoptAllowed(oldId, newId, oldIdentity, readIdentity(newId))) {
      const e = new Error(
        `REFUSED adopt from ${L(oldId)}: ${L(newId)} does not share its name and does not name it as previous.\n` +
        `  Identity files: ${nameOf(oldId) || '(no name)'} / ${nameOf(newId) || '(no name)'}`);
      e.soft = true; throw e;
    }
    // A live session keeps its lanes. The old one must have ended: its identity file says so,
    // or its sessions row has been quiet for STALE_MINUTES (same liveness predicate as claim).
    if (!oldIdentity?.endedAt) {
      const live = (await c.query(
        `SELECT 1 FROM sessions WHERE id=$1 AND ${ALIVE_AT()} > now() - interval '${STALE_MINUTES} minutes'`, [oldId],
      )).rows.length > 0;
      if (live) {
        const e = new Error(
          `REFUSED adopt from ${L(oldId)}: it has not ended (no endedAt, alive in the last ${STALE_MINUTES}m).\n` +
          `  Retry after it ends or goes quiet.`);
        e.soft = true; throw e;
      }
    }
    await c.query('BEGIN');
    let moved;
    try {
      const lanes = (await c.query(
        `UPDATE agentic_os.lane SET owner_session_id=$2, updated_at=now()
         WHERE owner_session_id=$1 AND state <> 'done' RETURNING id`, [oldId, newId],
      )).rows.map((r) => r.id).sort();
      const wm = async (sid) => (await c.query(
        `SELECT last_event_id::bigint AS n FROM agentic_os.lane_watermark WHERE session_id=$1`, [sid],
      )).rows[0]?.n;
      const oldWm = await wm(oldId);
      const newWm = await wm(newId);
      const dms = (await c.query(
        `UPDATE agentic_os.lane_event
            SET to_session_id=$2, detail = detail || jsonb_build_object('adoptedFrom', $1::text)
          WHERE to_session_id=$1 AND id > $3::bigint RETURNING id`, [oldId, newId, oldWm ?? 0],
      )).rows.map((r) => Number(r.id));
      let cursor = 'unchanged';
      if (newWm === undefined && oldWm !== undefined) {
        await c.query(
          `INSERT INTO agentic_os.lane_watermark (session_id, last_event_id, updated_at) VALUES ($1,$2,now())`, [newId, oldWm]);
        cursor = 'carried';
      } else if (newWm !== undefined && dms.length && Math.min(...dms) <= Number(newWm)) {
        await c.query(
          `UPDATE agentic_os.lane_watermark SET last_event_id=$2, updated_at=now() WHERE session_id=$1`, [newId, Math.min(...dms) - 1]);
        cursor = 'stepped back';
      }
      await c.query('COMMIT');
      moved = { from: oldId, to: newId, lanes, messages: dms.length, cursor };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    }
    // Addressed to the new session itself: inbox and the DM hook skip a session's own events,
    // so this is an audit row nobody gets paged for.
    if (moved.lanes.length || moved.messages) {
      await logEvent(c, {
        kind: 'note', sessionId: newId, to: newId,
        body: `${L(newId)} adopted ${moved.lanes.length} lane(s) and ${moved.messages} message(s) from ${L(oldId)}`,
        detail: { adopted: true, from: oldId },
      });
    }
    if (JSON_OUT) return moved;
    if (!moved.lanes.length && !moved.messages && moved.cursor === 'unchanged') return `adopt from ${L(oldId)}: nothing to move`;
    return `adopted from ${L(oldId)}: ${moved.lanes.length} lane(s) [${moved.lanes.join(', ')}], ${moved.messages} message(s), cursor ${moved.cursor}`;
  },

  async next(c) {
    const myId = me();
    const { rows } = await c.query(
      `SELECT l.* FROM agentic_os.lane l
       WHERE l.state IN ('ready','backlog') AND ${RECLAIMABLE}
       ORDER BY l.priority, l.id LIMIT ${Number(flags.n) > 0 ? Number(flags.n) : 5}`,
    );
    if (JSON_OUT) return rows;
    if (!rows.length) return 'nothing claimable';
    return rows.map((l) => laneLine(l, myId)).join('\n');
  },

  async mine(c) {
    const myId = me();
    const { rows } = await c.query(
      `SELECT l.* FROM agentic_os.lane l WHERE l.owner_session_id=$1 ORDER BY l.priority, l.id`, [myId],
    );
    if (JSON_OUT) return rows;
    return rows.length ? rows.map((l) => laneLine(l, myId)).join('\n') : 'you hold no lanes';
  },

  /**
   * Atomic claim. The whole point of the layer.
   *
   * One statement decides it: the UPDATE only matches an unclaimed-or-reclaimable
   * row, so two sessions issuing this in the same millisecond produce one row
   * updated and one row not, with no read-then-write window between them. The
   * loser is then told who won -- an unexplained "no" would send it looking for
   * a bug instead of a person.
   */
  async claim(c) {
    const myId = me();
    const id = positional[1];
    if (!id) throw new Error('usage: lane.mjs claim <lane-id> [--note "..."]');

    const { rows } = await c.query(
      `UPDATE agentic_os.lane l SET
         owner_session_id = $2,
         claimed_at       = now(),
         lease_expires_at = now() + interval '${LEASE_MINUTES} minutes',
         fence            = l.fence + 1,
         state            = CASE WHEN l.state IN ('backlog','ready') THEN 'active' ELSE l.state END,
         note             = COALESCE($3, l.note),
         updated_at       = now()
       WHERE l.id = $1 AND ${RECLAIMABLE}
       RETURNING l.*`,
      [id, myId, typeof flags.note === 'string' ? flags.note : null],
    );

    if (rows.length) {
      const l = rows[0];
      await logEvent(c, {
        laneId: id, kind: 'claimed', sessionId: myId,
        body: typeof flags.note === 'string' ? flags.note : null,
        detail: { fence: l.fence, state: l.state },
      });
      return JSON_OUT ? l
        : `CLAIMED ${id} (fence ${l.fence}, lease ${LEASE_MINUTES}m)\n  ${l.title}\n  scope: ${l.scope || '(undeclared -- set one)'}`;
    }

    const cur = (await c.query(`SELECT * FROM agentic_os.lane WHERE id=$1`, [id])).rows[0];
    if (!cur) throw new Error(`no lane "${id}". Run: lane.mjs board`);
    if (cur.owner_session_id === myId) {
      return JSON_OUT ? cur : `you already hold ${id} -- use "renew" to extend, "note" to update it`;
    }
    // Displayed, not decided -- but it must answer the SAME question the deny
    // message goes on to state the rule for. Rendering bare last_heartbeat here
    // next to "a holder quiet Nm" told the reader a working holder had been
    // silent for 25 minutes while RECLAIMABLE, correctly, refused to release the
    // lane. AT TIME ZONE 'UTC' because these are `timestamp without time zone`
    // holding UTC and node-postgres parses that as LOCAL -- the same confusion
    // put a future date on this board on 2026-07-26.
    const holder = (await c.query(
      `SELECT ${ALIVE_AT()} AT TIME ZONE 'UTC' AS last_alive, working_on
         FROM sessions WHERE id=$1`, [cur.owner_session_id],
    )).rows[0];
    await logEvent(c, {
      laneId: id, kind: 'note', sessionId: myId, to: cur.owner_session_id,
      body: `tried to claim ${id}, denied -- you hold it`,
      detail: { denied: true },
    });
    const err = [
      `DENIED ${id} -- held by ${L(cur.owner_session_id)}`,
      `  their note: ${cur.note || '(none)'}`,
      `  lease: ${cur.lease_expires_at ? new Date(cur.lease_expires_at).toISOString() : 'none'}`,
      `  they were last alive: ${holder?.last_alive ? new Date(holder.last_alive).toISOString() : 'never seen'}`,
      `  Reclaim needs BOTH an expired lease AND a holder quiet ${STALE_MINUTES}m.`,
      `  They have been told you wanted it. Pick another: lane.mjs next`,
    ].join('\n');
    const e = new Error(err); e.soft = true; throw e;
  },

  async renew(c) {
    const myId = me();
    const { rows } = await c.query(
      `UPDATE agentic_os.lane SET lease_expires_at = now() + interval '${LEASE_MINUTES} minutes', updated_at = now()
       WHERE owner_session_id=$1 AND state <> 'done' RETURNING id`, [myId],
    );
    return JSON_OUT ? rows : `renewed ${rows.length} lane(s): ${rows.map((r) => r.id).join(', ') || '(none)'}`;
  },

  async note(c) {
    const myId = me();
    const id = positional[1];
    const body = positional.slice(2).join(' ') || (typeof flags.note === 'string' ? flags.note : '');
    if (!id || !body) throw new Error('usage: lane.mjs note <lane-id> "status line"');
    const { rows } = await c.query(
      `UPDATE agentic_os.lane SET note=$2, updated_at=now(),
         lease_expires_at = CASE WHEN owner_session_id=$3
           THEN now() + interval '${LEASE_MINUTES} minutes' ELSE lease_expires_at END
       WHERE id=$1 RETURNING *`, [id, body, myId],
    );
    if (!rows.length) throw new Error(`no lane "${id}"`);
    await logEvent(c, { laneId: id, kind: 'note', sessionId: myId, body, detail: agentDetail() });
    return JSON_OUT ? rows[0] : `noted on ${id}: ${body}`;
  },

  async state(c) {
    const myId = me();
    const id = positional[1];
    const to = positional[2];
    if (!id || !LANE_STATES.includes(to)) {
      throw new Error(`usage: lane.mjs state <lane-id> <${LANE_STATES.join('|')}>`);
    }
    // NOTE: `myId` is deliberately NOT a bind parameter here. It used to be passed as
    // $3, but the SQL below never referenced $3 -- Postgres cannot infer the type of an
    // unreferenced parameter, so it rejected the whole statement with "could not
    // determine data type of parameter $3". That broke `state`, and with it `release`
    // and `done`, which delegate here. The result: nothing was EVER markable done
    // through this CLI, so the board silently degraded into an intake register that
    // could record work starting but never work finishing.
    //
    // `myId` is still read below for logEvent attribution -- it just has no business in
    // the SQL. It could not be recovered from `rows[0]` either, because this same
    // UPDATE nulls owner_session_id on the done/ready transitions.
    //
    // Known gap, deliberately left alone: WHERE is `id=$1` with no ownership check, so
    // any session can transition any lane. That is a behaviour change affecting other
    // live sessions and does not belong in a parameter-binding bug fix.
    const { rows } = await c.query(
      `UPDATE agentic_os.lane SET state=$2, updated_at=now(),
         note = COALESCE($3, note),
         owner_session_id = CASE WHEN $2 IN ('done','ready') THEN NULL ELSE owner_session_id END,
         lease_expires_at = CASE WHEN $2 IN ('done','ready') THEN NULL ELSE lease_expires_at END
       WHERE id=$1 RETURNING *`,
      [id, to, typeof flags.note === 'string' ? flags.note : null],
    );
    if (!rows.length) throw new Error(`no lane "${id}"`);
    await logEvent(c, {
      laneId: id, kind: to === 'done' ? 'done' : 'state_changed', sessionId: myId,
      body: `${id} -> ${to}${typeof flags.note === 'string' ? ` (${flags.note})` : ''}`,
      detail: { state: to },
    });
    return JSON_OUT ? rows[0] : `${id} -> ${to}${to === 'done' || to === 'ready' ? ' (released)' : ''}`;
  },

  async release(c) {
    positional[2] = 'ready';
    return commands.state(c);
  },

  async done(c) {
    positional[2] = 'done';
    return commands.state(c);
  },

  /** Message the branch, or one peer. This is the bus; `inbox` is the reader. */
  async say(c) {
    const myId = me();
    const body = positional.slice(1).join(' ');
    if (!body) throw new Error('usage: lane.mjs say "message" [--to <name|sid-prefix>] [--lane <id>]');
    let to = null;
    if (typeof flags.to === 'string') {
      // 1. An exact session name among recent sessions. The old half of a /clear is skipped.
      const named = [...ids()].filter(([, i]) => typeof i.name === 'string').map(([u]) => u);
      const recent = named.length ? new Set((await c.query(
        `SELECT id FROM sessions WHERE id = ANY($1) AND ${ALIVE_AT()} > now() - interval '2 hours'`, [named],
      )).rows.map((r) => r.id)) : new Set();
      const byName = resolveName(flags.to, ids(), recent);
      if (byName.length > 1) {
        throw new Error(`"${flags.to}" names ${byName.length} live sessions: ${byName.map(L).join(', ')}. Use #sid8 or the uuid prefix.`);
      }
      if (byName.length === 1) to = byName[0];
      else {
        // 2. Fall back to a uuid prefix. % _ \ are literal characters, not wildcards.
        const prefix = flags.to.replace(/^#/, '').replace(/[\\%_]/g, '\\$&');
        const m = await c.query(
          `SELECT id FROM sessions WHERE id LIKE $1 || '%' ESCAPE '\\'
           AND ${ALIVE_AT()} > now() - interval '2 hours'
           ORDER BY ${ALIVE_AT()} DESC LIMIT 2`, [prefix],
        );
        if (m.rows.length === 0) throw new Error(`no recent session matching "${flags.to}"`);
        if (m.rows.length > 1) throw new Error(`"${flags.to}" is ambiguous -- give more characters`);
        to = m.rows[0].id;
      }
    }
    await logEvent(c, {
      laneId: typeof flags.lane === 'string' ? flags.lane : null,
      kind: 'note', sessionId: myId, to, body, detail: agentDetail(),
    });
    return `sent to ${to ? L(to) : 'the branch'}${flags.lane ? ` re ${flags.lane}` : ''}`;
  },

  /**
   * Unread events for me, then advance the watermark.
   *
   * Excludes my own events -- a session does not need to be told what it just
   * did, and including them would make every action generate its own noise.
   */
  async inbox(c) {
    const myId = me();
    const { rows } = await c.query(
      `SELECT e.* FROM agentic_os.lane_event e
       WHERE e.id > COALESCE((SELECT last_event_id FROM agentic_os.lane_watermark WHERE session_id=$1),0)
         AND e.session_id <> $1
         AND (e.to_session_id IS NULL OR e.to_session_id = $1)
       ORDER BY e.id`, [myId],
    );
    if (rows.length && flags.peek !== true) {
      await c.query(
        `INSERT INTO agentic_os.lane_watermark (session_id, last_event_id, updated_at)
         VALUES ($1,$2,now())
         ON CONFLICT (session_id) DO UPDATE SET last_event_id=EXCLUDED.last_event_id, updated_at=now()`,
        [myId, rows[rows.length - 1].id],
      );
    }
    if (JSON_OUT) return rows;
    if (!rows.length) return 'inbox empty';
    return rows.map((e) => {
      const to = e.to_session_id ? L(e.to_session_id) : 'all';
      const kind = e.kind === 'note' ? '' : ` (${e.kind})`;
      return `${chicagoTime(e.occurred_at)}  ${labelWithAgent(e.session_id, ids(), e.detail?.agent)} -> ${to}${e.lane_id ? ` [${e.lane_id}]` : ''}${kind}\n     ${e.body || ''}`;
    }).join('\n');
  },

  async add(c) {
    const myId = me();
    const id = positional[1];
    if (!id || typeof flags.title !== 'string') {
      throw new Error('usage: lane.mjs add <lane-id> --title "..." [--track t] [--scope "..."] [--priority N]');
    }
    const { rows } = await c.query(
      `INSERT INTO agentic_os.lane (id,title,track,scope,branch,state,priority,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, track=EXCLUDED.track,
         scope=COALESCE(EXCLUDED.scope, agentic_os.lane.scope),
         priority=EXCLUDED.priority, updated_at=now()
       RETURNING *`,
      [id, flags.title, flags.track || 'unsorted', flags.scope || null, flags.branch || null,
       LANE_STATES.includes(flags.state) ? flags.state : 'backlog',
       Number(flags.priority) || 50, typeof flags.note === 'string' ? flags.note : null],
    );
    await logEvent(c, { laneId: id, kind: 'seeded', sessionId: myId, body: flags.title });
    return JSON_OUT ? rows[0] : `lane ${id} upserted`;
  },

  /** Bulk idempotent add from JSON. Re-running never clobbers live claims,
   *  because it only ever touches the descriptive columns. */
  async seed(c) {
    const myId = me();
    const file = positional[1];
    if (!file) throw new Error('usage: lane.mjs seed <file.json>');
    const items = JSON.parse(readFileSync(file, 'utf8'));
    let n = 0;
    for (const it of items) {
      // Deliberately asymmetric on conflict: descriptive columns are refreshed
      // from the seed, but `state`, `note` and every ownership column are NOT.
      // Re-seeding must never revert a live claim or overwrite the status line
      // the holder is currently maintaining -- the seed knows the shape of the
      // work, the session knows what is happening to it right now.
      await c.query(
        `INSERT INTO agentic_os.lane (id,title,track,scope,branch,state,priority,note,rationale,done_when)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           title=EXCLUDED.title, track=EXCLUDED.track,
           scope=COALESCE(EXCLUDED.scope, agentic_os.lane.scope),
           branch=COALESCE(EXCLUDED.branch, agentic_os.lane.branch),
           priority=EXCLUDED.priority,
           note=COALESCE(agentic_os.lane.note, EXCLUDED.note),
           rationale=COALESCE(EXCLUDED.rationale, agentic_os.lane.rationale),
           done_when=COALESCE(EXCLUDED.done_when, agentic_os.lane.done_when),
           updated_at=now()`,
        [it.id, it.title, it.track || 'unsorted', it.scope || null, it.branch || null,
         LANE_STATES.includes(it.state) ? it.state : 'backlog', it.priority ?? 50, it.note || null,
         it.rationale || null, it.doneWhen || null],
      );
      n++;
    }
    await logEvent(c, { kind: 'seeded', sessionId: myId, body: `seeded ${n} lanes from ${file}` });
    return `seeded ${n} lane(s)`;
  },

  /**
   * Carry Dave's kanban changes (order, status, notes, questions) into the lane table.
   *
   * The artifact db is reachable only through the agent's ArtifactData tool, so the
   * agent writes its content to <file> and this command applies it. All rules live in
   * the pure planner (kanban-apply.mjs). This function only does the I/O.
   *
   * One transaction, rows locked, so a half-applied board cannot exist. Events are
   * logged AFTER the commit: logEvent swallows its own errors, but a failed INSERT
   * inside a transaction would abort every later statement in it.
   *
   * --dry-run reads and plans. It opens no transaction and writes nothing.
   */
  async 'apply-kanban'(c) {
    const dry = flags['dry-run'] !== undefined && flags['dry-run'] !== false;
    // `--dry-run <file>` makes the flag parser swallow the file name as the flag value.
    const file = positional[1] ?? (typeof flags['dry-run'] === 'string' ? flags['dry-run'] : undefined);
    if (!file) throw new Error('usage: lane.mjs apply-kanban <file.json> [--dry-run] [--json]');
    let input;
    try { input = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      throw new Error(`cannot read kanban file "${file}": ${e.message}`);
    }
    // A file in the wrong shape would plan zero actions and look like "nothing changed".
    if (!input?.board?.columns && !(Array.isArray(input?.cards) && input.cards.length)) {
      throw new Error(`"${file}" has no board.columns and no cards. Expected { board: {columns, updatedAt}, cards: [...] }`);
    }
    const myId = dry ? null : me();
    const readAt = Date.parse(input?.readAt);
    const syncedAt = new Date(Number.isNaN(readAt) ? Date.now() : readAt).toISOString();

    let plan;
    if (dry) {
      plan = planKanban(input, (await c.query(KANBAN_LANES)).rows);
    } else {
      await c.query('BEGIN');
      try {
        const lanes = (await c.query(`${KANBAN_LANES} FOR UPDATE OF l`)).rows;
        plan = planKanban(input, lanes);
        for (const a of plan.actions) await applyKanbanAction(c, a);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      }
      for (const a of plan.actions) {
        await logEvent(c, {
          laneId: a.laneId, kind: 'kanban', sessionId: myId,
          body: a.kind === 'note' ? a.to : `${a.laneId} ${a.kind} ${a.from ?? '(none)'} -> ${a.to}`,
          detail: { kind: a.kind, from: a.from, to: a.to, text: a.text },
        });
      }
    }

    const count = (k) => plan.actions.filter((a) => a.kind === k).length;
    const summary = { priority: count('priority'), state: count('state'), note: count('note'), skipped: plan.skipped.length };
    const line = `kanban${dry ? ' (dry run, nothing written)' : ''}: ${summary.priority} priority, ${summary.state} state, ${summary.note} notes, ${summary.skipped} skipped`;
    if (JSON_OUT) {
      const results = plan.results.map((r) => (r.applied && !dry ? { ...r, syncedAt } : r));
      return { dryRun: dry, summary, syncedAt, appliedColumns: plan.appliedColumns, boardDone: plan.boardDone, actions: plan.actions, results, skipped: plan.skipped };
    }
    const clip = (v) => String(v ?? '(none)').replace(/\s+/g, ' ').slice(0, 70);
    return [
      line,
      ...plan.actions.map((a) => `  ${a.laneId.padEnd(28)} ${a.kind.padEnd(8)} ${clip(a.from)} -> ${clip(a.to)}`),
      ...plan.skipped.map((k) => `  ${k.laneId.padEnd(28)} skipped  ${k.reason}`),
    ].join('\n');
  },
};

/**
 * The lanes the kanban planner sees. `held` is NOT RECLAIMABLE: a live session owns the
 * lane, so a card or column must not change its state. Same predicate as claim and next.
 */
const KANBAN_LANES = `SELECT l.id, l.state, l.priority, l.note, NOT ${RECLAIMABLE} AS held FROM agentic_os.lane l`;

/** One planned action as one UPDATE. The state SQL mirrors the `state` command: done and ready release the lane. */
async function applyKanbanAction(c, a) {
  const sql = {
    priority: `UPDATE agentic_os.lane SET priority=$2, updated_at=now() WHERE id=$1`,
    note: `UPDATE agentic_os.lane SET note=$2, updated_at=now() WHERE id=$1`,
    state: `UPDATE agentic_os.lane SET state=$2, updated_at=now(),
              owner_session_id = CASE WHEN $2 IN ('done','ready') THEN NULL ELSE owner_session_id END,
              lease_expires_at = CASE WHEN $2 IN ('done','ready') THEN NULL ELSE lease_expires_at END
            WHERE id=$1`,
  }[a.kind];
  if (!sql) throw new Error(`unknown kanban action kind "${a.kind}"`);
  const { rowCount } = await c.query(sql, [a.laneId, a.to]);
  if (rowCount !== 1) throw new Error(`kanban action on "${a.laneId}" matched ${rowCount} rows`);
}
// ---------------------------------------------------------------- main

const cmd = positional[0] || 'board';
if (!commands[cmd]) {
  process.stderr.write(`unknown command "${cmd}". Known: ${Object.keys(commands).join(', ')}\n`);
  process.exit(2);
}

try {
  const result = await withDb((c) => commands[cmd](c));
  process.stdout.write((JSON_OUT ? JSON.stringify(result, null, 2) : String(result)) + '\n');
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  // A denied claim is a correct, expected answer -- exit 3 so a caller can tell
  // "someone else has it" apart from "the tool broke" (exit 1).
  process.exit(e.soft ? 3 : 1);
}
