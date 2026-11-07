/**
 * kanban-place -- where each lane sits on the board's Priorities kanban.
 *
 * ONE SOURCE, TWO SURFACES. render-board.mjs imports this to draw the first
 * frame on the server, and also inlines this function's source text into the
 * page, where it re-places the cards once the artifact db answers. The tests
 * import the very same function, so no copy of the logic exists anywhere.
 * For that reason the function must stay self-contained: no imports, no
 * outer-scope names, no modern-only syntax (it runs in a browser as-is).
 *
 * doc   : the saved `kanban/board` value, { columns: { now, next, later, waiting } }.
 *         null, undefined or malformed means "nothing saved yet".
 * lanes : [{ id, state, priority }] for every lane, done ones included.
 *
 * Returns { now, next, later, waiting, inProgress }, each a list of lane ids.
 *  - The four columns are Dave's order. Doc order wins, doc column wins.
 *  - Ids in the doc that match no open lane are dropped.
 *  - An active lane is never in the four columns: it is in `inProgress`.
 *  - A done lane is nowhere.
 *  - A lane the doc does not place goes to the END of its default column:
 *    state ready -> next, state blocked -> waiting, anything else -> later.
 *    Defaults sort by DB priority, then by input order. A saved doc always
 *    wins: a blocked lane the doc puts in later stays in later.
 *    Blocked <-> waiting is the same pairing kanban-apply.mjs uses when a
 *    lane moves into or out of the waiting column.
 */
function placeLanes(doc, lanes) {
  var names = ['now', 'next', 'later', 'waiting'];
  var out = { now: [], next: [], later: [], waiting: [], inProgress: [] };
  var byId = {};
  var open = [];
  var i;
  var j;
  for (i = 0; i < lanes.length; i++) {
    if (lanes[i].state !== 'done') {
      byId[lanes[i].id] = lanes[i];
      open.push({ lane: lanes[i], at: i });
    }
  }
  open.sort(function (a, b) {
    var pa = typeof a.lane.priority === 'number' ? a.lane.priority : Infinity;
    var pb = typeof b.lane.priority === 'number' ? b.lane.priority : Infinity;
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.at - b.at;
  });

  var placed = {};
  var cols = doc && typeof doc === 'object' && doc.columns && typeof doc.columns === 'object' ? doc.columns : {};
  for (i = 0; i < names.length; i++) {
    var ids = Array.isArray(cols[names[i]]) ? cols[names[i]] : [];
    for (j = 0; j < ids.length; j++) {
      var id = ids[j];
      if (typeof id !== 'string' || placed[id] || !Object.prototype.hasOwnProperty.call(byId, id)) continue;
      if (byId[id].state === 'active') continue;
      placed[id] = true;
      out[names[i]].push(id);
    }
  }

  for (i = 0; i < open.length; i++) {
    var l = open[i].lane;
    if (l.state === 'active') { out.inProgress.push(l.id); continue; }
    if (placed[l.id]) continue;
    out[l.state === 'ready' ? 'next' : l.state === 'blocked' ? 'waiting' : 'later'].push(l.id);
  }
  return out;
}


/**
 * The helpers below follow the same rule as placeLanes: each is self-contained
 * (they may call each other), plain ES5, and render-board.mjs inlines their
 * source text into the page. The tests import these same functions.
 */

/** Milliseconds for an ISO-ish string, NaN when it is not a date. */
function stampMs(v) {
  if (typeof v !== 'string' || !v) return NaN;
  return Date.parse(v);
}

/**
 * Has Dave changed this doc since the sync last applied it?
 * Works for `cards/<lane>` docs and for `kanban/board`.
 * Pending = no usable syncedAt, or updatedAt is later than syncedAt.
 * Compares instants, not strings: the sync may write another ISO format.
 */
function isPending(doc) {
  if (!doc || typeof doc !== 'object') return false;
  var s = stampMs(doc.syncedAt);
  if (isNaN(s)) return true;
  var u = stampMs(doc.updatedAt);
  return !isNaN(u) && u > s;
}

/** { kind: 'none' | 'pending' | 'synced', at, result } for the card chip. */
function syncState(doc) {
  if (!doc || typeof doc !== 'object') return { kind: 'none', at: '', result: '' };
  if (isPending(doc)) return { kind: 'pending', at: '', result: '' };
  return { kind: 'synced', at: doc.syncedAt, result: typeof doc.syncResult === 'string' ? doc.syncResult : '' };
}

/** FNV-1a, 32 bit, over UTF-16 code units. 8 lowercase hex digits. */
function fnv1a(str) {
  var h = 0x811c9dc5;
  var s = String(str);
  for (var i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/**
 * Hash of the fields a Plain English answer was written from
 * (title, scope, state, last note). JSON keeps the field boundaries, so
 * moving text from one field to the next changes the hash. The length tail
 * makes a 32 bit collision on different-length input much less likely.
 */
function hashFields(parts) {
  var clean = [];
  for (var i = 0; i < parts.length; i++) clean.push(parts[i] === null || parts[i] === undefined ? '' : String(parts[i]));
  var text = JSON.stringify(clean);
  return fnv1a(text) + '-' + text.length.toString(36);
}

/**
 * The status the form starts from. The saved card status counts only while the card
 * is pending (Dave changed it after the last sync). A synced status is history: the
 * lane may have moved since, so the live lane state is the baseline then.
 */
function cardBase(doc, laneState) {
  var four = ['backlog', 'ready', 'blocked', 'done'];
  if (doc && typeof doc === 'object' && four.indexOf(doc.status) >= 0 && isPending(doc)) return doc.status;
  return four.indexOf(laneState) >= 0 ? laneState : '';
}

/**
 * The fields Save must write: only what Dave changed, never `active`.
 *
 * doc       : the saved `cards/<lane>` body, or null.
 * form      : { status, note, question } as typed. status '' means "keep current".
 * laneState : the lane's state when the page was drawn.
 *
 * The status baseline is the saved status while the card is pending, else the lane state. An active lane
 * never gets a status. Note and question are trimmed and cut at 1000 characters.
 */
function cardDiff(doc, form, laneState) {
  var d = doc && typeof doc === 'object' ? doc : {};
  var f = form && typeof form === 'object' ? form : {};
  var four = ['backlog', 'ready', 'blocked', 'done'];
  var out = {};
  var base = cardBase(doc, laneState);
  if (laneState !== 'active' && typeof f.status === 'string' && four.indexOf(f.status) >= 0 && f.status !== base) out.status = f.status;
  var keys = ['note', 'question'];
  for (var i = 0; i < keys.length; i++) {
    var was = typeof d[keys[i]] === 'string' ? d[keys[i]].trim() : '';
    var now = typeof f[keys[i]] === 'string' ? f[keys[i]].trim().slice(0, 1000) : null;
    if (now !== null && now !== was) out[keys[i]] = now;
  }
  return out;
}

/**
 * The prompt for the Plain English button. The sample call has no memory, so
 * it carries everything: who reads it, the lane's facts, its column neighbours,
 * and the exact answer shape.
 *
 * lane   : { id, title, track, state, priority, holder, scope, note }
 * others : ids of the other lanes in the same column.
 */
function plainPrompt(lane, others) {
  var l = lane && typeof lane === 'object' ? lane : {};
  function val(v, max) {
    if (v === null || v === undefined || v === '') return 'not set';
    return String(v).replace(/\s+/g, ' ').slice(0, max || 400);
  }
  var ids = [];
  var list = Array.isArray(others) ? others : [];
  for (var i = 0; i < list.length && i < 20; i++) ids.push(String(list[i]));
  var more = list.length - ids.length;
  var near = ids.length ? ids.join(', ') + (more > 0 ? ' and ' + more + ' more' : '') : 'none';
  return [
    'You are helping Dave. Dave owns the CCv3 harness, a set of tools and rules that configure Claude Code sessions. He reads fast and is not deep in the code.',
    'A "lane" is one unit of work on his board. Explain this lane.',
    '',
    'Lane id: ' + val(l.id),
    'Title: ' + val(l.title),
    'Track: ' + val(l.track),
    'State: ' + val(l.state),
    'Priority number (lower is sooner): ' + val(l.priority),
    'Held by session: ' + val(l.holder),
    'Scope (files or areas it touches): ' + val(l.scope),
    'Last note: ' + val(l.note, 600),
    'Other lanes in the same column: ' + near,
    '',
    'Answer with exactly three short parts, each on its own line, with these labels:',
    'What it is: <one or two plain sentences>',
    'Why it matters: <what breaks or waits without it>',
    'Related to: <other lanes, PRs or files, each explained in a few words>',
    '',
    'Use plain words. No jargon. Use a code name only if you explain it. Use only the facts above, and say "not known" when one is missing. Keep the whole answer under 100 words.',
  ].join('\n');
}

/**
 * Does the saved `kanban/board` doc belong to another board?
 * Every artifact has its own db, but a page published to the wrong artifact would find another board's order there, and its
 * first save would replace it. The page stamps `board` on every save and refuses a doc stamped with another board.
 * A doc with no `board` field is an old doc: allowed, and its next save adds the field.
 * Fails closed: a stamp that is not exactly the page's board (null, a number, other case) counts as foreign.
 */
function boardMismatch(doc, board) {
  if (!doc || typeof doc !== 'object' || !Object.prototype.hasOwnProperty.call(doc, 'board')) return false;
  return doc.board !== board;
}

/**
 * How the page writes `kanban/board`: 'update' when the doc exists, 'set' only to create it.
 * `set` replaces the whole doc, so on an existing doc it would drop appliedColumns and syncedAt, which only the sync writes.
 * `update` merges top-level fields and leaves those two alone.
 */
function boardWriteKind(doc) {
  return doc && typeof doc === 'object' ? 'update' : 'set';
}

/**
 * The columns the page saves: its own, plus the ids of the saved doc that the page does not know.
 * A device with an old page must not drop lanes it has never heard of. Each unknown id returns in the column the saved doc
 * had it in, after the page's own ids. An id the page knows is never merged back: the page placed it (or dropped it, when
 * the lane is done). Pruning ids of done or deleted lanes is the job of the kanban-sync write-back, not of this page.
 *
 * doc     : the saved `kanban/board` value, or null.
 * columns : { now, next, later, waiting }, the page's columns. Not changed.
 * lanes   : [{ id }] every lane the page knows, done ones included.
 */
function mergeUnknownColumns(doc, columns, lanes) {
  var names = ['now', 'next', 'later', 'waiting'];
  var known = Object.create(null);
  var seen = Object.create(null);
  var out = {};
  var i;
  var j;
  for (i = 0; i < lanes.length; i++) known[lanes[i].id] = true;
  for (i = 0; i < names.length; i++) {
    out[names[i]] = Array.isArray(columns[names[i]]) ? columns[names[i]].slice() : [];
    for (j = 0; j < out[names[i]].length; j++) seen[out[names[i]][j]] = true;
  }
  var saved = doc && typeof doc === 'object' && doc.columns && typeof doc.columns === 'object' ? doc.columns : {};
  for (i = 0; i < names.length; i++) {
    var ids = Array.isArray(saved[names[i]]) ? saved[names[i]] : [];
    for (j = 0; j < ids.length; j++) {
      var id = ids[j];
      if (typeof id !== 'string' || id === '' || known[id] || seen[id]) continue;
      seen[id] = true;
      out[names[i]].push(id);
    }
  }
  return out;
}

/**
 * How many open lanes stay above this lane in By band after a Do next: lanes with state other than done
 * whose band is better. P0 is best, then P1, then P2, then Unsorted (no band, or a band this page does not know).
 * An unknown id gives 0. A lane never counts itself, so Unsorted counts every banded open lane.
 *
 * lanes : [{ id, state, band }] every lane the page knows.
 */
function bandAhead(lanes, id) {
  var order = { P0: 0, P1: 1, P2: 2 };
  var rankOf = function (band) { return Object.prototype.hasOwnProperty.call(order, band) ? order[band] : 3; };
  if (!Array.isArray(lanes)) return 0;
  var mine = -1;
  var i;
  for (i = 0; i < lanes.length; i++) {
    if (lanes[i] && lanes[i].id === id) { mine = rankOf(lanes[i].band); break; }
  }
  if (mine < 0) return 0;
  var n = 0;
  for (i = 0; i < lanes.length; i++) {
    if (lanes[i] && lanes[i].id !== id && lanes[i].state !== 'done' && rankOf(lanes[i].band) < mine) n++;
  }
  return n;
}

/**
 * Does the card show "Done, waiting for sync"? The saved card says done, Dave changed it after the last sync,
 * and the lane is not done yet. After the sync, or on a lane that is done, the chip is gone.
 */
function doneChip(doc, laneState) {
  return isPending(doc) && doc.status === 'done' && laneState !== 'done';
}

export { placeLanes, stampMs, isPending, syncState, fnv1a, hashFields, cardBase, cardDiff, plainPrompt, boardMismatch, boardWriteKind, mergeUnknownColumns, bandAhead, doneChip };
