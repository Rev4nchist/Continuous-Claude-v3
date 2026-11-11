// `program.mjs status`: one summary of the program on the board (design B.8). Pure. It never throws on a missing slot bullet
// or a missing decisions file, and the CLI always exits 0 for it.
// buildStatus({ model, facts, rows, decisions, board? }) returns
//   { board, go, counts: { lanes, byState }, waves: [{ wave, lanes, done, inWork, blocked }],
//     lanes: [{ id, wave, phase, state, owner, live, branch, held, waitsOn, met, spends }],
//     cap: { used, limit, units }, slot: { held, by }, nextDecisionPoint: { id, heading, open } | null }
//   decisions is parseDecisions() output or null. The cap and slot are computeCap and computeSlot of ready.mjs.
//   The CLI adds ok, verb, testMode and mapSource.
import { computeCap, computeSlot } from './ready.mjs';
import { judgeHolds, nextDecisionPoint } from './holds.mjs';
import { metTable, laneIndex, IN_WORK } from './board-util.mjs';

const STATES = ['blocked', 'backlog', 'ready', 'active', 'review', 'done', 'no card'];

function laneEntry(info, r, ctx) {
  const judged = judgeHolds({ held: info.held }, ctx.met);
  return {
    id: info.id, wave: info.wave, phase: info.phase, state: r?.state ?? 'no card', owner: r?.owner_session_id ?? null,
    live: Boolean(r?.owner_session_id) && !r.reclaimable, branch: r?.branch ?? null, held: judged.unmet, waitsOn: r?.waits_on ?? [],
    met: r?.met === true, spends: (ctx.facts.slotIds ?? []).includes(info.id),
  };
}

function countStates(lanes) {
  const byState = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const l of lanes) byState[l.state] = (byState[l.state] ?? 0) + 1;
  return byState;
}

function waveTable(lanes) {
  const waves = new Map();
  for (const l of lanes) {
    const w = waves.get(l.wave) ?? { wave: l.wave, lanes: 0, done: 0, inWork: 0, blocked: 0 };
    w.lanes += 1;
    w.done += l.state === 'done' ? 1 : 0;
    w.inWork += IN_WORK.includes(l.state) ? 1 : 0;
    w.blocked += l.state === 'blocked' ? 1 : 0;
    waves.set(l.wave, w);
  }
  return [...waves.values()].sort((a, b) => a.wave - b.wave);
}

export function buildStatus({ model, facts, rows, decisions = null, board = null }) {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const ctx = { facts, met: metTable(rows) };
  const lanes = [...laneIndex(model).values()].map((info) => laneEntry(info, rowById.get(info.id), ctx));
  return {
    board, go: facts.go, counts: { lanes: lanes.length, byState: countStates(lanes) }, waves: waveTable(lanes), lanes,
    cap: computeCap(rows, model, facts), slot: computeSlot(rows, model, facts),
    nextDecisionPoint: decisions ? nextDecisionPoint(decisions) : null,
  };
}

// The five-line text summary.
export function renderStatus(st) {
  const states = Object.entries(st.counts.byState).map(([s, n]) => `${s} ${n}`).join(', ');
  const waves = st.waves.map((w) => `${w.wave}: ${w.done}/${w.lanes} done, ${w.inWork} in work, ${w.blocked} blocked`).join('; ');
  const slot = st.slot.held ? `held by ${st.slot.by.join(', ')}` : 'free';
  const next = st.nextDecisionPoint ? `${st.nextDecisionPoint.id} (${st.nextDecisionPoint.open.length} open)` : 'none';
  return [
    `status: board ${st.board ?? '-'}, ${st.counts.lanes} lanes, program state ${st.go ? 'GO' : 'HOLD'}`,
    `states: ${states}`, `cap: ${st.cap.used}/${st.cap.limit} units, slot ${slot}`, `waves: ${waves}`, `next decision point: ${next}`,
  ].join('\n');
}
