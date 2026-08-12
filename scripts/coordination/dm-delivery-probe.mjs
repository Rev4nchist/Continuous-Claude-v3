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
 * Five assertions, in the order they can fail:
 *   1. DELIVERED   — a direct message reaches a PostToolUse invocation
 *   2. LABELLED    — the injection echoes hookEventName PostToolUse, or the
 *                    harness has no reason to honour it
 *   3. NON-CONSUMING — the database watermark did NOT move, so the prompt path
 *                    still owes the session a durable copy. This is the one that
 *                    protects against silent loss via a subagent
 *   4. THROTTLED   — an immediate second call is silent and costs no query
 *   5. NOT-BROADCAST — a branch-wide note is NOT delivered on this path
 *
 * It cleans up every row it writes, including on failure.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Same resolution rule as lane.mjs: `pg` lives in the hooks bundle or in
 *  apps/agentic-os, never at the repo root. Do not add a third copy. */
function loadPg() {
  for (const anchor of [
    join(REPO, '.claude', 'hooks', 'package.json'),
    join(REPO, 'apps', 'agentic-os', 'package.json'),
  ]) {
    try { return createRequire(pathToFileURL(anchor)).call(null, 'pg'); } catch { /* next */ }
  }
  throw new Error('cannot resolve `pg`. Looked in .claude/hooks and apps/agentic-os.');
}
const pg = loadPg();

const dmFile = (sid) => join(tmpdir(), `claude-lane-dm-${sid}.json`);
const clearThrottle = (sid) => { try { rmSync(dmFile(sid), { force: true }); } catch { /* fine */ } };

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
async function fireHook(event, sessionId) {
  const child = run(process.execPath, [HOOK], { timeout: 15_000 });
  child.child.stdin.end(JSON.stringify({
    session_id: sessionId,
    hook_event_name: event,
    tool_name: 'Read',
  }));
  const { stdout } = await child;
  return stdout.trim();
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
  } finally {
    await c.query('DELETE FROM agentic_os.lane_event WHERE session_id=$1', [SENDER]).catch(() => {});
    await c.query('DELETE FROM agentic_os.lane_watermark WHERE session_id=$1', [RECEIVER]).catch(() => {});
    await c.end().catch(() => {});
    clearThrottle(RECEIVER);
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { process.stderr.write(`probe error: ${e.message}\n`); process.exit(2); });
