/**
 * kanban-apply -- the pure planner that carries Dave's kanban changes into the lane DB.
 *
 * Dave sets order, status, notes and questions on the lane board's kanban page. The
 * page keeps them in its own db. A session reads that db, writes a JSON file, and
 * runs `lane.mjs apply-kanban <file>`. That command calls `planKanban` here and
 * applies the actions. This module has no I/O, so every rule has a unit test.
 *
 * Contract: scratchpad kanban-contract.md. Page db paths:
 *   kanban/board   { columns: {now,next,later,waiting: [laneId]}, updatedAt, syncedAt? }
 *   cards/<laneId> { status?, note?, question?, updatedAt, syncedAt?, syncResult? }
 *
 * DECISIONS THE CONTRACT LEAVES OPEN (each has a test)
 * - The board columns apply only while the board is pending (updatedAt later than
 *   syncedAt, or no syncedAt). A column move is an event from Dave, not a standing
 *   order. Without this gate a stale board re-asserts old priorities on every sync,
 *   and a waiting lane that Dave set to "ready" on its card flips back to blocked.
 * - A card is read only while pending, for status, note and question alike. Without
 *   that gate a stale card status reverts lanes a session moved on.
 * - Active lanes: the card is skipped whole ("skipped: active"), and the card stays
 *   pending so it applies after the lane stops being active. A column still sets the
 *   priority of an active lane. Priority does not affect a claim.
 * - Column STATE rules (into waiting -> blocked, out of waiting -> backlog) apply only to
 *   lanes whose column changed since the last applied board (board.appliedColumns, which
 *   the sync writes back with syncedAt). Every client save sends all columns, so without
 *   this a lane Dave unblocked on its card is re-blocked by any later reorder. Rank still
 *   follows the full current order. No appliedColumns (first sync): every lane counts as changed.
 * - Held lanes (a live session owns them) never change state from a card or a column.
 *   Notes still apply. The card result is "skipped: held" and the card stays pending.
 * - Done lanes are never moved into waiting. Done work stays done.
 * - Priority = one rank per open lane, 1..n in board order (now, next, later, waiting).
 *   "Open" means open after this run: a pending card status can reopen a done lane (it gets a
 *   rank) or close an open one (it gets none). Unknown ids use no rank. Band is never read or written: a card drag changes
 *   rank only (Dave sets a band with `lane.mjs band`). New lanes default to 50, so they
 *   sort after a board of up to 49 cards.
 * - "Leaving waiting" has no history in the planner. A lane counts as "was waiting"
 *   only when it is blocked AND its note still contains the waiting marker (kept
 *   notes carry it after "|| before:"). The priority number never decides it. A lane
 *   a session blocked for its own reason, or whose note a session replaced, stays
 *   blocked: the safe side.
 * - When a lane has a column rule and a pending card status, the card status wins and
 *   the lane gets ONE state action. The waiting note is added only when the final
 *   state is blocked and the lane was not blocked before.
 * - An id in two columns: the first position wins.
 * - Note then question on one card: two note actions, the question last. lane.note is
 *   one column, so each kanban text goes FIRST and the previous line is kept after
 *   " || before: " (cut at 2000 chars). A session's status line is never lost (Dave
 *   2026-11-02). lane_event keeps every step.
 */

/** Board order: every open lane gets ONE rank, 1..n across the columns in this order. Done and unknown ids use no rank. Band is never read or written. */
export const COLUMNS = ['now', 'next', 'later', 'waiting'];
export const WAITING_NOTE = 'Waiting on Dave (kanban)';
export const CARD_STATUSES = ['backlog', 'ready', 'blocked', 'done'];
const NOTE_MAX = 1000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const time = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);

/** Pending: edited after the last sync, or never synced. */
export function isPending(updatedAt, syncedAt) {
  const synced = time(syncedAt);
  if (Number.isNaN(synced)) return true;
  const updated = time(updatedAt);
  return !Number.isNaN(updated) && updated > synced;
}

const boardPending = (board) => isObj(board) && isObj(board.columns) && isPending(board.updatedAt, board.syncedAt);

/** Map<laneId, column> for a saved columns object. First position wins. Not an object: empty map. */
function columnOf(columns) {
  const out = new Map();
  if (!isObj(columns)) return out;
  for (const column of COLUMNS) {
    for (const id of Array.isArray(columns[column]) ? columns[column] : []) {
      if (typeof id === 'string' && id && !out.has(id)) out.set(id, column);
    }
  }
  return out;
}

/**
 * The state a lane has after this run's card status. Only a pending card with a valid
 * status counts, and not on an active lane (skipped whole) or a held lane (status waits).
 * Column rules never move a lane into or out of done, so they do not matter here.
 */
function finalState(row, card) {
  if (!card || row.state === 'active' || !isPending(card.updatedAt, card.syncedAt)) return row.state;
  if (!CARD_STATUSES.includes(card.status)) return row.state;
  return row.held && card.status !== row.state ? row.state : card.status;
}

/**
 * First position wins. Returns Map<laneId, {column, index, rank, changed}>.
 * Rank follows the FINAL state: a lane that ends done gets no placement and uses no rank
 * (a done lane that a pending card reopens does get one; an open lane the card closes does not).
 * An id with no lane row keeps an entry (rank null, so planKanban reports it as skipped) and
 * uses no rank. Lanes that end open get 1..n.
 */
function placements(board, rows = new Map(), cards = new Map()) {
  const out = new Map();
  if (!boardPending(board)) return out;
  const before = columnOf(board.appliedColumns);
  const seen = new Set();
  let rank = 0;
  for (const column of COLUMNS) {
    const ids = Array.isArray(board.columns[column]) ? board.columns[column] : [];
    ids.forEach((id, index) => {
      if (typeof id !== 'string' || !id || seen.has(id)) return;
      seen.add(id);
      const row = rows.get(id);
      if (row && finalState(row, cards.get(id)) === 'done') return;
      // changed: another column than in the last applied board (every lane, when none is known).
      out.set(id, { column, index, rank: row ? ++rank : null, changed: before.get(id) !== column });
    });
  }
  return out;
}

/**
 * A copy of the columns this run applied (ids only), or the saved copy when the board is not pending.
 * A held lane whose column move was skipped keeps its previous column (or is left out), so the
 * next sync sees the move as still changed and applies it once the lane is released.
 */
function appliedColumnsOf(board, deferred = new Set()) {
  if (!isObj(board)) return null;
  if (!boardPending(board)) return isObj(board.appliedColumns) ? board.appliedColumns : null;
  const before = columnOf(board.appliedColumns);
  const out = {};
  for (const column of COLUMNS) {
    out[column] = (Array.isArray(board.columns[column]) ? board.columns[column] : [])
      .filter((id) => typeof id === 'string' && id && !deferred.has(id));
  }
  for (const id of deferred) if (before.has(id)) out[before.get(id)].push(id);
  return out;
}

function wasWaiting(lane) {
  // The marker only, never the priority number: a kept note may carry it after "|| before:".
  return lane.state === 'blocked' && typeof lane.note === 'string' && lane.note.includes(WAITING_NOTE);
}

const cleanText = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, NOTE_MAX) : null);

/** Dave's text first, the lane's previous line kept after it, so a session's status line is never lost. */
const KEEP_SEP = ' || before: ';
const KEPT_MAX = 2000;
const withPrevious = (text, prev) => (!prev || prev.startsWith(text) ? text : `${text}${KEEP_SEP}${prev}`.slice(0, KEPT_MAX));
const shows = (note, text) => typeof note === 'string' && note.startsWith(text);

/**
 * The state the column asks for, or null for "no opinion". Only a lane whose column
 * CHANGED since the last applied board has an opinion: every client save sends all
 * columns, so a standing column must not undo what Dave set on a card afterwards.
 */
function columnState(lane, place) {
  if (!place || !place.changed || lane.state === 'active') return null;
  if (place.column === 'waiting') return ['active', 'done', 'blocked'].includes(lane.state) ? null : 'blocked';
  return wasWaiting(lane) ? 'backlog' : null;
}

/** Actions for the card of one lane. Returns { status, notes, result } (result may be null). */
function readCard(card, lane) {
  const pending = isPending(card.updatedAt, card.syncedAt);
  if (!pending) return { status: null, notes: [], result: null };
  if (!lane) return { status: null, notes: [], result: { syncResult: 'skipped: no such lane', applied: false } };
  if (lane.state === 'active') return { status: null, notes: [], result: { syncResult: 'skipped: active', applied: false } };
  if (card.status !== undefined && card.status !== null && !CARD_STATUSES.includes(card.status)) {
    return { status: null, notes: [], result: { syncResult: 'skipped: invalid status', applied: false } };
  }
  const notes = [];
  const note = cleanText(card.note);
  const question = cleanText(card.question);
  // The sync writes back what it applied; a later status-only edit must not post the same text again.
  if (note && note !== cleanText(card.appliedNote)) notes.push(`Dave (kanban): ${note}`);
  if (question && question !== cleanText(card.appliedQuestion)) notes.push(`Dave asks (kanban): ${question}`);
  const applied = { applied: true, appliedNote: note ?? null, appliedQuestion: question ?? null };
  // A held lane keeps its state. Its notes still apply; the card stays pending so the status can apply later.
  if (lane.held && card.status && card.status !== lane.state) {
    return { status: null, notes, held: true, result: { ...applied, applied: false, syncResult: 'skipped: held' } };
  }
  return { status: card.status || null, notes, result: applied };
}

/**
 * @param {{board?: object, cards?: object[]}} input
 * @param {{id: string, state: string, priority: number, note: string|null, held?: boolean}[]} lanes
 *   held: a live session owns the lane (lane.mjs computes it with the RECLAIMABLE predicate).
 * @returns {{actions: object[], results: object[], skipped: {laneId: string, reason: string}[], appliedColumns: object|null, boardDone: boolean}}
 */
export function planKanban(input, lanes) {
  const inp = isObj(input) ? input : {};
  const rows = new Map((Array.isArray(lanes) ? lanes : []).filter((l) => isObj(l) && l.id).map((l) => [l.id, l]));
  const cards = new Map();
  for (const c of Array.isArray(inp.cards) ? inp.cards : []) {
    if (isObj(c) && typeof c.id === 'string' && c.id && !cards.has(c.id)) cards.set(c.id, c);
  }
  const place = placements(inp.board, rows, cards);

  const actions = [];
  const results = [];
  const skipped = [];
  const act = (laneId, kind, from, to, text) => actions.push({ laneId, kind, from, to, text });
  const deferred = new Set();

  for (const id of new Set([...place.keys(), ...cards.keys()])) {
    const lane = rows.get(id);
    const p = place.get(id);
    const card = cards.get(id);
    const read = card ? readCard(card, lane) : { status: null, notes: [], result: null };

    if (!lane) {
      if (p || read.result) skipped.push({ laneId: id, reason: 'no such lane' });
      if (read.result) results.push({ laneId: id, ...read.result });
      continue;
    }

    const cardDone = [];
    if (p) {
      const target = p.rank;
      if (lane.priority !== target) act(id, 'priority', lane.priority, target, `${p.column} #${p.index}`);
    }
    if (read.result?.applied !== false || read.held) {
      const colWant = columnState(lane, p);
      const want = read.status ?? (lane.held ? null : colWant);
      if (lane.held && !read.status && colWant && colWant !== lane.state) {
        deferred.add(id);
        if (!skipped.some((k) => k.laneId === id)) skipped.push({ laneId: id, reason: 'held' });
      }
      if (want && want !== lane.state) {
        act(id, 'state', lane.state, want, read.status ? 'kanban card status' : `kanban column ${p?.column}`);
        if (read.status) cardDone.push('state');
        if (want === 'blocked' && p?.column === 'waiting') act(id, 'note', lane.note ?? null, withPrevious(WAITING_NOTE, lane.note), 'moved into waiting');
      }
      // The lane already shows this card's last text: a run whose write-back failed. Do not repeat the chain.
      for (const text of shows(lane.note, read.notes.at(-1)) ? [] : read.notes) {
        const current = actions.filter((a) => a.laneId === id && a.kind === 'note').at(-1)?.to ?? lane.note ?? null;
        if (shows(current, text)) continue;
        act(id, 'note', current, withPrevious(text, current), 'kanban card');
        cardDone.push('note');
      }
    }
    if (read.result) {
      const syncResult = read.result.syncResult ?? (cardDone.length ? `applied: ${cardDone.join(', ')}` : 'no change');
      const kept = 'appliedNote' in read.result ? { appliedNote: read.result.appliedNote, appliedQuestion: read.result.appliedQuestion } : {};
      results.push({ laneId: id, syncResult, applied: read.result.applied, ...kept });
      if (!read.result.applied && !skipped.some((k) => k.laneId === id)) {
        skipped.push({ laneId: id, reason: syncResult.replace(/^skipped: /, '') });
      }
    }
  }
  // boardDone false: a held column move waits, so the sync must not mark the board synced.
  return { actions, results, skipped, appliedColumns: appliedColumnsOf(inp.board, deferred), boardDone: deferred.size === 0 };
}
