// Seed items and edges built from a parsed map. Pure: no I/O.
// Item fields follow the lane.mjs seed verb (scripts/coordination/lane.mjs):
//   top-level array (:538), id must match BOARD_KEY_RE (:178, :540), project must equal the board (:541),
//   fields read: id, title, track, scope, branch, state, note, rationale, doneWhen (:1517-1519),
//   state must be one of LANE_STATES (:132), and band and priority are left out so the stored rank stays (:1490).
// ctx: { sha?, ref = 'main', project = 'continuous-claude', testMode = false }.

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

function seedItem(lane, ctx) {
  const sec = lane.section;
  return {
    id: lane.id,
    title: sec?.title ?? lane.id,
    track: 'review-engine',
    scope: scopeText(sec?.owns ?? []),
    branch: `re/${lane.id}`,
    state: 'blocked',
    note: noteText(lane, ctx),
    rationale: rationaleText(lane, ctx),
    doneWhen: sec?.blocks['Done when'] ?? '',
    project: ctx.project ?? 'continuous-claude',
  };
}

// One item per Waves lane, in Waves order. Externals and dropped lanes get none.
export function seedItems(model, ctx = {}) {
  return model.lanes.map((lane) => seedItem(lane, ctx));
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
// 'array' is what lane.mjs seed accepts today. 'object' is the shape the gate-2 contract will need.
export function renderSeed(items, edges, shape = 'array') {
  if (shape === 'array') return `${JSON.stringify(items, null, 2)}\n`;
  if (shape === 'object') return `${JSON.stringify({ lanes: items, edges }, null, 2)}\n`;
  throw new Error(`renderSeed: unknown shape '${shape}' (want 'array' or 'object')`);
}
