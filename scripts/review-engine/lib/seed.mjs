// Seed items and edges built from a parsed map. Pure: no I/O.
// Item fields follow the lane.mjs seed verb (scripts/coordination/lane.mjs):
//   top-level array (:538), id must match BOARD_KEY_RE (:178, :540), project must equal the board (:541),
//   fields read: id, title, track, scope, branch, state, note, rationale, doneWhen (:1517-1519),
//   state must be one of LANE_STATES (:132). A band is never written (a band needs Dave's explicit choice).
//   priority is written only for an id in ctx.rank, so the stored rank stays for the others (:1490).
// ctx: { sha?, ref = 'main', project = 'continuous-claude', testMode = false, rank? }. rank is { id: whole number 1..999 }.
// The branch comes from the map: re/<id>, or the shared branch of a Pack line (lib/pack.mjs).
import { branchOf } from './pack.mjs';

const TEST_PREFIX = 'TEST MODE seed; ';
const MAP_PATH = 'docs/review-engine/map.md';

// A map read from a file has no commit. Then the label is 'file', never 'main@undefined'.
function mapLabel(ctx, width) {
  return ctx.sha ? `${ctx.ref ?? 'main'}@${ctx.sha.slice(0, width)}` : 'file';
}

function scopeText(owns) {
  if (owns.length === 0) return 'Owns: none';
  return `Owns: ${owns.map((e) => (e.scope ? `${e.path} (${e.scope})` : e.path)).join(', ')}`;
}

function noteText(lane, ctx) {
  const base = `seeded from map ${mapLabel(ctx, 7)}`;
  const note = lane.heldRaw ? `${base}; held: ${lane.heldRaw}` : `${base}; blocked until GO`;
  return ctx.testMode ? `${TEST_PREFIX}${note}` : note;
}

// lane.mjs seed keeps the stored note on conflict but overwrites rationale, so test mode marks both.
function rationaleText(lane, ctx) {
  const deps = lane.deps.length ? lane.deps.join(', ') : 'none';
  const text = `Wave ${lane.wave}, phase ${lane.phase}. Depends on: ${deps}. Held until: ${lane.heldRaw || 'none'}. `
    + `Needs Dave: ${lane.needsDave ? 'yes' : 'no'}. Map: ${MAP_PATH} "### ${lane.id}" at ${mapLabel(ctx, 12)}.`;
  return ctx.testMode ? `${TEST_PREFIX}${text}` : text;
}

function seedItem(lane, ctx, packs) {
  const sec = lane.section;
  const item = {
    id: lane.id,
    title: sec?.title ?? lane.id,
    track: 'review-engine',
    scope: scopeText(sec?.owns ?? []),
    branch: branchOf(lane.id, packs),
    state: 'blocked',
    note: noteText(lane, ctx),
    rationale: rationaleText(lane, ctx),
    doneWhen: sec?.blocks['Done when'] ?? '',
    project: ctx.project ?? 'continuous-claude',
  };
  if (ctx.rank && Object.hasOwn(ctx.rank, lane.id)) item.priority = ctx.rank[lane.id];
  return item;
}

// The program rule (contract point 2): every item is blocked, on track review-engine, with no band,
// and a priority only as a whole number from 1 to 999. A failure is an internal error (exit 1), never a user error.
export function assertProgramRule(items) {
  for (const it of items) {
    const bad = programRuleBreak(it);
    if (bad) throw new Error(`seed-file: program rule broken by item '${it.id}': ${bad}`);
  }
}

function programRuleBreak(it) {
  if (it.state !== 'blocked') return `state is ${JSON.stringify(it.state)}, want 'blocked'`;
  if (it.track !== 'review-engine') return `track is ${JSON.stringify(it.track)}, want 'review-engine'`;
  if ('band' in it) return 'a band key is present';
  if ('priority' in it && !(Number.isInteger(it.priority) && it.priority >= 1 && it.priority <= 999)) return `priority ${JSON.stringify(it.priority)} is not a whole number from 1 to 999`;
  return null;
}

// One item per Waves lane, in Waves order. Externals and dropped lanes get none.
export function seedItems(model, ctx = {}) {
  const items = model.lanes.map((lane) => seedItem(lane, ctx, model.packs ?? []));
  assertProgramRule(items);
  return items;
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Edges come from Depends on only. Hold tokens are not edges. Sorted by code unit, not locale.
export function buildEdges(model) {
  const edges = [];
  for (const lane of model.lanes) {
    for (const dependsOn of lane.deps) edges.push({ lane: lane.id, dependsOn });
  }
  return edges.sort((a, b) => byCodeUnit(a.lane, b.lane) || byCodeUnit(a.dependsOn, b.dependsOn));
}

// The one place that owns the output shape. Returns a JSON string.
// 'object' (the default) is the shape the gate-2 contract needs: { lanes, edges }. 'array' is what lane.mjs seed accepts today.
export function renderSeed(items, edges, shape = 'object') {
  if (shape === 'array') return `${JSON.stringify(items, null, 2)}\n`;
  if (shape === 'object') return `${JSON.stringify({ lanes: items, edges }, null, 2)}\n`;
  throw new Error(`renderSeed: unknown shape '${shape}' (want 'array' or 'object')`);
}
