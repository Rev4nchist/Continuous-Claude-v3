// `program.mjs check --orphans`: the seat line, parked long lanes, and worker orphans (design B.7, contract point 7 cases 4 and 5). Pure.
// listOrphans({ facts, rows }) returns
//   { seat: { live, owner, since }, parked: [lane], orphans: [lane], notes: [string], exit: 0|1 }
//   lane = { id, state, branch, owner, lease, note } with raw values (owner is the full session id or null).
//   exit 1 when any orphan exists or the seat has no live holder; a parked lane alone gives 0.
// A lane is dead when `reclaimable` is true. The seat is never in the worker list. A blocked lane (the sweep) is never listed.
import { owner8, fmtTime, isProgramId, resultLine } from './board-util.mjs';

const WORK = ['active', 'review'];

const laneOf = (r) => ({ id: r.id, state: r.state, branch: r.branch, owner: r.owner_session_id, lease: r.lease_expires_at, note: r.note });

function seatOf(rows, seatId) {
  const r = rows.find((x) => x.id === seatId);
  if (!r) return { live: false, owner: null, since: null };
  const live = Boolean(r.owner_session_id) && !r.reclaimable;
  return { live, owner: r.owner_session_id ?? null, since: r.owner_session_id ? (r.owner_alive_at ?? r.updated_at) : r.updated_at };
}

export function listOrphans({ facts, rows }) {
  const dead = rows.filter((r) => r.id !== facts.seatId && isProgramId(r.id, facts) && WORK.includes(r.state) && r.reclaimable);
  const isParked = (r) => facts.longIds.includes(r.id) && r.state === 'review';
  const seat = seatOf(rows, facts.seatId);
  const orphans = dead.filter((r) => !isParked(r)).map(laneOf);
  return {
    seat, parked: dead.filter(isParked).map(laneOf), orphans,
    notes: facts.notes.filter((n) => /Long lanes/.test(n)),
    exit: orphans.length > 0 || !seat.live ? 1 : 0,
  };
}

const place = (lane) => `branch ${lane.branch ?? '-'} owner ${owner8(lane.owner)} lease ${lane.lease ? fmtTime(lane.lease) : '-'}`;

export function renderOrphans(res) {
  const seat = res.seat.live ? `seat: re-program held live by ${owner8(res.seat.owner)}` : `seat: no live holder since ${fmtTime(res.seat.since)}`;
  const lines = [seat, ...res.notes.map((n) => `NOTE ${n}`)];
  lines.push(...res.parked.map((p) => `parked: ${p.id} ${place(p)} note: ${p.note ?? '-'}`));
  lines.push(...res.orphans.map((o) => `orphan: ${o.id} ${o.state} ${place(o)} last note: ${o.note ?? '-'}`));
  lines.push(resultLine(res.orphans.length + (res.seat.live ? 0 : 1), 'orphans'));
  return lines.join('\n');
}
