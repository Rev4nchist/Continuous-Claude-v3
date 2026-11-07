/**
 * dm-delivery-probe — the gate for mid-turn direct-message delivery.
 *
 * The unit tests in `.claude/hooks/src/__tests__/lane-context-dm.test.ts` cover
 * the throttle and the non-consuming invariant textually. Neither of them proves
 * the thing that matters: that a message SENT by one session actually ARRIVES in
 * another session's tool-call context. That needs a real database, a real event
 * and the real built hook, which is this file.
 *
 * Run it after ANY change to the lane-context DM path, against a built dist:
 *
 *   node scripts/coordination/dm-delivery-probe.mjs
 *
 * Six assertions, in the order they can fail:
 *   1. DELIVERED   — a direct message reaches a PostToolUse invocation
 *   2. LABELLED    — the injection echoes hookEventName PostToolUse, or the
 *                    harness has no reason to honour it
 *   3. NON-CONSUMING — the database watermark did NOT move, so the prompt path
 *                    still owes the session a durable copy. This is the one that
 *                    protects against silent loss via a subagent
 *   4. THROTTLED   — an immediate second call is silent and costs no query
 *   5. NOT-BROADCAST — a branch-wide note is NOT delivered on this path
 *   6. ONCE-ACROSS-BOARDS — a DM sent from board A to a session that reads its inbox
 *                    on board B and then on board A shows exactly once (premortem T4).
 *                    This one runs the real `lane.mjs inbox`, not the hook. It needs
 *                    migration 0004; a database without it gets a SKIP line.
 *
 * It cleans up every row it writes, including on failure.
 */

import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { requireDep } from '../lib/resolve-deps.mjs';
import { jsonArrayOf, laneEnv, makeBoards } from './probe-boards.mjs';

const run = promisify(execFile);

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `pg` lives in the hooks bundle or in apps/agentic-os of this checkout or the primary (scripts/lib/resolve-deps.mjs). */
let pg;
try { pg = requireDep('pg', { repoRoot: REPO }); } catch (e) { console.error(`dm-delivery-probe: ${e.message}`); process.exit(2); }

const dmFile = (sid) => join(tmpdir(), `claude-lane-dm-${sid}.json`);
const clearThrottle = (sid) => { try { rmSync(dmFile(sid), { force: true }); } catch { /* fine */ } };

const LANE = join(REPO, 'scripts', 'coordination', 'lane.mjs');
const HOOK = process.env.DM_PROBE_HOOK
  || join(homedir(), '.claude', 'hooks', 'dist', 'lane-context.mjs');

const CONN = process.env.CONTINUOUS_CLAUDE_DB_URL
  || process.env.DATABASE_URL
  || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude';

const RECEIVER = `probe-recv-${process.pid}`;
const SENDER = `probe-send-${process.pid}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};

/** Invoke the built hook exactly as Claude Code does: JSON on stdin. */
async function fireHook(event, sessionId, extra = {}, env = process.env) {
  const child = run(process.execPath, [HOOK], { timeout: 15_000, env });
  child.child.stdin.end(JSON.stringify({
    session_id: sessionId,
    hook_event_name: event,
    tool_name: 'Read',
    ...extra,
  }));
  const { stdout } = await child;
  return stdout.trim();
}

const skip = (name, why) => process.stdout.write(`SKIP  ${name} — ${why}
`);

/** Run the real lane.mjs as `as` from `cwd`, against the probe's own database and temp registry. */
async function lane(bx, cwd, as, args) {
  try {
    const { stdout } = await run(process.execPath, [LANE, ...args], { cwd, env: laneEnv(CONN, bx, { CLAUDE_CODE_SESSION_ID: as }), timeout: 30_000 });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    return { code: e.code ?? 1, out: String(e.stdout ?? ''), err: String(e.stderr ?? e.message) };
  }
}

const injected = (out) => {
  try {
    const j = JSON.parse(out || '{}');
    return j.hookSpecificOutput || null;
  } catch { return null; }
};

async function main() {
  if (!existsSync(HOOK)) {
    process.stderr.write(`hook not built: ${HOOK}\n  cd .claude/hooks && npm run build\n`);
    process.exit(2);
  }

  const c = new pg.Client({ connectionString: CONN, connectionTimeoutMillis: 4000 });
  await c.connect();

  let dmId = null;
  let boards = null;
  try {
    // A direct message from SENDER to RECEIVER. `to_session_id` is what makes it
    // eligible for this path at all.
    dmId = (await c.query(
      `INSERT INTO agentic_os.lane_event (kind, session_id, to_session_id, body)
       VALUES ('note', $1, $2, $3) RETURNING id`,
      [SENDER, RECEIVER, 'PROBE-DM: stop editing lane-context.ts, I hold it'],
    )).rows[0].id;

    // 1 + 2
    const out1 = await fireHook('PostToolUse', RECEIVER);
    const inj = injected(out1);
    check('DELIVERED: direct message reaches a PostToolUse invocation',
      !!inj && inj.additionalContext.includes('PROBE-DM'),
      inj ? '' : `got: ${out1.slice(0, 120)}`);
    check('LABELLED: injection echoes hookEventName PostToolUse',
      !!inj && inj.hookEventName === 'PostToolUse',
      inj ? `got ${inj.hookEventName}` : 'no injection');

    // 3 — the invariant that protects against silent loss.
    const wm = (await c.query(
      'SELECT last_event_id FROM agentic_os.lane_watermark WHERE session_id=$1', [RECEIVER],
    )).rows[0];
    check('NON-CONSUMING: database watermark did not move',
      !wm || Number(wm.last_event_id) < Number(dmId),
      wm ? `watermark=${wm.last_event_id} dm=${dmId}` : 'no watermark row (correct)');

    // 4 — the cost guard. Immediately after a delivery, silence.
    const out2 = await fireHook('PostToolUse', RECEIVER);
    check('THROTTLED: an immediate second call is silent',
      out2 === '{}', `got: ${out2.slice(0, 80)}`);

    // 5 — a broadcast must NOT interrupt every tool call in every session.
    await c.query(
      `INSERT INTO agentic_os.lane_event (kind, session_id, to_session_id, body)
       VALUES ('note', $1, NULL, $2)`,
      [SENDER, 'PROBE-BROADCAST: this must not arrive mid-turn'],
    );
    // Clear the throttle AND the DM row so the only reason for silence is the
    // broadcast filter itself, not leftover state from assertion 1.
    await c.query('DELETE FROM agentic_os.lane_event WHERE id=$1', [dmId]);
    await c.query('DELETE FROM agentic_os.lane_watermark WHERE session_id=$1', [RECEIVER]);
    clearThrottle(RECEIVER);
    const out3 = await fireHook('PostToolUse', RECEIVER);
    const inj3 = injected(out3);
    check('NOT-BROADCAST: a branch-wide note is not delivered mid-turn',
      !inj3 || !inj3.additionalContext.includes('PROBE-BROADCAST'),
      inj3 ? 'broadcast leaked into the mid-turn path' : '');

    // 6 — T4. Last on purpose: the board reads write `<id>@<board>` watermark rows, which
    // cases 1 to 5 must not see.
    const migrated = Number((await c.query(
      `SELECT count(*) AS n FROM information_schema.columns
        WHERE table_schema='agentic_os' AND table_name='lane_event' AND column_name='project_key'`)).rows[0].n) === 1;
    if (!migrated) {
      skip('ONCE-ACROSS-BOARDS: a DM shows once across two boards', 'migration 0004 is not applied to this database');
    } else {
      boards = makeBoards('zz-dmprobe', ['a', 'b']);
      const { a, b } = boards.boards;
      await c.query(
        `INSERT INTO sessions (id, project, working_on, last_heartbeat) VALUES ($1, $2, 'dm-delivery-probe fixture', now())`,
        [RECEIVER, b.norm]);
      const body = 'PROBE-XBOARD-DM: shows once';
      const sent = await lane(boards, a.dir, SENDER, ['say', body, '--to', RECEIVER]);
      // The hook runs in the same env as lane.mjs: this DB, the temp registry. Positive control first, so the silence below is not vacuous.
      const hookEnv = laneEnv(CONN, boards, {});
      clearThrottle(RECEIVER);
      const midBefore = injected(await fireHook('PostToolUse', RECEIVER, {}, hookEnv));
      check('ONCE-ACROSS-BOARDS (hook): before any read, the mid-turn hook shows the board-A DM',
        !!midBefore && midBefore.additionalContext.includes(body) && midBefore.additionalContext.includes('[from zz-dmprobe-a]'),
        midBefore ? '' : 'no injection');
      const readB = await lane(boards, b.dir, RECEIVER, ['inbox', '--json']);
      const readA = await lane(boards, a.dir, RECEIVER, ['inbox', '--json']);
      // A read that failed or returned junk is null, never []: an empty A read proves "absent" only when it ran.
      const rowsOf = (r) => jsonArrayOf(r)?.filter((e) => e.body === body) ?? null;
      const inB = rowsOf(readB);
      const inA = rowsOf(readA);
      check('ONCE-ACROSS-BOARDS: a DM from board A shows once across a read on B then on A',
        sent.code === 0 && !!inB && !!inA && inB.length === 1 && inB[0].project_key === a.key && inA.length === 0,
        `say exit ${sent.code}; read on B exit ${readB.code} saw ${inB ? inB.length : 'invalid output'}, read on A exit ${readA.code} saw ${inA ? inA.length : 'invalid output'} (want 1 then 0)${sent.code ? `: ${sent.err.trim().split(/\r?\n/)[0]}` : ''}`);
      // Hook path (T4): the read on B wrote `<id>@zz-dmprobe-b`. The hook must take the highest of the bare row and every `<id>@<board>` row.
      clearThrottle(RECEIVER);
      const midAfter = injected(await fireHook('PostToolUse', RECEIVER, {}, hookEnv));
      check('ONCE-ACROSS-BOARDS (hook, mid-turn): after the read on B the hook does not show the DM again',
        !midAfter || !midAfter.additionalContext.includes(body),
        midAfter ? 'the DM was shown again' : '');
      const promptA = injected(await fireHook('UserPromptSubmit', RECEIVER, { cwd: a.dir }, hookEnv));
      check('ONCE-ACROSS-BOARDS (hook, prompt): the prompt hook on board A does not show the DM again',
        !promptA || !promptA.additionalContext.includes(body),
        promptA ? 'the DM was shown again' : '');
    }
  } finally {
    await c.query('DELETE FROM agentic_os.lane_event WHERE session_id=$1', [SENDER]).catch(() => {});
    await c.query(
      `DELETE FROM agentic_os.lane_watermark WHERE session_id=$1 OR starts_with(session_id, $1 || '@')`, [RECEIVER]).catch(() => {});
    await c.query('DELETE FROM sessions WHERE id=$1', [RECEIVER]).catch(() => {});
    boards?.cleanup();
    await c.end().catch(() => {});
    clearThrottle(RECEIVER);
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { process.stderr.write(`probe error: ${e.message}\n`); process.exit(2); });
