// `program.mjs check --claims`: did any claim break the dependency gate (design B.6; amendment A1 for the floor). Pure.
// Events are the lifecycle events of the program lanes plus their 'claimed' and 'dep_override' events (EventRow[]).
//
// replayLane(events, beforeId = Infinity) returns { state, owner } after the lifecycle events with id < beforeId, in id order:
//   claimed sets state to detail.state and owner to session_id; done and state_changed set state to detail.state;
//   a kanban state event sets state to detail.to. The owner is cleared when the state becomes done or ready. Start: 'unknown'.
// checkClaims({ model, facts, rows, events, edges, programSeedId, since }) returns
//   { errors: [{ rule, id, message }], notes: [{ rule, id, message }], floor: { id, source }, limit: string }
//   Floor: only events with id > floor.id are judged. --since wins (coerced with Number); else the program seed event id;
//   else 0 with source 'none' and the note 'no program seed event; judging all claims'.
//   claim-blocked: the claim kept state blocked or done. claim-open-dep: a dependency was not met at the claim (its latest lifecycle
//   event before the claim is not a done with a 40-hex merged SHA). Reclaim (state active or review, owner kept): a note, no test.
//   dep-override: any such event. two-re-lanes: one owner holds re- lanes on two cap units (the seat has no exemption).
import { unitKey } from './pack.mjs';
import { isProgramId, owner8, resultLine } from './board-util.mjs';

const MERGED = /^[0-9a-f]{40}$/;
const BAD_STATES = ['blocked', 'done'];
const LIMIT = 'claim-not-ready (a claim that ready did not print) cannot be rebuilt: the cap, the Owns state and the slot at claim time are not stored.';
const byId = (a, b) => a.id - b.id;
const item = (rule, id, message) => ({ rule, id, message });

const isLifecycle = (e) => e.kind === 'done' || e.kind === 'state_changed' || (e.kind === 'kanban' && e.detail?.kind === 'state');
const stateAfter = (e) => (e.kind === 'kanban' ? e.detail?.to : e.detail?.state);

function step(cur, e) {
  if (e.kind === 'claimed') return { state: e.detail?.state ?? cur.state, owner: e.session_id ?? null };
  if (!isLifecycle(e)) return cur;
  const state = stateAfter(e) ?? cur.state;
  return { state, owner: state === 'done' || state === 'ready' ? null : cur.owner };
}

export function replayLane(events, beforeId = Infinity) {
  let cur = { state: 'unknown', owner: null };
  for (const e of [...events].sort(byId)) {
    if (e.id >= beforeId) break;
    cur = step(cur, e);
  }
  return cur;
}

// Met at a point in time: the latest lifecycle event with id < beforeId is a done with a 40-hex merged SHA.
function metBefore(events, beforeId) {
  const life = events.filter((e) => isLifecycle(e) && e.id < beforeId).sort(byId).at(-1);
  return life?.kind === 'done' && MERGED.test(life.detail?.merged ?? '');
}

// A --since that is not a whole event id throws: NaN would compare false and judge nothing, a silent pass. The CLI checks it first (exit 2).
function floorOf(programSeedId, since) {
  if (since != null) {
    if (!Number.isInteger(Number(since)) || Number(since) < 0 || String(since).trim() === '') throw new RangeError(`--since must be a whole event id, got '${since}'`);
    return { id: Number(since), source: '--since' };
  }
  if (programSeedId != null) return { id: Number(programSeedId), source: 'program seed' };
  return { id: 0, source: 'none' };
}

function judgeClaim(c, ctx, out) {
  const own = ctx.byLane.get(c.lane_id) ?? [];
  const before = replayLane(own, c.id);
  const bad = [c.detail?.state, before.state].find((s) => BAD_STATES.includes(s));
  if (bad) return out.errors.push(item('claim-blocked', c.lane_id, `${c.lane_id} event ${c.id} state ${bad}`));
  if (['active', 'review'].includes(before.state) && before.owner) {
    return out.notes.push(item('reclaim', c.lane_id, `${c.lane_id} ${c.id}`));
  }
  for (const dep of ctx.deps.get(c.lane_id) ?? []) {
    if (!metBefore(ctx.byLane.get(dep) ?? [], c.id)) {
      out.errors.push(item('claim-open-dep', c.lane_id, `${c.lane_id} event ${c.id} waits on ${dep}`));
    }
  }
  return null;
}

function twoLaneRules(rows, packs, out) {
  const byOwner = new Map();
  for (const r of rows.filter((x) => x.id.startsWith('re-') && x.state !== 'done' && x.owner_session_id)) {
    byOwner.set(r.owner_session_id, [...(byOwner.get(r.owner_session_id) ?? []), r]);
  }
  for (const [owner, held] of byOwner) {
    if (new Set(held.map((r) => unitKey(r, packs))).size > 1) {
      out.errors.push(item('two-re-lanes', null, `${owner8(owner)}: ${held.map((r) => r.id).join(', ')}`));
    }
  }
}

function groupBy(list, key) {
  const map = new Map();
  for (const x of list) map.set(x[key], [...(map.get(x[key]) ?? []), x]);
  return map;
}

export function checkClaims({ model, facts, rows, events, edges, programSeedId = null, since = null }) {
  const floor = floorOf(programSeedId, since);
  const out = { errors: [], notes: [], floor, limit: LIMIT };
  if (floor.source === 'none') out.notes.push(item(null, null, 'no program seed event; judging all claims'));
  const ctx = {
    byLane: groupBy(events, 'lane_id'),
    deps: new Map([...groupBy(edges, 'lane_id')].map(([lane, list]) => [lane, list.map((e) => e.depends_on)])),
  };
  const judged = [...events].sort(byId).filter((e) => e.id > floor.id && isProgramId(e.lane_id ?? '', facts));
  for (const e of judged) {
    if (e.kind === 'claimed') judgeClaim(e, ctx, out);
    if (e.kind === 'dep_override') out.errors.push(item('dep-override', e.lane_id, `${e.lane_id} event ${e.id}`));
  }
  twoLaneRules(rows, model.packs ?? [], out);
  return out;
}

export function renderClaims(res) {
  const lines = [`floor: event ${res.floor.id} (${res.floor.source})`];
  lines.push(...res.notes.map((n) => `NOTE ${[n.rule, n.message].filter(Boolean).join(' ')}`));
  lines.push(...res.errors.map((e) => `FAIL ${e.rule} ${e.message}`));
  lines.push(`NOTE ${res.limit}`);
  lines.push(resultLine(res.errors.length));
  return lines.join('\n');
}
