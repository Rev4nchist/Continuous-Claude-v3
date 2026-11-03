// Free-slot queue: the pure model. No file, no process, no network, no clock: every function gets `now` as an argument.
// slot-queue.mjs (the CLI) reads GitHub and the state file, then calls these functions and writes the result.
// Imports only node: builtins (none today). Plan: .claudedocs/2026-11-02-free-slot-queue-phase1-plan.md sec 3 and 4 (W1).
// Every function returns new objects. None changes its input.

/**
 * What the CLI reads from GitHub for one PR, as plain data. The CLI builds it from the review-status.mjs pure exports.
 * @typedef {object} Facts
 * @property {number} pr
 * @property {boolean} open          false once the PR is closed or merged
 * @property {boolean} merged
 * @property {string} head           the PR head sha now (40 hex)
 * @property {boolean} reviewedHead  CodeRabbit finished a review of `head` (codeRabbitHeadReview.reviewedHead)
 * @property {boolean} pending       the CodeRabbit status on `head` is pending (a review may be running)
 * @property {boolean} limited       a CodeRabbit limit notice applies to `head`
 * @property {number|null} retryMinutes  minutes LEFT at the time of the read (codeRabbitHeadReview.retryMinutes already subtracts the notice age)
 * @property {number[]} reviewAts    epoch ms of every CodeRabbit review seen on the PR
 * @property {number[]} requestAts   epoch ms of every "@coderabbitai review" request comment seen on the PR
 * @property {boolean} carryHolds    the earlier review carries to `head` (CARRY_REASON_PREFIX), so no post is needed
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const BANDS = ['CRITICAL', 'HIGH', 'SAMPLE'];
export const STATES = ['opening', 'awaiting-fix', 'queued', 'posted', 'timed-out', 'done', 'dropped', 'stuck'];
const TERMINAL = ['done', 'dropped'];
const IN_LINE = ['queued', 'timed-out'];

/** Equal to review-router.config.json matrix.slot (plan sec 7 item 1). stale_days and dedupe_min are not in the config. */
export const DEFAULTS = Object.freeze({
  spacing_min: 60, paid_after_min: 30, timeout_min: 60, holder_max_min: 20, sample_ttl_hours: 12, stale_days: 7, dedupe_min: 4,
});

export function configOf(routerConfig) {
  const block = routerConfig?.matrix?.slot ?? {};
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof block[key] === 'number' && Number.isFinite(block[key]) && block[key] > 0) out[key] = block[key];
  }
  return out;
}

// --- state file -------------------------------------------------------------------------------------------------

export const emptyState = () => ({
  version: 1, lastTickAt: 0, slot: { nextAt: null, source: 'unknown', lastPostAt: 0, lastPostPr: null }, holder: null, items: [],
});

const bad = (why) => new Error(`slot-queue: ${why}`);

function checkItem(it) {
  const ok = it && Number.isInteger(it.pr) && BANDS.includes(it.band) && STATES.includes(it.state) && typeof it.head === 'string';
  if (!ok) throw bad(`bad item in the state file: ${JSON.stringify(it)?.slice(0, 80)}`);
}

/** Text of the state file to a state. A missing file (null or undefined) is an empty queue. Anything else that is not v1 JSON throws. */
export function parseState(text) {
  if (text === undefined || text === null) return emptyState();
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw bad(`the state file is not JSON (${e.message})`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('the state file is not an object');
  if (raw.version !== 1) throw bad(`unsupported state version ${raw.version}`);
  if (!Array.isArray(raw.items)) throw bad('the state file has no items list');
  raw.items.forEach(checkItem);
  const base = emptyState();
  return { ...base, ...raw, slot: { ...base.slot, ...raw.slot }, holder: raw.holder ?? null };
}

// --- order ------------------------------------------------------------------------------------------------------

/** 1 pin, 2 CRITICAL, 3 escalated HIGH, 4 static HIGH, 5 SAMPLE. */
export function tierOf(item) {
  if (item.pin) return 1;
  if (item.band === 'CRITICAL') return 2;
  if (item.band === 'SAMPLE') return 5;
  return item.escalated ? 3 : 4;
}

const startOf = (item) => item.queuedAt || item.addedAt || 0;

/** A sorted copy. Ties go to the oldest queuedAt, then the lowest PR number. */
export function orderItems(items) {
  return [...items].sort((a, b) => tierOf(a) - tierOf(b) || startOf(a) - startOf(b) || a.pr - b.pr);
}

// --- slot -------------------------------------------------------------------------------------------------------

/** The earliest ms the slot can be free: the notice figure, the spacing floor after the last post, and a live holder's expiry. */
export function slotOpensAt(state, cfg) {
  const { nextAt, lastPostAt } = state.slot;
  const holderEnds = state.holder ? state.holder.at + cfg.holder_max_min * MIN : 0;
  return Math.max(nextAt ?? 0, (lastPostAt ?? 0) + cfg.spacing_min * MIN, holderEnds);
}

export const slotFree = (state, now, cfg) => !state.holder && now >= slotOpensAt(state, cfg);

const inLine = (item) => IN_LINE.includes(item.state);
const isTerminal = (item) => TERMINAL.includes(item.state);

/**
 * The item that takes the slot, or null. Only queued and timed-out items qualify (a timed-out item still gets a free slot).
 * A pending CodeRabbit status on an item's own head skips that item: a review may already be running on it.
 */
export function pickNext(state, now, cfg, factsByPr = {}) {
  if (!slotFree(state, now, cfg)) return null;
  const ready = orderItems(state.items.filter(inLine)).filter((it) => !factsByPr[it.pr]?.pending);
  return ready[0] ?? null;
}

// --- one item ---------------------------------------------------------------------------------------------------

const sameHead = (item, facts) => !facts.head || facts.head === item.head;

/** A closed or merged PR is dropped. A reviewed head is done, except awaiting-fix on the head the grant was made on. */
export function closeDone(item, facts) {
  if (!facts || isTerminal(item)) return item;
  if (facts.open === false) return { ...item, state: 'dropped', dropReason: facts.merged ? 'merged' : 'closed' };
  const waitingForFix = item.state === 'awaiting-fix' && sameHead(item, facts);
  return facts.reviewedHead && !waitingForFix ? { ...item, state: 'done' } : item;
}

function rehead(item, facts, now) {
  const next = { ...item, head: facts.head };
  if (item.state === 'posted') return { ...next, state: 'queued' };
  if (item.state === 'awaiting-fix' && !facts.carryHolds) return { ...next, state: 'queued', queuedAt: now };
  return next;
}

/**
 * A moved head keeps queuedAt (the clock belongs to the PR). It clears this PR's holder: the post was for the old head.
 * An awaiting-fix item queues when the fix lands and the carry does not hold; its clock starts at `now`.
 * @returns {{ item: object, holder: object|null }}
 */
export function moveHead(item, facts, holder, now) {
  if (!facts?.head || facts.head === item.head) return { item, holder };
  return { item: rehead(item, facts, now), holder: holder?.pr === item.pr ? null : holder };
}

/** T2: an opening item queues on a limit notice, or when 30 minutes pass with no review running. */
export function promoteOpening(item, facts, now, cfg) {
  if (item.state !== 'opening' || !facts) return item;
  const waited = now - (item.addedAt || 0) >= cfg.paid_after_min * MIN && !facts.pending;
  return facts.limited || waited ? { ...item, state: 'queued', queuedAt: now } : item;
}

/** The stored times only. Paid ask: CRITICAL once, at 30 minutes. Time-out: HIGH and CRITICAL at 60, never while the item holds the slot. */
export function timers(item, now, cfg, holder = null) {
  const queuedMin = Math.max(0, Math.floor((now - startOf(item)) / MIN));
  const timed = item.band !== 'SAMPLE' && inLine(item);
  const left = Math.ceil((startOf(item) + cfg.timeout_min * MIN - now) / MIN);
  const timedOut = timed && !(holder?.pr === item.pr) && queuedMin >= cfg.timeout_min;
  const askPaid = item.band === 'CRITICAL' && item.state === 'queued' && !item.asked?.paid30 && !timedOut
    && holder?.pr !== item.pr && queuedMin >= cfg.paid_after_min;
  return { queuedMin, timeoutInMin: timed ? Math.max(0, left) : null, askPaid, timedOut };
}

// --- whole state ------------------------------------------------------------------------------------------------

/** A holder that is too old made no review (#246): count the post, free the slot, queue again, or stuck at 2 posts. */
export function expireHolder(state, now, cfg) {
  const held = state.holder;
  if (!held) return state;
  const item = state.items.find((it) => it.pr === held.pr);
  if (!item || isTerminal(item)) return { ...state, holder: null };
  if (now - held.at < cfg.holder_max_min * MIN) return state;
  const posts = (item.posts ?? 0) + 1;
  const items = state.items.map((it) => (it === item ? { ...it, posts, state: posts >= 2 ? 'stuck' : 'queued' } : it));
  return { ...state, items, holder: null, slot: { ...state.slot, nextAt: now + cfg.spacing_min * MIN, source: 'post' } };
}

const stampsOf = (f, pr) => [...(f.reviewAts ?? []), ...(f.requestAts ?? [])].map((at) => ({ at, pr }));

/** Every CodeRabbit review or request comment seen on any item uses the same rate pool: it moves lastPostAt (never back). */
export function noteSeenPosts(state, factsByPr = {}) {
  const all = Object.entries(factsByPr).flatMap(([pr, f]) => stampsOf(f, Number(pr)));
  const newest = all.reduce((a, b) => (b.at > a.at ? b : a), { at: 0, pr: null });
  if (newest.at <= (state.slot.lastPostAt ?? 0)) return state;
  return { ...state, slot: { ...state.slot, lastPostAt: newest.at, lastPostPr: newest.pr, source: 'seen' } };
}

/** A limit notice sets nextAt to now plus the minutes left it names. A later nextAt wins; a smaller figure never lowers it. */
export function noteNotices(state, factsByPr = {}, now = 0) {
  const ends = Object.values(factsByPr)
    .filter((f) => f.limited && f.retryMinutes > 0)
    .map((f) => now + f.retryMinutes * MIN);
  const latest = Math.max(0, ...ends);
  if (latest <= (state.slot.nextAt ?? 0)) return state;
  return { ...state, slot: { ...state.slot, nextAt: latest, source: 'notice' } };
}

function settleItem(item, facts, holder, now, cfg) {
  const closed = closeDone(item, facts);
  if (!facts || isTerminal(closed)) return { item: closed, holder };
  const moved = moveHead(closed, facts, holder, now);
  return { item: promoteOpening(moved.item, facts, now, cfg), holder: moved.holder };
}

function markTimedOut(state, now, cfg) {
  const items = state.items.map((it) => (it.state === 'queued' && timers(it, now, cfg, state.holder).timedOut
    ? { ...it, state: 'timed-out' } : it));
  return { ...state, items };
}

/** Drops items whose last activity is older than stale_days. A holder of a removed item goes too. */
export function prune(state, now, cfg) {
  const items = state.items.filter((it) => now - Math.max(it.addedAt || 0, it.queuedAt || 0) <= cfg.stale_days * DAY);
  const gone = state.holder && !items.some((it) => it.pr === state.holder.pr);
  return { ...state, items, holder: gone ? null : state.holder };
}

/**
 * The apply step of a tick, in order: close done and dropped items, move heads, promote opening items, note notices and
 * seen posts, expire the holder, mark time-outs, prune. Closing runs before pickNext, so a reviewed head never posts.
 * @param {object} state
 * @param {Object<number, Facts>} factsByPr  a PR with no entry is left as it is
 */
export function settle(state, factsByPr, now, cfg) {
  let holder = state.holder;
  const items = state.items.map((it) => {
    const step = settleItem(it, factsByPr[it.pr], holder, now, cfg);
    holder = step.holder;
    return step.item;
  });
  let next = noteSeenPosts(noteNotices({ ...state, items, holder }, factsByPr, now), factsByPr);
  next = markTimedOut(expireHolder(next, now, cfg), now, cfg);
  return prune(next, now, cfg);
}

// --- rows -------------------------------------------------------------------------------------------------------

const minutesUntil = (at, now) => Math.max(0, Math.ceil((at - now) / MIN));

function rowOf(item, ctx) {
  const t = timers(item, ctx.now, ctx.cfg, ctx.state.holder);
  const position = ctx.line.indexOf(item) + 1 || null;
  const row = {
    pr: item.pr, band: item.band, state: item.state, position, total: ctx.line.length, head7: item.head.slice(0, 7),
    queuedMin: t.queuedMin, timeoutInMin: t.timeoutInMin, nextSlotInMin: ctx.nextSlotInMin, posts: item.posts ?? 0,
    asked: item.asked ?? { paid30: false, timeout60: false },
  };
  return item.dropReason ? { ...row, dropReason: item.dropReason } : row;
}

/** Rows for list, tick and the mod: the items in line first (in order), then the rest by PR number. */
export function rowsOf(state, now, cfg) {
  const line = orderItems(state.items.filter(inLine));
  const rest = state.items.filter((it) => !inLine(it)).sort((a, b) => a.pr - b.pr);
  const ctx = { state, now, cfg, line, nextSlotInMin: minutesUntil(slotOpensAt(state, cfg), now) };
  return [...line, ...rest].map((it) => rowOf(it, ctx));
}
