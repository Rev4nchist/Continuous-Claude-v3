// `program.mjs check --board`: does the board match the map (design B.5, contract point 3 requests (a) and (b)). Pure.
// checkBoard({ model, facts, rows, foreign, edges, shaFiles, board? }) returns { errors, notes }, both [{ rule, id, message }].
//   rows     BoardRow[] of the board. foreign: [{ id, project_key }], map ids held by another board. edges: EdgeRow[].
//   shaFiles the first-parent file list of each landed SHA, read by the caller from git: an object or Map, sha to string[].
//            A missing key or a null value means git could not read it (not in the repo, root commit): a note, not an error.
//   board    the board key. Default: the project_key of the first row.
// A no-PR done records the main tip, not the lane's work: it gets a note and skips the shared-SHA and the Owns-file rules.
import { branchOf } from './pack.mjs';
import { ownsMatch } from './owns.mjs';
import { judgeHolds } from './holds.mjs';
import { metTable, laneIndex, resultLine } from './board-util.mjs';

const TRACK = 'review-engine';
const item = (rule, id, message) => ({ rule, id, message });
const sha12 = (sha) => sha.slice(0, 12);
const isNoPr = (r) => r.last_life?.kind === 'done' && r.last_life.detail?.noPr === true;
const shaFilesOf = (map, sha) => (map instanceof Map ? map.get(sha) : map?.[sha]) ?? null;

function cardRules(ctx) {
  const errors = [];
  const other = new Map(ctx.foreign.map((f) => [f.id, f.project_key]));
  for (const id of ctx.facts.ids) {
    if (ctx.rowById.has(id)) continue;
    errors.push(other.has(id) ? item('card-other-board', id, `${id} is on board ${other.get(id)}`) : item('no-card', id, `${id} has no card on the board`));
  }
  return { errors, notes: [] };
}

function doneRules(ctx) {
  const bad = ctx.mapRows.filter((r) => r.state === 'done' && !r.met);
  return { errors: bad.map((r) => item('done-not-met', r.id, `${r.id} is done but no merged SHA on main is recorded (landed_sha ${r.landed_sha ?? 'none'})`)), notes: [] };
}

function edgeSetRules(ctx) {
  const errors = [];
  for (const lane of ctx.model.lanes) {
    const stored = new Set(ctx.edges.filter((e) => e.lane_id === lane.id).map((e) => e.depends_on));
    const wanted = new Set(lane.deps);
    for (const d of wanted) if (!stored.has(d)) errors.push(item('edge-missing', lane.id, `${lane.id} -> ${d}`));
    for (const d of stored) if (!wanted.has(d)) errors.push(item('edge-extra', lane.id, `${lane.id} -> ${d}`));
  }
  return { errors, notes: [] };
}

function edgeBoardRules(ctx) {
  const errors = [];
  for (const e of ctx.edges.filter((x) => ctx.facts.ids.includes(x.lane_id))) {
    const text = `${e.lane_id} -> ${e.depends_on}`;
    if (e.dep_board == null) errors.push(item('edge-no-lane', e.lane_id, `${text}: no lane has this id; it counts as open forever`));
    else if (e.dep_board !== ctx.board) errors.push(item('edge-cross-board', e.lane_id, `${text}: the dependency is on board ${e.dep_board}`));
  }
  return { errors, notes: [] };
}

function branchTrackRules(ctx) {
  const out = { errors: [], notes: [] };
  for (const lane of ctx.model.lanes) {
    const r = ctx.rowById.get(lane.id);
    if (!r) continue;
    const want = branchOf(lane.id, ctx.packs);
    if (r.branch !== want) out.errors.push(item('branch-differs', lane.id, `${lane.id} branch ${r.branch ?? 'NULL'}, seed branch ${want}`));
    if (r.track !== TRACK) out.notes.push(item('track-differs', lane.id, `${lane.id} track ${r.track ?? 'NULL'}, want ${TRACK}`));
  }
  return out;
}

function heldOpenRules(ctx) {
  const errors = [];
  for (const lane of ctx.model.lanes) {
    const r = ctx.rowById.get(lane.id);
    const judged = judgeHolds({ held: lane.held }, ctx.met);
    if (r && judged.held && !['blocked', 'done'].includes(r.state)) {
      errors.push(item('held-open', lane.id, `${lane.id} is ${r.state} with an unmet hold: ${judged.unmet.join(', ')}`));
    }
  }
  return { errors, notes: [] };
}

function listNotes(ctx) {
  const noPr = ctx.rows.filter((r) => r.state === 'done' && isNoPr(r) && ctx.facts.ids.includes(r.id));
  const stray = ctx.rows.filter((r) => r.id.startsWith('re-') && !ctx.facts.ids.includes(r.id) && r.id !== ctx.facts.seatId && r.state !== 'done');
  return {
    errors: [],
    notes: [
      ...noPr.map((r) => item('nopr', r.id, `${r.id} evidence ${r.last_life.detail.evidence ?? 'none'}`)),
      ...stray.map((r) => item('not-in-map', r.id, `${r.id} ${r.state}`)),
    ],
  };
}

function sharedShaRules(ctx) {
  const bySha = new Map();
  for (const r of ctx.landed) bySha.set(r.landed_sha, [...(bySha.get(r.landed_sha) ?? []), r]);
  const errors = [];
  for (const [sha, list] of bySha) {
    if (new Set(list.map((r) => branchOf(r.id, ctx.packs))).size > 1) {
      errors.push(item('shared-sha', list[0].id, `${sha12(sha)}: ${list.map((r) => r.id).join(', ')} are not one pack`));
    }
  }
  return { errors, notes: [] };
}

// The git Owns entries of every lane on the branch group of `id`.
function groupOwns(id, ctx) {
  const key = branchOf(id, ctx.packs);
  const ids = [...ctx.index.keys()].filter((x) => branchOf(x, ctx.packs) === key);
  return ids.flatMap((x) => ctx.index.get(x).owns).filter((e) => !e.outsideGit);
}

function ownsFileRule(r, ctx) {
  const files = shaFilesOf(ctx.shaFiles, r.landed_sha);
  if (files === null) return { note: item('sha-unchecked', r.id, `${r.id} ${sha12(r.landed_sha)} could not be read from git`) };
  const entries = groupOwns(r.id, ctx);
  if (entries.length === 0) return { note: item('sha-no-owns-skipped', r.id, `${r.id} has no Owns entry in git; files not compared`) };
  if (files.some((f) => entries.some((e) => ownsMatch(e, f)))) return {};
  return { error: item('sha-no-owns', r.id, `${r.id} merged ${sha12(r.landed_sha)} touches none of its Owns files`) };
}

function ownsFileRules(ctx) {
  const out = { errors: [], notes: [] };
  for (const r of ctx.landed) {
    const hit = ownsFileRule(r, ctx);
    if (hit.error) out.errors.push(hit.error);
    if (hit.note) out.notes.push(hit.note);
  }
  return out;
}

const RULES = [cardRules, doneRules, edgeSetRules, edgeBoardRules, branchTrackRules, heldOpenRules, listNotes, sharedShaRules, ownsFileRules];

export function checkBoard(input) {
  const { model, facts, rows, foreign = [], edges = [], shaFiles = {} } = input;
  const mapRows = rows.filter((r) => facts.ids.includes(r.id));
  const ctx = {
    model, facts, rows, foreign, edges, shaFiles, mapRows, board: input.board ?? rows[0]?.project_key ?? null,
    rowById: new Map(rows.map((r) => [r.id, r])), packs: model.packs ?? [], index: laneIndex(model), met: metTable(rows),
    landed: mapRows.filter((r) => r.met && r.landed_sha && !isNoPr(r)),
  };
  const parts = RULES.map((rule) => rule(ctx));
  return { errors: parts.flatMap((p) => p.errors), notes: parts.flatMap((p) => p.notes) };
}

export function renderBoardCheck(res) {
  const lines = res.errors.map((e) => `FAIL ${e.rule} ${e.message}`);
  lines.push(...res.notes.map((n) => `NOTE ${n.rule} ${n.message}`));
  lines.push(resultLine(res.errors.length));
  return lines.join('\n');
}
