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
 * - Done lanes are never moved into waiting. Done work stays done.
 * - "Leaving waiting" has no history in the planner. A lane counts as "was waiting"
 *   only when it is blocked AND (its note is the waiting note OR its priority is in
 *   the waiting band 70-99). A lane a session blocked for its own reason carries
 *   neither, so it stays blocked. The band test covers a later note that replaced
 *   the waiting note. A lane that was both overwritten and set to priority 70+ by
 *   hand would be unblocked by mistake. That case is accepted.
 * - When a lane has a column rule and a pending card status, the card status wins and
 *   the lane gets ONE state action. The waiting note is added only when the final
 *   state is blocked and the lane was not blocked before.
 * - An id in two columns: the first position wins.
 * - Note then question on one card: two note actions, the question last. lane.note is
 *   one column, so each kanban text goes FIRST and the previous line is kept after
 *   " || before: " (cut at 2000 chars). A session's status line is never lost (Dave
 *   2026-11-02). lane_event keeps every step.
 */

export const BANDS = { now: 10, next: 20, later: 50, waiting: 70 };
export const WAITING_NOTE = 'Waiting on Dave (kanban)';
export const CARD_STATUSES = ['backlog', 'ready', 'blocked', 'done'];
const WAITING_BAND = [BANDS.waiting, 100];
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

/** First position wins. Returns Map<laneId, {column, index}>. */
function placements(board) {
  const out = new Map();
  if (!isObj(board) || !isObj(board.columns) || !isPending(board.updatedAt, board.syncedAt)) return out;
  for (const column of Object.keys(BANDS)) {
    const ids = Array.isArray(board.columns[column]) ? board.columns[column] : [];
    ids.forEach((id, index) => {
      if (typeof id === 'string' && id && !out.has(id)) out.set(id, { column, index });
    });
  }
  return out;
}

function wasWaiting(lane) {
  return lane.state === 'blocked'
    && (shows(lane.note, WAITING_NOTE)
      || (lane.priority >= WAITING_BAND[0] && lane.priority < WAITING_BAND[1]));
}

const cleanText = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, NOTE_MAX) : null);

/** Dave's text first, the lane's previous line kept after it, so a session's status line is never lost. */
const KEEP_SEP = ' || before: ';
const KEPT_MAX = 2000;
const withPrevious = (text, prev) => (!prev || prev.startsWith(text) ? text : `${text}${KEEP_SEP}${prev}`.slice(0, KEPT_MAX));
const shows = (note, text) => typeof note === 'string' && note.startsWith(text);

/** The state the column asks for, or null for "no opinion". */
function columnState(lane, place) {
  if (!place || lane.state === 'active') return null;
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
  return { status: card.status || null, notes, result: applied };
}

/**
 * @param {{board?: object, cards?: object[]}} input
 * @param {{id: string, state: string, priority: number, note: string|null}[]} lanes
 * @returns {{actions: object[], results: object[], skipped: {laneId: string, reason: string}[]}}
 */
export function planKanban(input, lanes) {
  const inp = isObj(input) ? input : {};
  const rows = new Map((Array.isArray(lanes) ? lanes : []).filter((l) => isObj(l) && l.id).map((l) => [l.id, l]));
  const place = placements(inp.board);
  const cards = new Map();
  for (const c of Array.isArray(inp.cards) ? inp.cards : []) {
    if (isObj(c) && typeof c.id === 'string' && c.id && !cards.has(c.id)) cards.set(c.id, c);
  }

  const actions = [];
  const results = [];
  const skipped = [];
  const act = (laneId, kind, from, to, text) => actions.push({ laneId, kind, from, to, text });

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
      const target = BANDS[p.column] + p.index;
      if (lane.priority !== target) act(id, 'priority', lane.priority, target, `${p.column} #${p.index}`);
    }
    if (read.result?.applied !== false) {
      const want = read.status ?? columnState(lane, p);
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
      const kept = read.result.applied ? { appliedNote: read.result.appliedNote, appliedQuestion: read.result.appliedQuestion } : {};
      results.push({ laneId: id, syncResult, applied: read.result.applied, ...kept });
      if (!read.result.applied && !skipped.some((k) => k.laneId === id)) {
        skipped.push({ laneId: id, reason: syncResult.replace(/^skipped: /, '') });
      }
    }
  }
  return { actions, results, skipped };
}
