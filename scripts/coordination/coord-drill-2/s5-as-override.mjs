/**
 * coord-drill-2 / row 5 -- rule L2.10: only the holder changes a held lane.
 * Gap: any session may pass --override (state, release, done) or --as <holder> and change a lane
 * that a live session holds. PASS = all three probes are refused (state --override, --as <holder>,
 * release --override). FAIL = at least one changed the lane.
 * ERROR = the harness or the positive control is broken. A refusal is exit 4 AND a
 * "REFUSED <verb> <id> [token]" line; any other non-zero exit is a fault, never a refusal.
 */
import { randomUUID } from 'node:crypto';
import { lane, track, insertSession, insertLane, result } from './lib.mjs';

export const meta = {
  id: '5',
  title: 'A session cannot change a lane that a live session holds, by --override or by --as',
  rule: 'L2.10',
};

const NOTE_START = 'drill-initial-note';
const NOTE_PROBE = 'drill-as';
// The one shape of a rule refusal (lane.mjs:546-549): exit 4 and a line "REFUSED <verb> <id> [token] -- text".
// Any other non-zero exit (usage error, db timeout, missing migration) is a fault, never a refusal.
const REFUSED_LINE_RE = /^REFUSED \S+ \S+ \[[a-z-]+\]/m;
const isRefusal = (r) => r.code === 4 && REFUSED_LINE_RE.test(r.err);

const clip = (s) => String(s ?? '').slice(0, 200);
const call = (r) => ({ code: r.code, stdout: clip(r.out), stderr: clip(r.err) });
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The three columns the rule protects. */
async function snap(ctx, laneId) {
  return ctx.pg(async (c) => (await c.query(
    `SELECT state, owner_session_id AS owner, note FROM agentic_os.lane WHERE id = $1`, [laneId],
  )).rows[0]);
}

/** Put the lane back to its start values, so the second probe starts from the same row as the first. */
async function reset(ctx, laneId, A) {
  await ctx.pg((c) => c.query(
    `UPDATE agentic_os.lane SET state = 'active', owner_session_id = $2, note = $3,
            lease_expires_at = now() + interval '30 minutes' WHERE id = $1`, [laneId, A, NOTE_START],
  ));
}

const same = (a, b) => a.state === b.state && a.owner === b.owner && a.note === b.note;

/** Make the lane, the two live sessions and return the ids. A holds the lane with a live lease. */
async function setup(ctx) {
  const A = randomUUID();
  const B = randomUUID();
  const laneId = `zz-d5-${slug(ctx.runId)}`;
  const project = ctx.sandbox.projectDir.replace(/\\/g, '/');
  await ctx.pg(async (c) => {
    await insertSession(c, A, project);
    await insertSession(c, B, project);
    await insertLane(c, { id: laneId, title: 'drill row 5', state: 'active', owner: A, leaseMinutes: 30, projectKey: ctx.sandbox.boardKey });
    await c.query(`UPDATE agentic_os.lane SET note = $2 WHERE id = $1`, [laneId, NOTE_START]);
  });
  track(ctx, 'session', A); track(ctx, 'session', B); track(ctx, 'lane', laneId);
  return { A, B, laneId };
}

/** The control: a plain stranger is refused and the row stays. Without it, "refused" proves nothing. */
async function control(ctx, { A, B, laneId }, start) {
  const st = lane(ctx, ['state', laneId, 'review'], B);
  const nt = lane(ctx, ['note', laneId, 'drill-ctl'], B);
  const after = await snap(ctx, laneId);
  const ok = st.code === 4 && /\[not-holder\]/.test(st.err) && nt.code === 4 && /\[not-holder\]/.test(nt.err) && same(start, after);
  const detail = `state as B: exit ${st.code}, [not-holder] ${/\[not-holder\]/.test(st.err)}; note as B: exit ${nt.code}, [not-holder] ${/\[not-holder\]/.test(nt.err)}; row unchanged ${same(start, after)}`;
  return { name: 'a stranger is refused with [not-holder] (exit 4) and the lane row stays', ok, detail, evidence: { state: call(st), note: call(nt), lane: after } };
}

/**
 * One probe. changed = the row differs from the start row. refused = exit 4, a REFUSED line and the
 * row unchanged. Anything else (any other non-zero exit, or exit 0 with no change) is a fault.
 */
async function judge(ctx, laneId, start, r) {
  const after = await snap(ctx, laneId);
  const changed = !same(start, after);
  const refused = !changed && isRefusal(r);
  return { fault: !changed && !refused, refused, changed, evidence: { ...call(r), lane: after } };
}

export async function run(ctx) {
  const ids = await setup(ctx);
  const { A, B, laneId } = ids;
  const start = await snap(ctx, laneId);
  const ctl = await control(ctx, ids, start);
  const base = { id: meta.id, title: meta.title, rule: meta.rule };
  const ctlRow = { name: ctl.name, ok: ctl.ok, detail: ctl.detail };
  if (!ctl.ok) {
    return result({ ...base, verdict: 'ERROR', reason: 'the positive control failed, so the probes mean nothing', control: ctlRow, evidence: { control: ctl.evidence } });
  }

  // Probe 1: B passes --override with a reason.
  const p1 = await judge(ctx, laneId, start, lane(ctx, ['state', laneId, 'review', '--override', '--reason', 'drill'], B));
  await reset(ctx, laneId, A);

  // Probe 2: B puts A's id in --as. lane.mjs reads --as before CLAUDE_CODE_SESSION_ID, so the env says B and the flag says A.
  const env2 = { ...ctx.env, CLAUDE_CODE_SESSION_ID: B };
  const p2 = await judge(ctx, laneId, start, lane({ ...ctx, env: env2 }, ['note', laneId, NOTE_PROBE], A));
  await reset(ctx, laneId, A);

  // Probe 3: B passes --override on release, which has its own path to the same rule.
  const p3 = await judge(ctx, laneId, start, lane(ctx, ['release', laneId, '--override', '--reason', 'drill'], B));
  await reset(ctx, laneId, A);

  const evidence = { control: ctl.evidence, probe1_override: p1.evidence, probe2_as_holder: p2.evidence, probe3_release_override: p3.evidence };
  const probes = [['state --override', p1], ['--as <holder>', p2], ['release --override', p3]];
  // A probe that changed the lane is a FAIL even when another probe faulted: the gap is open.
  const opened = probes.filter(([, p]) => p.changed).map(([n]) => n);
  const bad = probes.filter(([, p]) => p.fault);
  if (opened.length === 0 && bad.length) {
    return result({ ...base, verdict: 'ERROR', reason: `${bad.map(([n]) => n).join(' and ')}: no change, and no exit 4 with a "REFUSED <verb> <id> [token]" line, so a fault and not a refusal`, control: ctlRow, evidence });
  }
  if (opened.length === 0) return result({ ...base, verdict: 'PASS', reason: 'state --override, --as <holder> and release --override were all refused (exit 4, REFUSED line) and the lane did not change', control: ctlRow, evidence });
  return result({ ...base, verdict: 'FAIL', reason: `a stranger changed a held lane with ${opened.join(' and ')}`, control: ctlRow, evidence });
}
