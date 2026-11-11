// `program.mjs sync-board`: the plan of moves from blocked to backlog (design B.4; amendment A1). Pure: no write happens here.
//
// programSeedIdOf(events): the mark is the EARLIEST 'seeded' event whose detail has an 'edges' key (the object-form program seed).
//   A later array-form seed or a program re-seed never moves it. No such event: null.
// planSync({ model, facts, rows, edges, programSeedId, board? }) returns
//   { moves: [{ id, reason }], stays: [{ id, reason }], errors: [{ rule, id, message }], refusal: null | { exit: 3, message } }
//   moves and stays are sorted by id. The CLI exits 3 on a refusal, 1 when errors is not empty (nothing is written then either).
// Only a lane with a row, state blocked and no owner is judged. Every other row is never touched and never listed.
// The first match wins: edges-differ, held <tokens>, hand-blocked, open-dependency (moves, also before GO), then GO or waits for GO.
import { buildEdges } from './seed.mjs';
import { judgeHolds } from './holds.mjs';
import { metTable, laneIndex } from './board-util.mjs';

export function programSeedIdOf(events) {
  const ids = events
    .filter((e) => e.kind === 'seeded' && e.detail && typeof e.detail === 'object' && 'edges' in e.detail)
    .map((e) => Number(e.id));
  return ids.length ? Math.min(...ids) : null;
}

const byCodeUnit = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function groupDeps(list, laneKey, depKey) {
  const map = new Map();
  for (const x of list) map.set(x[laneKey], [...(map.get(x[laneKey]) ?? []), x[depKey]]);
  return map;
}

function refusalOf({ model, edges, programSeedId, board }) {
  if (programSeedId == null) {
    return { exit: 3, message: `refused: no program seed event on board ${board ?? '-'}; run the seed first` };
  }
  const waves = new Set(model.lanes.map((l) => l.id));
  const stored = edges.filter((e) => waves.has(e.lane_id)).length;
  if (stored === 0 && buildEdges(model).length > 0) {
    return { exit: 3, message: 'refused: no stored edges for the map lanes; run the seed first' };
  }
  return null;
}

function sameSet(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((x) => right.has(x));
}

function edgeDiff(laneId, ctx) {
  const stored = ctx.stored.get(laneId) ?? [];
  const wanted = ctx.wanted.get(laneId) ?? [];
  if (sameSet(stored, wanted)) return null;
  return `${laneId}: stored [${[...stored].sort().join(', ')}], map [${[...wanted].sort().join(', ')}]`;
}

// A block set after the program seed, by a state change or a kanban move.
function handBlocked(row, seedId) {
  const last = row.last_life;
  if (!last || !(last.id > seedId)) return false;
  if (last.kind === 'state_changed') return last.detail?.state === 'blocked';
  return last.kind === 'kanban' && last.detail?.to === 'blocked';
}

const move = (reason) => ({ kind: 'move', reason });
const stay = (reason, error = null) => ({ kind: 'stay', reason, error });

function decide(row, ctx) {
  const diff = ctx.waves.has(row.id) ? edgeDiff(row.id, ctx) : null;
  if (diff) return stay('edges-differ', { rule: 'edges-differ', id: row.id, message: diff });
  const judged = judgeHolds({ held: ctx.index.get(row.id)?.held ?? [] }, ctx.met);
  if (judged.held) return stay(`held ${judged.unmet.join(', ')}`);
  if (handBlocked(row, ctx.programSeedId)) return stay('hand-blocked');
  if (row.open_dep) return move('open-dependency');
  return ctx.facts.go ? move('no-dependency, GO') : stay('waits for GO');
}

export function planSync(input) {
  const { model, facts, rows, edges, programSeedId } = input;
  const plan = { moves: [], stays: [], errors: [], refusal: refusalOf(input) };
  if (plan.refusal) return plan;
  const ctx = {
    facts, programSeedId, met: metTable(rows), index: laneIndex(model), waves: new Set(model.lanes.map((l) => l.id)),
    stored: groupDeps(edges, 'lane_id', 'depends_on'), wanted: groupDeps(buildEdges(model), 'lane', 'dependsOn'),
  };
  for (const row of rows.filter((r) => ctx.index.has(r.id) && r.state === 'blocked' && r.owner_session_id == null)) {
    const d = decide(row, ctx);
    if (d.error) plan.errors.push(d.error);
    (d.kind === 'move' ? plan.moves : plan.stays).push({ id: row.id, reason: d.reason });
  }
  plan.moves.sort(byCodeUnit);
  plan.stays.sort(byCodeUnit);
  return plan;
}

// Plan lines. With { apply: true } the RESULT line is left to the CLI, which knows what it wrote.
export function renderSync(plan, { apply = false } = {}) {
  const lines = plan.moves.map((m) => `MOVE ${m.id} blocked -> backlog (${m.reason})`);
  lines.push(...plan.stays.map((s) => `STAY ${s.id} ${s.reason}`));
  lines.push(...plan.errors.map((e) => `FAIL ${e.rule} ${e.message}`));
  if (!apply) lines.push(`RESULT dry-run ${plan.moves.length} moves`);
  return lines.join('\n');
}
