/**
 * coord-drill-2 / row 7 -- rules M4.12 and L2.9: a peer can always reach the holder of a lane.
 * Gap: `say --to <name>` only finds sessions alive in the last 2 hours. A holder that parked its
 * lane and went quiet is still the holder (the park keeps the lease), but the message fails with
 * 'no recent session matching' and names no other way to reach them.
 * PASS = the message is delivered, or the refusal names a fallback. FAIL = refused with the known
 * 'no recent session matching' text and no fallback named. ERROR = the harness or the positive control
 * is broken, or say exited 0 with no event addressed to A (a setup fault, not a refusal).
 */
import { randomUUID } from 'node:crypto';
import { lane, track, writeIdentity, insertSession, insertLane, result } from './lib.mjs';

export const meta = {
  id: '7',
  title: 'A message to the holder of a parked lane is delivered, or names a way to reach them',
  rule: 'M4.12/L2.9',
};

// The words that name another channel in a refusal. The fix card may change the wording of the
// refusal; when it does, it also updates this constant in the same change.
const FALLBACK_RE = /SendMessage|lane note|inbox --id|ask Dave/i;
// A refusal that is really a setup fault. It must never count as the gap.
const HARNESS_FAULT_RE = /usage: lane\.mjs|no session id|unknown board|migration \d+ is not applied|ECONNREFUSED|ENOENT|TypeError|ReferenceError|ambiguous|not confirmed|timeout|timed out|password authentication/i;
// The one refusal that is the gap (lane.mjs:1194).
const NO_RECENT_RE = /no recent session matching/i;

const clip = (s) => String(s ?? '').slice(0, 200);
const call = (r) => ({ code: r.code, stdout: clip(r.out), stderr: clip(r.err) });
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Events that carry a message to A: kind note, addressed to A. */
const countTo = (ctx, A) => ctx.pg(async (c) => (await c.query(
  `SELECT count(*)::int AS n FROM agentic_os.lane_event WHERE to_session_id = $1 AND kind = 'note'`, [A],
)).rows[0].n);

/** A holds a live lane and has a name; B is live too. */
async function setup(ctx) {
  const A = randomUUID();
  const B = randomUUID();
  const name = `drill-holder-${slug(ctx.runId)}`;
  const laneId = `zz-d7-${slug(ctx.runId)}`;
  const project = ctx.sandbox.projectDir.replace(/\\/g, '/');
  await ctx.pg(async (c) => {
    await insertSession(c, A, project);
    await insertSession(c, B, project);
    await insertLane(c, { id: laneId, title: 'drill row 7', state: 'active', owner: A, leaseMinutes: 30, projectKey: ctx.sandbox.boardKey });
  });
  writeIdentity(ctx, A, name);
  track(ctx, 'session', A); track(ctx, 'session', B); track(ctx, 'lane', laneId);
  return { A, B, name, laneId };
}

/** Age A past the 2 hour window. GREATEST ignores NULL, so a NULL activity time leaves only the old heartbeat. */
const ageHolder = (ctx, A) => ctx.pg((c) => c.query(
  `UPDATE public.sessions SET last_heartbeat = now() - interval '3 hours', last_activity_at = NULL WHERE id = $1`, [A],
));

const say = (ctx, B, name) => lane(ctx, ['say', 'drill ping', '--to', name], B);

export async function run(ctx) {
  const { A, B, name, laneId } = await setup(ctx);
  const base = { id: meta.id, title: meta.title, rule: meta.rule };

  // Control: while A is live, the same say works. This proves the name, the identity file and B's call are right.
  const first = say(ctx, B, name);
  const n1 = await countTo(ctx, A);
  const ctl = {
    name: 'a say to the live holder prints "sent to" and writes an event addressed to A',
    ok: first.code === 0 && /sent to/.test(first.out) && n1 === 1,
    detail: `exit ${first.code}; "sent to" ${/sent to/.test(first.out)}; events to A ${n1} (expected 1)`,
  };
  if (!ctl.ok) return result({ ...base, verdict: 'ERROR', reason: 'the positive control failed, so the probe means nothing', control: ctl, evidence: { control: call(first), eventsToA: n1 } });

  // Park: the holder keeps the lane, the lease moves out to the end time.
  const park = lane(ctx, ['park', laneId, '--for', '2h', '--reason', 'drill'], A);
  if (park.code !== 0) {
    const bad = { name: 'A parks the lane (exit 0)', ok: false, detail: `park exit ${park.code}: ${clip(park.err)}` };
    return result({ ...base, verdict: 'ERROR', reason: 'the park step failed', control: bad, evidence: { control: call(first), park: call(park) } });
  }

  // A must still hold the lane with a live lease after the park, or the premise of the row is gone.
  const held = await ctx.pg(async (c) => (await c.query(
    `SELECT owner_session_id AS owner, (lease_expires_at > now()) AS live FROM agentic_os.lane WHERE id = $1`, [laneId],
  )).rows[0]);
  if (!held || held.owner !== A || held.live !== true) {
    const bad = { name: 'A still holds the lane with a live lease after the park', ok: false, detail: `owner ${held?.owner ?? '(no row)'} (expected ${A}); lease live ${held?.live}` };
    return result({ ...base, verdict: 'ERROR', reason: 'after the park A does not hold the lane with a live lease, so the row cannot test a parked holder', control: bad, evidence: { control: call(first), park: call(park), held } });
  }

  await ageHolder(ctx, A);
  const second = say(ctx, B, name);
  const n2 = await countTo(ctx, A);
  const evidence = {
    control: call(first), park: call(park), sayAfterPark: call(second),
    refusalMessage: clip(second.err || second.out), eventsToA: { beforePark: n1, afterAged: n2 },
  };
  return judge({ base, ctl, second, n2, n1, evidence });
}

/** Turn the second say into a verdict. Delivery or a named fallback is PASS; a refusal with neither is FAIL. */
function judge({ base, ctl, second, n1, n2, evidence }) {
  const text = `${second.err}\n${second.out}`;
  if (second.code === 0 && n2 > n1) return result({ ...base, verdict: 'PASS', reason: 'the message reached the parked holder (a second event is addressed to A)', control: ctl, evidence });
  // Exit 0 and no event to A is not the known gap (a refusal). say may have resolved the name to another session: a setup fault.
  if (second.code === 0) return result({ ...base, verdict: 'ERROR', reason: `say exited 0 but no event addressed to A was written (events to A ${n1} -> ${n2}): not the known refusal, so a setup fault and not the gap`, control: ctl, evidence });
  // The fault check runs before the fallback match: a fault text that holds "lane note" must not read PASS.
  if (!second.err.trim() || HARNESS_FAULT_RE.test(text)) {
    return result({ ...base, verdict: 'ERROR', reason: 'the second say failed with a setup fault or no message, not the known refusal', control: ctl, evidence });
  }
  if (FALLBACK_RE.test(text)) return result({ ...base, verdict: 'PASS', reason: 'the refusal names a fallback channel', control: ctl, evidence });
  // FAIL only for the known refusal (lane.mjs:1194). Any other non-zero exit is not the gap.
  if (NO_RECENT_RE.test(second.err)) {
    return result({ ...base, verdict: 'FAIL', reason: `say refused (exit ${second.code}) with 'no recent session matching' and named no fallback: ${clip(second.err).trim()}`, control: ctl, evidence });
  }
  return result({ ...base, verdict: 'ERROR', reason: `the second say exited ${second.code} with a message that is not the known refusal: ${clip(second.err).trim()}`, control: ctl, evidence });
}
