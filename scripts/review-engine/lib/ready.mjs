// `program.mjs ready`: which lanes may a session claim now (design B.3; A6 pack from the map, A7 one spend source). Pure.
// selectReady({ model, facts, rows, caller, board? }) returns
//   { board, caller, mode: 'worker'|'seat'|'pack'|null, refusal: null | { exit, message },
//     cap: { used, limit, units: [{ key, lanes, live }] }, slot: { held, by },
//     ready: [{ id, wave, band, priority, branch, spends }], heldBack: [{ id, reason, other }],
//     waitingOnDave: [{ id, owner, note }], notInMap: [{ id, state }], warnings: [string],
//     result: 'ready'|'cap-full'|'none'|'refused' }
// refusal.exit: 2 no caller, 1 the Cursor eval slot bullet is missing (fail closed), 3 the caller already holds a re- lane.
// The order of `rows` is the order of the output (the board SQL order).
import { unitKey } from './pack.mjs';
import { conflicts } from './owns.mjs';
import { judgeHolds } from './holds.mjs';
import { isProgramId, isWorkerRe, owner8, metTable, workRows, laneIndex } from './board-util.mjs';

export const CAP_LIMIT = 5; // Dave 2026-11-13 (card coord-program-cap-5): cap 5 for now, was 3.
const OPEN = ['backlog', 'ready'];
const isBranch = (key) => /^re\//.test(key);

// One unit per re/ branch in work (a pack is one unit), else one per lane. A unit is live when one of its lanes is not reclaimable.
export function computeCap(rows, model, facts) {
  const units = new Map();
  for (const r of workRows(rows, facts)) {
    const key = unitKey(r, model.packs ?? []);
    const unit = units.get(key) ?? { key, lanes: [], live: false };
    unit.lanes.push(r.id);
    unit.live = unit.live || !r.reclaimable;
    units.set(key, unit);
  }
  const list = [...units.values()];
  return { used: list.filter((u) => u.live).length, limit: CAP_LIMIT, units: list };
}

// The slot is held by a live lane in work whose id is on the Cursor eval slot bullet. No bullet: nobody holds it.
export function computeSlot(rows, model, facts) {
  const spenders = facts.slotIds ?? [];
  const by = workRows(rows, facts).filter((r) => !r.reclaimable && spenders.includes(r.id)).map((r) => r.id);
  return { held: by.length > 0, by };
}

function callerMode(rows, facts, model, caller) {
  const mine = rows.filter((r) => r.owner_session_id === caller && r.state !== 'done' && isProgramId(r.id, facts));
  if (mine.some((r) => r.id === facts.seatId)) return { mode: 'seat' };
  const held = mine.filter((r) => isWorkerRe(r.id, facts));
  if (held.length === 0) return { mode: 'worker' };
  const unit = unitKey(held[0], model.packs ?? []);
  const samePack = held.every((r) => unitKey(r, model.packs ?? []) === unit);
  if (samePack && (model.packs ?? []).some((p) => p.branch === unit)) return { mode: 'pack', unit };
  return { refusal: `REFUSED ready -- you hold ${held[0].id}; one re- lane per session (finish it with done --merged, or release it)` };
}

// A reason is { reason, other } or null. The first match wins.
function heldReason(cand, ctx) {
  const judged = judgeHolds({ held: ctx.index.get(cand.id)?.held ?? [] }, ctx.met);
  return judged.held ? { reason: 'held', other: judged.unmet.join(', ') } : null;
}

function ownsReason(cand, ctx) {
  const mine = ctx.index.get(cand.id)?.owns ?? [];
  const unit = unitKey(cand, ctx.packs);
  const others = ctx.work.filter((w) => unitKey(w, ctx.packs) !== unit && conflicts(mine, ctx.index.get(w.id)?.owns ?? []).length > 0);
  return others.length ? { reason: 'owns-held', other: others.map((w) => w.id).join(', ') } : null;
}

function packReason(cand, ctx) {
  const unit = unitKey(cand, ctx.packs);
  if (!isBranch(unit)) return null;
  const holder = ctx.rows.find((o) => o.id !== cand.id && o.id.startsWith('re-') && unitKey(o, ctx.packs) === unit
    && o.owner_session_id && o.owner_session_id !== ctx.caller && !o.reclaimable);
  return holder ? { reason: 'pack-held', other: `${holder.id} ${owner8(holder.owner_session_id)}` } : null;
}

function slotReason(cand, ctx) {
  const spends = (ctx.facts.slotIds ?? []).includes(cand.id);
  return spends && ctx.slot.held ? { reason: 'slot-held', other: ctx.slot.by.join(', ') } : null;
}

function capReason(cand, ctx) {
  return ctx.cap.used >= ctx.cap.limit && ctx.mode !== 'pack' ? { reason: 'cap-full', other: null } : null;
}

const REASONS = [heldReason, ownsReason, packReason, slotReason, capReason];

function isCandidate(r, ctx) {
  const free = r.owner_session_id == null || r.reclaimable;
  const inUnit = ctx.mode !== 'pack' || unitKey(r, ctx.packs) === ctx.unit;
  return ctx.facts.ids.includes(r.id) && OPEN.includes(r.state) && !r.open_dep && free && r.owner_session_id !== ctx.caller && inUnit;
}

function readyItem(r, ctx) {
  const wave = ctx.index.get(r.id)?.wave ?? null;
  return { id: r.id, wave, band: r.band, priority: r.priority, branch: r.branch, spends: (ctx.facts.slotIds ?? []).includes(r.id) };
}

function listings(rows, facts) {
  const programRows = rows.filter((r) => isProgramId(r.id, facts) && r.id !== facts.seatId);
  return {
    waitingOnDave: programRows.filter((r) => r.state === 'review').map((r) => ({ id: r.id, owner: r.owner_session_id, note: r.note })),
    notInMap: programRows.filter((r) => r.id.startsWith('re-') && !facts.ids.includes(r.id) && r.state !== 'done')
      .map((r) => ({ id: r.id, state: r.state })),
    warnings: workRows(rows, facts).filter((r) => !facts.ids.includes(r.id)).map((r) => `in work, not in map: ${r.id} (its Owns are unknown)`),
  };
}

function emptyResult(board, caller) {
  return {
    board, caller, mode: null, refusal: null, cap: { used: 0, limit: CAP_LIMIT, units: [] }, slot: { held: false, by: [] },
    ready: [], heldBack: [], waitingOnDave: [], notInMap: [], warnings: [], result: 'refused',
  };
}

function refuse(res, exit, message) {
  return { ...res, refusal: { exit, message } };
}

function earlyRefusal({ facts, caller }) {
  if (!caller) return { exit: 2, message: 'ready needs CLAUDE_CODE_SESSION_ID or --as <session>' };
  if (facts.slotIds === null) return { exit: 1, message: 'map fact missing: Cursor eval slot bullet' };
  return null;
}

function sortCandidates(ctx) {
  const out = { ready: [], heldBack: [] };
  for (const r of ctx.rows.filter((x) => isCandidate(x, ctx))) {
    const hit = REASONS.map((fn) => fn(r, ctx)).find(Boolean);
    if (hit) out.heldBack.push({ id: r.id, ...hit });
    else out.ready.push(readyItem(r, ctx));
  }
  return out;
}

function resultOf(res) {
  if (res.ready.length > 0) return 'ready';
  return res.heldBack.some((h) => h.reason === 'cap-full') ? 'cap-full' : 'none';
}

export function selectReady(input) {
  const { model, facts, rows, caller, board = null } = input;
  const res = emptyResult(board, caller);
  const early = earlyRefusal(input);
  if (early) return refuse(res, early.exit, early.message);
  const who = callerMode(rows, facts, model, caller);
  if (who.refusal) return refuse(res, 3, who.refusal);
  const packs = model.packs ?? [];
  const cap = computeCap(rows, model, facts);
  const slot = computeSlot(rows, model, facts);
  const ctx = {
    model, facts, rows, caller, packs, cap, slot, mode: who.mode, unit: who.unit, met: metTable(rows),
    index: laneIndex(model), work: workRows(rows, facts),
  };
  const sorted = sortCandidates(ctx);
  const done = { ...res, mode: who.mode, cap, slot, ...sorted, ...listings(rows, facts) };
  return { ...done, result: resultOf(done) };
}

// Text output, from the 'ready:' line on. The caller prints the test-mode banner first.
export function renderReady(res) {
  if (res.refusal) return res.refusal.message;
  const slot = res.slot.held ? `held by ${res.slot.by.join(', ')}` : 'free';
  const lines = [`ready: board ${res.board ?? '-'}, caller ${owner8(res.caller)}, mode ${res.mode}, cap ${res.cap.used}/${res.cap.limit} units, slot ${slot}`];
  if (res.mode === 'seat') lines.push('seat view: you hold re-program; name lanes with say, never claim them');
  for (const r of res.ready) {
    lines.push(`READY ${r.id}  ${r.band ?? '-'} ${r.priority}  wave ${r.wave}  branch ${r.branch}${r.spends ? '  spends' : ''}`);
  }
  for (const h of res.heldBack) lines.push(`HELD BACK ${h.id}  ${h.reason}${h.other ? ` ${h.other}` : ''}`);
  lines.push(...res.warnings);
  for (const w of res.waitingOnDave) lines.push(`waiting on Dave: ${w.id} (${owner8(w.owner)}) ${w.note ?? ''}`.trimEnd());
  for (const n of res.notInMap) lines.push(`not in map: ${n.id} ${n.state}`);
  lines.push(res.result === 'ready' ? `RESULT ready ${res.ready.length}` : `RESULT ${res.result}`);
  return lines.join('\n');
}
