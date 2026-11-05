#!/usr/bin/env node
/**
 * render-board -- generate the lane board from the database.
 *
 * The previous board was hand-written HTML. It was accurate the day it was
 * written and began rotting the same afternoon: two of its own chip counts
 * disagreed with the filters computing them, and its lane states were a
 * transcription of a moment. A board that reports coordination has to be
 * generated from the thing it reports on, or it becomes a second source of
 * truth that quietly disagrees with the first.
 *
 * So every number here is a query, and the queries are printed on the page --
 * the affordance the hand-written board introduced and the one worth keeping.
 * Any figure can be falsified in about ten seconds.
 *
 * One page per board. The board comes from --project <key>, else LANE_PROJECT, else the registry entry that holds the cwd.
 * A cwd with no board exits 1 with the register hint. continuous-claude writes <repo>/lane-board.html (the phone page);
 * every other board writes <repo>/lane-board-<key>.html, read-only. It shows a static Priorities section (the five columns
 * drawn from lane state and priority) and carries no kanban script and no db: the save is keyed by lane id, and the page
 * db is one document that only the published continuous-claude artifact can open. The lane, session and event queries are
 * filtered to the board. The file-claim and
 * coordination_event sections are machine-wide and say so on the page. The page carries a stamp
 * (<meta name="lane-board">: board, template hash, generated time) and a "generated N min ago" badge.
 *
 * Usage: node scripts/coordination/render-board.mjs [--project <key>] [--interactive] [--out <file>] [out.html]
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  placeLanes, stampMs, isPending, syncState, fnv1a, hashFields, cardBase, cardDiff, plainPrompt,
  boardMismatch, boardWriteKind, mergeUnknownColumns,
} from './kanban-place.mjs';
import { DEFAULT_BOARD, boardRoots, laneCliCmd, renderBoardCmd, resolveBoard } from './lane-board.mjs';
import { boardStamp, defaultOut, parseRenderArgs, writeAtomic } from './render-board-args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const STALE_MINUTES = 5;
/** A session seen inside this window, or holding an open lane, still counts as "open, quiet" when it is not active. The sessions table keeps dead rows for days, so a longer window inflates the count. */
const QUIET_HOURS = 2;

function usage(message, code) {
  console.error(`${message}\nusage: node scripts/coordination/render-board.mjs [--project <key>] [--interactive] [--out <file>] [out.html]`);
  process.exit(code);
}

let args;
try { args = parseRenderArgs(process.argv.slice(2)); } catch (err) { usage(err.message, 2); }

// The board: --project, else LANE_PROJECT, else the cwd's registry entry. An unknown key throws; no board is an error with the hint.
let BOARD;
try {
  BOARD = resolveBoard(process.cwd(), { cli: true, projectFlag: args.project ?? undefined });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (!BOARD) {
  const cwd = process.cwd().replace(/\\/g, '/');
  console.error(`no lane board for ${cwd}; register it: ${laneCliCmd()} project register ${cwd}\nOr pass --project <key> (the registered boards: ${laneCliCmd()} project which).`);
  process.exit(1);
}
const KEY = BOARD.key;
/** The interactive kanban: the default board always, any other board with --interactive. The page saves into its own artifact
 *  db, so --interactive is for a page that will be published as that board's own artifact. A board without the flag keeps the
 *  static, read-only Priorities section. Interactivity and identity are separate: the title and masthead test KEY, not KANBAN. */
const KANBAN = KEY === DEFAULT_BOARD || args.interactive;
const OUT = args.out || defaultOut(REPO, KEY);
const BOARD_ROOTS = boardRoots(KEY);
const GENERATED_AT = new Date();

function loadPg() {
  for (const a of [join(REPO, '.claude', 'hooks', 'package.json'), join(REPO, 'apps', 'agentic-os', 'package.json')]) {
    try { return createRequire(pathToFileURL(a)).call(null, 'pg'); } catch { /* next */ }
  }
  throw new Error('cannot resolve pg');
}
const { Client } = loadPg();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (s) => (s ? String(s).slice(0, 8) : '');

/** Local time, stated as local. The DB runs UTC and this machine runs UTC-5;
 *  a previous render stamped the masthead with the UTC clock and dated the
 *  board a day into the future. */
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ago(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** `sessions.project` folded the way normalizeRoot folds a path (the SQL twin, steps in the same order): forward
 *  slashes (chr(92) is a backslash), the `//?/` or `//./` extended-length prefix dropped, lower case, a leading
 *  /c/ becomes c:/, runs of slashes collapse to one (not at the very start), no trailing slash.
 *  TWIN of FOLDED_PROJECT in lane.mjs (that file runs a command on import, so it cannot be imported). render-board.test.mjs pins the two. */
const FOLDED_PROJECT = (alias = 's.') =>
  `rtrim(regexp_replace(regexp_replace(lower(regexp_replace(replace(${alias}project, chr(92), '/'), '^//[?.]/', '')), ` +
  `'^/([a-z])(/|$)', '\\1:\\2'), '(?<=.)/{2,}', '/', 'g'), '/')`;

/** SQL: the session belongs to the board. $1 = board key, $2 = the board's registry roots. starts_with, never LIKE: paths hold `_`. */
const PEER_OF_BOARD_SQL = `(
  EXISTS (SELECT 1 FROM unnest($2::text[]) r
           WHERE ${FOLDED_PROJECT()} = r OR starts_with(${FOLDED_PROJECT()}, r || '/'))
  OR EXISTS (SELECT 1 FROM agentic_os.lane bl
              WHERE bl.owner_session_id = s.id AND bl.project_key = $1::text))`;

const c = new Client({
  connectionString: process.env.CONTINUOUS_CLAUDE_DB_URL || process.env.DATABASE_URL
    || 'postgresql://claude:claude_dev@localhost:5432/continuous_claude',
  connectionTimeoutMillis: 5000,
});
await c.connect();

/**
 * HELD IS NOT "HAS AN OWNER" -- it is "has an owner who is still there".
 *
 * The headline counter used to be `open.filter((l) => l.owner_session_id).length`
 * in JS, which never read `lease_expires_at`. So the page said "1 held now" while
 * the row underneath it correctly printed "lease lapsed", and the reconciliation
 * query printed beneath the counter advertised a predicate the code did not
 * apply. A board whose headline disagrees with its own detail rows is worse than
 * no board, because the headline is the part people read.
 *
 * `held_now` is the exact complement of lane.mjs's RECLAIMABLE predicate: BOTH an
 * expired lease AND a holder quiet ${STALE_MINUTES}m make a lane reclaimable, so
 * a lane is genuinely held unless both hold. Not either: an expired lease on a
 * live session means the owner is slow, not gone, and a dead session inside its
 * lease is still dead.
 *
 * Spelled in SQL here rather than imported from lane.mjs on purpose -- lane.mjs
 * executes a command at import time, so it is not importable, and
 * liveness-predicate-guard.mjs asserts a MINIMUM count of correct predicate
 * spellings per file (it guards the question by count across sites precisely
 * because the predicate spans four languages). Moving this out of the file would
 * drop that count. The guard is the thing that keeps the two spellings agreeing.
 */
const lanes = (await c.query(`
  SELECT l.*,
         (l.owner_session_id IS NOT NULL AND NOT (
            (l.lease_expires_at IS NULL OR l.lease_expires_at < now())
            AND NOT EXISTS (
              SELECT 1 FROM sessions s
              WHERE s.id = l.owner_session_id
                AND GREATEST(s.last_heartbeat, s.last_activity_at) > now() - interval '${STALE_MINUTES} minutes'
            )
         )) AS held_now
    FROM agentic_os.lane l
   WHERE l.project_key = $1::text
   ORDER BY l.track, l.priority, l.id`, [KEY])).rows;

// The sessions of this board: under one of its registry roots, or holding one of its lanes (a session started in the home dir).
// The same rule as lane.mjs peers; the lanes listed under a session are this board's lanes only.
const sessions = (await c.query(
  `SELECT s.id, s.working_on,
          GREATEST(s.last_heartbeat, s.last_activity_at) AS last_heartbeat,
          COALESCE(json_agg(json_build_object('id',l.id,'title',l.title,'scope',l.scope,'note',l.note)
            ORDER BY l.priority) FILTER (WHERE l.id IS NOT NULL), '[]') AS lanes
   FROM sessions s
   LEFT JOIN agentic_os.lane l ON l.owner_session_id = s.id AND l.state <> 'done' AND l.project_key = $1::text
   WHERE GREATEST(s.last_heartbeat, s.last_activity_at) > now() - interval '${STALE_MINUTES} minutes'
     AND ${PEER_OF_BOARD_SQL}
   GROUP BY s.id, s.working_on, s.last_heartbeat, s.last_activity_at
   ORDER BY GREATEST(s.last_heartbeat, s.last_activity_at) DESC`, [KEY, BOARD_ROOTS],
)).rows;

// "Open, quiet": of this board, not active (beat more than STALE_MINUTES ago), and either seen inside QUIET_HOURS or holding a
// non-done lane of this board. Heartbeat moves on a tool call or a prompt only, so a session waiting for Dave looks dead after
// STALE_MINUTES while it still holds lanes. This counts it; it changes no claim or reclaim rule. lane.mjs board prints the same count.
// An ended session (ended_at is its latest signal, the agentic-os rule) is never open, even when it still holds a lane.
// The active count and this one are two statements with two now() values; a session on the 5 minute line can be missed once.
const quietCount = (await c.query(
  `SELECT count(*)::int AS n FROM sessions s
   WHERE GREATEST(s.last_heartbeat, s.last_activity_at) <= now() - interval '${STALE_MINUTES} minutes'
     AND NOT COALESCE(s.ended_at >= GREATEST(s.last_heartbeat, COALESCE(s.last_activity_at, s.last_heartbeat)), false)
     AND ${PEER_OF_BOARD_SQL}
     AND (GREATEST(s.last_heartbeat, s.last_activity_at) > now() - interval '${QUIET_HOURS} hours'
          OR EXISTS (SELECT 1 FROM agentic_os.lane ql WHERE ql.owner_session_id = s.id AND ql.state <> 'done' AND ql.project_key = $1::text))`,
  [KEY, BOARD_ROOTS],
)).rows[0].n;

const events = (await c.query(
  `SELECT * FROM agentic_os.lane_event WHERE project_key = $1::text ORDER BY id DESC LIMIT 30`, [KEY],
)).rows;

const claimHealth = (await c.query(
  `SELECT count(*) FILTER (WHERE s.id IS NULL)::int AS orphaned,
          count(*) FILTER (WHERE GREATEST(s.last_heartbeat, s.last_activity_at) <  now() - interval '5 min')::int AS stale,
          count(*) FILTER (WHERE GREATEST(s.last_heartbeat, s.last_activity_at) >= now() - interval '5 min')::int AS live
   FROM file_claims fc LEFT JOIN sessions s ON s.id = fc.session_id`,
)).rows[0];

const eventKinds = (await c.query(
  `SELECT kind, count(*)::int AS n FROM agentic_os.coordination_event
   WHERE occurred_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`,
)).rows;

await c.end();

// ------------------------------------------------------------------ derive

const open = lanes.filter((l) => l.state !== 'done');
const byState = (s) => open.filter((l) => l.state === s).length;
const held = open.filter((l) => l.held_now).length;
const tracks = [...new Set(lanes.map((l) => l.track))];

const STRIPE = {
  active: 's-ok', ready: 's-info', blocked: 's-crit',
  review: 's-warn', backlog: 's-idle', done: 's-done',
};
const PILL = {
  active: 'p-ok', ready: 'p-info', blocked: 'p-crit',
  review: 'p-warn', backlog: 'p-idle', done: 'p-idle',
};

// ------------------------------------------------------------------ markup

const laneRow = (l, i) => {
  const owner = l.owner_session_id;
  const leaseMin = l.lease_expires_at
    ? Math.round((new Date(l.lease_expires_at) - Date.now()) / 60000) : null;
  const detailId = `d${i}`;
  return `
  <button class="lane${l.held_now ? ' is-held' : ''}" aria-expanded="false" aria-controls="${detailId}" data-state="${esc(l.state)}" data-track="${esc(l.track)}" data-held="${l.held_now ? '1' : '0'}">
    <span class="stripe ${STRIPE[l.state] || 's-idle'}"></span>
    <span class="nm">${esc(l.id)}<small>${esc(l.title)}</small></span>
    <span class="state-c"><span class="pill ${PILL[l.state] || 'p-idle'}">${esc(l.state)}</span></span>
    <span class="own">${owner
      ? `<span class="who">${esc(short(owner))}</span>${leaseMin !== null
        ? `<span class="lease${leaseMin <= 0 ? ' lapsed' : ''}">${leaseMin > 0 ? `${leaseMin}m left` : 'lease lapsed'}</span>` : ''}`
      : '<span class="free">unclaimed</span>'}</span>
    <span class="scope">${esc(l.scope || '')}</span>
    <span class="age">${esc(ago(l.updated_at))}</span>
  </button>
  <div class="detail" id="${detailId}">
    <dl>
      <dt>track</dt><dd>${esc(l.track)}</dd>
      ${l.branch ? `<dt>branch</dt><dd>${esc(l.branch)}</dd>` : ''}
      ${l.scope ? `<dt>scope</dt><dd>${esc(l.scope)}</dd>` : ''}
      ${owner ? `<dt>holder</dt><dd>${esc(owner)} · fence ${esc(l.fence)}</dd>` : ''}
      ${l.note ? `<dt>status</dt><dd>${esc(l.note)}</dd>` : ''}
      ${l.done_when ? `<dt>done when</dt><dd>${esc(l.done_when)}</dd>` : ''}
    </dl>
    ${l.rationale ? `<p class="why">${esc(l.rationale)}</p>` : ''}
    <p class="cmd">${esc(laneCliCmd())} ${owner ? `note ${esc(l.id)} "…"` : `claim ${esc(l.id)}`}</p>
  </div>`;
};

// ------------------------------------------------------------ priorities kanban
// Server-side first frame: every open lane in its default column, so the page is
// complete with no script. kanban-client.js re-places the cards from the saved
// order. One placement function (kanban-place.mjs) serves both.

const KB_COLS = [
  ['now', 'Now'], ['next', 'Next'], ['later', 'Later'], ['waiting', 'Waiting on Dave'],
];
const kbPrio = (l) => (l.priority != null && Number.isFinite(Number(l.priority)) ? Number(l.priority) : null);
const kbLanes = lanes.map((l) => ({ id: l.id, state: l.state, priority: kbPrio(l) }));
const kbPlaced = placeLanes(null, kbLanes);
const kbById = new Map(lanes.map((l) => [l.id, l]));
// The page also needs each lane's facts for the Plain English prompt. placeLanes
// reads only id, state and priority, so the extra keys are inert there.
// The read-only page has no kb-data block, so it builds none.
const kbJson = KANBAN ? JSON.stringify(lanes.map((l, i) => ({
  ...kbLanes[i], title: l.title || '', track: l.track || '', holder: short(l.owner_session_id),
  scope: l.scope || '', note: l.note || '',
}))).replace(/</g, '\\u003c') : '';
const KB_STATUS = ['backlog', 'ready', 'blocked', 'done'];
// Hash of what a Plain English answer was written from. Computed here, read from
// data-hash by the page, so the page never rebuilds it from DOM text.
const kbHash = (l) => hashFields([l.title, l.scope, l.state, l.note]);
let kbSeq = 0;

// The holder line of an In progress card: who holds it and how long the lease has left.
// ro: the read-only page has no script to refresh a countdown, so it shows the lease end as a clock time.
const kbLeaseEnd = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const kbHolder = (l, ro = false) => {
  const owner = l.owner_session_id;
  const leaseMin = l.lease_expires_at
    ? Math.round((new Date(l.lease_expires_at) - Date.now()) / 60000) : null;
  if (ro) {
    const end = l.lease_expires_at ? kbLeaseEnd(l.lease_expires_at) : '';
    return `<div class="kb-holder">${owner
      ? `<span class="kb-who mono">${esc(short(owner))}</span>${leaseMin !== null && leaseMin <= 0
        ? `<span class="pill p-warn">LAPSED</span><span class="kb-lease mono">lease ended ${esc(end)}</span>`
        : leaseMin !== null ? `<span class="kb-lease mono">lease ends ${esc(end)}</span>` : ''}`
      : '<span class="kb-lease mono">unclaimed</span>'}</div>`;
  }
  return `<div class="kb-holder">${owner
    ? `<span class="kb-who mono">${esc(short(owner))}</span>${leaseMin !== null && leaseMin <= 0
      ? '<span class="pill p-warn">LAPSED</span>' : leaseMin !== null ? `<span class="kb-lease mono">${leaseMin}m left</span>` : ''}`
    : '<span class="kb-lease mono">unclaimed</span>'}</div>`;
};

// ro = the read-only page of a board other than continuous-claude: no controls, no hidden panels, no script. The default
// page never passes ro, so its strings stay byte-identical.
const kbCard = (l, movable, rank, col, ro = false) => {
  const n = kbSeq++;
  const prio = kbPrio(l) !== null ? `<span class="kb-prio mono" title="DB priority">prio ${kbPrio(l)}</span>` : '';
  if (ro) {
    return `<li class="card kb-card kb-ro" data-id="${esc(l.id)}" data-state="${esc(l.state)}" data-hash="${esc(kbHash(l))}">
      <div class="kb-top">${movable ? `<span class="kb-rank mono" title="Priority order (not a saved order)">${rank}</span>` : ''}<span class="kb-id mono">${esc(l.id)}</span></div>
      <p class="kb-title">${esc(l.title)}</p>
      <div class="kb-meta"><span class="pill ${PILL[l.state] || 'p-idle'}">${esc(l.state)}</span><span class="kb-track mono">${esc(l.track)}</span>${prio}</div>
      ${movable ? '' : kbHolder(l, true)}
      <details class="kb-ro-detail"><summary>Details<span class="sr"> for ${esc(l.id)}</span></summary>
        <dl class="kb-dl">
          <dt>scope</dt><dd>${esc(l.scope || 'none set')}</dd>
          <dt>last note</dt><dd>${esc(l.note || 'none')}</dd>
        </dl>
      </details>
    </li>`;
  }
  const statusOpts = movable
    ? `${KB_STATUS.includes(l.state) ? '' : `<option value="" selected>Keep current (${esc(l.state)})</option>`}${KB_STATUS.map((st) => `<option value="${st}"${st === l.state ? ' selected' : ''}>${st}</option>`).join('')}`
    : '<option value="" selected>Active: a session holds it</option>';
  return `<li class="card kb-card" data-id="${esc(l.id)}" data-state="${esc(l.state)}" data-hash="${esc(kbHash(l))}">
      <div class="kb-top">${movable ? `<span class="kb-rank mono" title="Rank in this column">${rank}</span>` : ''}<span class="kb-id mono">${esc(l.id)}</span>${movable ? '<span class="kb-grip" title="Drag to move" aria-hidden="true">&#8942;&#8942;</span>' : ''}</div>
      <p class="kb-title">${esc(l.title)}</p>
      <div class="kb-meta"><span class="pill ${PILL[l.state] || 'p-idle'}">${esc(l.state)}</span><span class="kb-track mono">${esc(l.track)}</span>${prio}<span class="kb-sync" hidden></span></div>
      ${movable ? '' : kbHolder(l)}
      <button class="kb-btn kb-plain" type="button" hidden aria-expanded="false" aria-controls="kb-p${n}">Plain English</button>
      <p class="kb-plain-out" id="kb-p${n}" role="status" hidden></p>
      <button class="kb-more" type="button" aria-expanded="false" aria-controls="kb-d${n}">Details</button>
      <div class="kb-detail" id="kb-d${n}" hidden>
        <dl class="kb-dl">
          <dt>scope</dt><dd>${esc(l.scope || 'none set')}</dd>
          <dt>last note</dt><dd>${esc(l.note || 'none')}</dd>
        </dl>
        <div class="kb-edit">
          <label class="kb-fl"><span>Status</span><select class="kb-st" disabled>${statusOpts}</select></label>
          <label class="kb-fl"><span>Note to Claude</span><textarea class="kb-note" rows="3" maxlength="1000" disabled></textarea></label>
          <label class="kb-fl"><span>Question for Claude</span><textarea class="kb-q" rows="3" maxlength="1000" disabled></textarea></label>
          <div class="kb-sv"><button class="kb-btn kb-save" type="button" disabled>Save</button><span class="kb-saved" role="status"></span></div>
          <p class="kb-why"></p>
        </div>
      </div>
      ${movable ? `<div class="kb-ctl">
        <button class="kb-btn kb-up" type="button" aria-label="Move ${esc(l.id)} up" disabled>Up</button>
        <button class="kb-btn kb-dn" type="button" aria-label="Move ${esc(l.id)} down" disabled>Down</button>
        <label class="kb-mv">Move to <select class="kb-to" aria-label="Move ${esc(l.id)} to column" disabled>${KB_COLS.map(([k, name]) => `<option value="${k}"${k === col ? ' selected' : ''}>${name}</option>`).join('')}</select></label>
      </div>` : ''}
    </li>`;
};

// ro: the heading is plain text (no button), because no script makes it collapse.
const kbColumn = (key, name, ids, movable, ro = false) => `<div class="kcol"${movable ? ` data-col="${key}"` : ' data-col="progress" data-fixed="1"'} data-n="${ids.length}">
    ${ro
    ? `<h3 class="kb-h kb-ro-h"><span class="kb-name">${name}</span><span class="kb-count mono">${ids.length}</span></h3>`
    : `<h3 class="kb-h"><button class="kb-head" type="button" aria-expanded="true" aria-controls="kb-list-${key}"><span class="kb-name">${name}</span><span class="kb-count mono">${ids.length}</span></button></h3>`}
    ${movable || ro ? '' : '<p class="kb-sub">Held by a session. Not reorderable.</p>'}
    <ul class="kb-list" id="kb-list-${key}">${ids.length === 0 && ro
    ? `<li class="kb-empty">${KB_RO_EMPTY[key] || 'Nothing here'}</li>`
    : ids.map((id, i) => kbCard(kbById.get(id), movable, i + 1, key, ro)).join('')}</ul>
  </div>`;

// The client script is plain ES5 text: placeLanes' own source, then the page code.
// Only the default board's page carries the kanban client and its script. Another board's page has a static Priorities section
// (kbColumn with ro) and no script: Details uses <details>, the columns do not collapse, nothing saves.
const kbClient = KANBAN ? readFileSync(join(HERE, 'kanban-client.js'), 'utf8') : '';
if (/<\/script/i.test(kbClient)) throw new Error('kanban-client.js must not contain a closing script tag');
// KB_BOARD names the board that owns this page: the client stamps it on every save and refuses a saved order stamped with another.
const kbScript = KANBAN ? `${[placeLanes, stampMs, isPending, syncState, fnv1a, hashFields, cardBase, cardDiff, plainPrompt, boardMismatch, boardWriteKind, mergeUnknownColumns].map((f) => f.toString()).join('\n')}
var KB_BOARD = ${JSON.stringify(KEY).replace(/</g, '\\u003c')};
${kbClient}` : '';

// The template hash: what a page was rendered from. It covers this file and the kanban sources, so a page rendered from an
// older generator shows a different hash. Read it back from the live page after a republish.
const TEMPLATE_HASH = fnv1a(['render-board.mjs', 'render-board-args.mjs', 'kanban-client.js', 'kanban-place.mjs']
  .map((f) => readFileSync(join(HERE, f), 'utf8').replace(/\r\n/g, '\n')).join('\n--\n'));
const STAMP = boardStamp({ board: KEY, template: TEMPLATE_HASH, generated: GENERATED_AT.toISOString() });
const PAGE_TITLE = KEY === DEFAULT_BOARD ? 'Agentic OS — Lane Board' : `Agentic OS — Lane Board (${KEY})`;

const KB_RO_INTRO = 'Read-only snapshot from the last render. Columns come from lane state and priority. Lease times are clock times, not countdowns.';
const KB_RO_NO_ORDER = 'Nothing is saved here: this board has no saved order.';
// An empty read-only column says why. Now and Waiting on Dave are only filled from a saved order, and this board has none.
const KB_RO_EMPTY = { now: KB_RO_NO_ORDER, waiting: KB_RO_NO_ORDER };
// CSS for the read-only section only. Emitted when !KANBAN, so the default page's CSS bytes do not change.
// Small text uses --muted here, not --faint: --faint is below 4.5:1 on the card and column backgrounds.
const KB_RO_CSS = `
  /* Read-only Priorities (boards other than continuous-claude): plain headings and native <details>, no script. */
  .kb-ro-h { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 4px; color:var(--ink);
    font:600 12px/1.2 var(--mono); letter-spacing:.04em; }
  .kb-ro .kb-title { display:block; overflow:visible; }
  .kb-ro .kb-track, .kb-ro .kb-prio, .kb-ro .kb-lease, .kb-ro .kb-dl dt { color:var(--muted); }
  .kb-ro .kcol[data-n="0"] .kb-list::after { content:none; }
  .kb-ro .kb-empty { padding:14px 10px; border:1px dashed var(--line); border-radius:var(--r); color:var(--muted);
    font:400 11px/1.4 var(--mono); text-align:center; overflow-wrap:anywhere; }
  .kb-ro-detail { margin-top:8px; min-width:0; }
  .kb-ro-detail > summary { padding:4px 0; color:var(--info); font:500 11px/1.4 var(--mono); cursor:pointer; list-style-position:inside; }
  .kb-ro-detail > summary:hover { text-decoration:underline; }
  .kb-ro-detail[open] > summary { margin-bottom:8px; }
  @media (pointer:coarse), (max-width:720px) { .kb-ro-detail > summary { min-height:44px; box-sizing:border-box; padding:14px 0 4px; } }`;

const html = `${STAMP}
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(PAGE_TITLE)}</title>
<style>
  :root {
    /* Carried from the 07-27 board so this reads as the same page, not a new one.
       Teal-biased neutrals: a grey chosen against the accent, not inherited. */
    --ground:#F4F7F7; --panel:#FFFFFF; --panel-2:#EDF2F2;
    --line:#D6E1E1; --line-soft:#E6EDED;
    --ink:#0F1A1D; --muted:#5C6E71; --faint:#849698;
    --ok:#0B7C72; --warn:#A8630A; --crit:#B23A32; --info:#2A6296; --agent:#6B57B0;
    --ok-bg:#E2F1EF; --warn-bg:#F8EEDD; --crit-bg:#F8E6E4; --info-bg:#E4EDF6;
    --mono: ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace;
    --sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif;
    --display:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;
    --r:8px; --shadow:0 1px 2px rgba(15,26,29,.05),0 8px 24px rgba(15,26,29,.05);
    --live:#0B7C72; --live-halo:rgba(11,124,114,.18);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground:#0E1417; --panel:#161F23; --panel-2:#1C282D;
      --line:#2A383E; --line-soft:#223037;
      --ink:#E6EFEF; --muted:#93A6AA; --faint:#6D8188;
      --ok:#3FB8A6; --warn:#D99A3C; --crit:#E4736A; --info:#6BA3DA; --agent:#A48EE8;
      --ok-bg:#12302E; --warn-bg:#33280F; --crit-bg:#331C1A; --info-bg:#14283A;
      --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.25);
      --live:#3FB8A6; --live-halo:rgba(63,184,166,.22);
    }
  }
  :root[data-theme="dark"] {
    --ground:#0E1417; --panel:#161F23; --panel-2:#1C282D;
    --line:#2A383E; --line-soft:#223037;
    --ink:#E6EFEF; --muted:#93A6AA; --faint:#6D8188;
    --ok:#3FB8A6; --warn:#D99A3C; --crit:#E4736A; --info:#6BA3DA; --agent:#A48EE8;
    --ok-bg:#12302E; --warn-bg:#33280F; --crit-bg:#331C1A; --info-bg:#14283A;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.25);
    --live:#3FB8A6; --live-halo:rgba(63,184,166,.22);
  }
  :root[data-theme="light"] {
    --ground:#F4F7F7; --panel:#FFFFFF; --panel-2:#EDF2F2;
    --line:#D6E1E1; --line-soft:#E6EDED;
    --ink:#0F1A1D; --muted:#5C6E71; --faint:#849698;
    --ok:#0B7C72; --warn:#A8630A; --crit:#B23A32; --info:#2A6296; --agent:#6B57B0;
    --ok-bg:#E2F1EF; --warn-bg:#F8EEDD; --crit-bg:#F8E6E4; --info-bg:#E4EDF6;
    --shadow:0 1px 2px rgba(15,26,29,.05),0 8px 24px rgba(15,26,29,.05);
    --live:#0B7C72; --live-halo:rgba(11,124,114,.18);
  }

  * { box-sizing:border-box; }
  body { margin:0; background:var(--ground); color:var(--ink); font:14px/1.55 var(--sans); -webkit-font-smoothing:antialiased; }
  .wrap { width:min(1240px,100%); margin:0 auto; padding:0 20px 72px; }
  h1,h2 { margin:0; text-wrap:balance; }
  .mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }
  :focus-visible { outline:2px solid var(--ok); outline-offset:2px; border-radius:3px; }

  header.top { position:sticky; top:0; z-index:30; background:color-mix(in srgb,var(--ground) 88%,transparent);
    backdrop-filter:blur(10px); border-bottom:1px solid var(--line); margin-bottom:24px; }
  .top-in { width:min(1240px,100%); margin:0 auto; padding:12px 20px; display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
  .brand { display:flex; align-items:center; gap:10px; }
  .mark { width:30px; height:30px; border-radius:7px; display:grid; place-items:center; background:var(--ink); color:var(--ground); font:700 10px/1 var(--mono); }
  .brand b { font:650 15px/1.2 var(--display); letter-spacing:-.02em; }
  .brand span span { display:block; font:400 11px/1.3 var(--mono); color:var(--faint); }
  .counters { display:flex; gap:8px; margin-left:auto; flex-wrap:wrap; }
  .ctr { display:flex; align-items:baseline; gap:7px; padding:6px 11px; border:1px solid var(--line); border-radius:999px; background:var(--panel); }
  .ctr b { font:650 15px/1 var(--mono); font-variant-numeric:tabular-nums; }
  .ctr span { font:500 10px/1 var(--mono); letter-spacing:.07em; text-transform:uppercase; color:var(--muted); }
  .ctr.is-ok { border-color:var(--ok); background:var(--ok-bg); } .ctr.is-ok b { color:var(--ok); }
  .ctr.is-crit { border-color:var(--crit); background:var(--crit-bg); } .ctr.is-crit b { color:var(--crit); }
  .themebtn { border:1px solid var(--line); background:var(--panel); color:var(--muted); border-radius:999px; padding:7px 12px; cursor:pointer; font:500 11px/1 var(--mono); }
  .themebtn:hover { color:var(--ink); border-color:var(--muted); }
  .gen { color:var(--muted); } .gen.stale { color:var(--warn); font-weight:600; }

  section { margin-top:30px; }
  .sec-head { display:flex; align-items:baseline; gap:14px; margin-bottom:12px; flex-wrap:wrap; }
  .sec-head h2 { font:620 17px/1.2 var(--display); letter-spacing:-.015em; }
  .sec-head p { margin:0; color:var(--muted); font-size:12.5px; max-width:62ch; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); }

  /* NOW -- the summary before the detail. Liveness is the thing a generated
     board can show that a hand-written one never could, so it leads. */
  .now { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px; }
  .sess { padding:15px 16px; position:relative; }
  .sess::before { content:''; position:absolute; left:0; top:12px; bottom:12px; width:3px; border-radius:0 3px 3px 0; background:var(--live); }
  .sess .sid { font:600 13px/1 var(--mono); display:flex; align-items:center; gap:8px; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--live); box-shadow:0 0 0 4px var(--live-halo); }
  @media (prefers-reduced-motion: no-preference) { .dot { animation:pulse 2.6s ease-in-out infinite; } }
  @keyframes pulse { 0%,100% { box-shadow:0 0 0 3px var(--live-halo); } 50% { box-shadow:0 0 0 6px var(--live-halo); } }
  .sess .doing { margin:7px 0 10px; color:var(--muted); font-size:12px; }
  .sess ul { margin:0; padding-left:0; list-style:none; display:flex; flex-direction:column; gap:7px; }
  .sess li { border-top:1px solid var(--line-soft); padding-top:7px; }
  .sess li b { font:600 12px/1.4 var(--mono); }
  .sess li span { display:block; color:var(--muted); font-size:11.5px; }
  .sess .none { color:var(--faint); font:400 12px/1.5 var(--mono); }

  .filters { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:12px; }
  .chip { border:1px solid var(--line); background:var(--panel); color:var(--muted); border-radius:999px; padding:6px 12px; cursor:pointer; font:500 11px/1 var(--mono); }
  .chip:hover { border-color:var(--muted); color:var(--ink); }
  .chip[aria-pressed="true"] { background:var(--ink); color:var(--ground); border-color:var(--ink); }

  .grp-h { display:flex; align-items:center; gap:10px; padding:14px 2px 7px; }
  .grp-h .nm { font:600 12px/1 var(--mono); letter-spacing:.04em; }
  .grp-h .ct { font:500 10px/1 var(--mono); color:var(--faint); }
  .grp-h .rule { flex:1; height:1px; background:var(--line); }

  .lane { display:grid; grid-template-columns:3px minmax(190px,1.5fr) 96px 150px 1fr 60px; align-items:center;
    border:1px solid var(--line); border-radius:var(--r); background:var(--panel); margin-bottom:6px;
    cursor:pointer; text-align:left; width:100%; padding:0; font:inherit; color:inherit;
    transition:border-color .12s ease, transform .12s ease; }
  .lane:hover { border-color:var(--muted); transform:translateX(1px); }
  .lane.is-held { border-color:color-mix(in srgb,var(--live) 45%,var(--line)); }
  .lane > * { padding:10px 13px; min-width:0; }
  .stripe { padding:0 !important; align-self:stretch; border-radius:var(--r) 0 0 var(--r); }
  .s-ok { background:var(--ok); } .s-warn { background:var(--warn); } .s-crit { background:var(--crit); }
  .s-info { background:var(--info); } .s-idle { background:var(--line); } .s-done { background:var(--line-soft); }
  .lane .nm { font:600 13px/1.3 var(--mono); letter-spacing:-.01em; }
  .lane .nm small { display:block; font:400 11px/1.4 var(--sans); color:var(--muted); margin-top:2px; }
  .lane .scope, .lane .own { font:400 11px/1.4 var(--mono); color:var(--muted); overflow:hidden; text-overflow:ellipsis; }
  .lane .who { color:var(--live); font-weight:600; }
  .lane .lease { display:block; color:var(--faint); font-size:10.5px; }
  .lane .lease.lapsed { color:var(--warn); }
  .lane .free { color:var(--faint); }
  .lane .age { font:500 11px/1.4 var(--mono); color:var(--faint); text-align:right; }
  .pill { display:inline-flex; border-radius:999px; padding:3px 8px; font:600 10px/1.4 var(--mono); letter-spacing:.04em;
    text-transform:uppercase; border:1px solid transparent; white-space:nowrap; }
  .p-ok { color:var(--ok); background:var(--ok-bg); border-color:color-mix(in srgb,var(--ok) 30%,transparent); }
  .p-warn { color:var(--warn); background:var(--warn-bg); border-color:color-mix(in srgb,var(--warn) 30%,transparent); }
  .p-crit { color:var(--crit); background:var(--crit-bg); border-color:color-mix(in srgb,var(--crit) 30%,transparent); }
  .p-info { color:var(--info); background:var(--info-bg); border-color:color-mix(in srgb,var(--info) 30%,transparent); }
  .p-idle { color:var(--faint); background:var(--panel-2); border-color:var(--line); }

  .detail { display:none; margin:-4px 0 10px; padding:14px 16px 14px 30px; border:1px solid var(--line); border-top:none;
    border-radius:0 0 var(--r) var(--r); background:var(--panel-2); font-size:12.5px; }
  .detail.open { display:block; }
  .detail dl { display:grid; grid-template-columns:92px 1fr; gap:6px 14px; margin:0 0 10px; }
  .detail dt { font:600 10px/1.5 var(--mono); letter-spacing:.07em; text-transform:uppercase; color:var(--faint); }
  .detail dd { margin:0; font-family:var(--mono); font-size:11.5px; word-break:break-word; }
  .detail .why { margin:0 0 10px; color:var(--muted); border-left:2px solid var(--line); padding-left:11px; max-width:88ch; }
  .detail .cmd { margin:0; font:400 11.5px/1.5 var(--mono); color:var(--ink); background:var(--panel); border:1px solid var(--line-soft);
    border-radius:4px; padding:6px 9px; display:inline-block; }

  .feed { padding:6px 0; }
  .feed div { display:grid; grid-template-columns:52px 78px 1fr; gap:12px; padding:8px 16px; border-bottom:1px solid var(--line-soft); font-size:12.5px; }
  .feed div:last-child { border-bottom:none; }
  .feed .t, .feed .s { font:400 11px/1.5 var(--mono); color:var(--faint); }
  .feed .s { color:var(--muted); }
  .feed b { font:600 11px/1.5 var(--mono); color:var(--ink); }

  .recon { display:block; border-top:1px dashed var(--line); padding:9px 14px; font:400 11px/1.5 var(--mono);
    color:var(--faint); background:var(--panel-2); border-radius:0 0 var(--r) var(--r); overflow-x:auto; white-space:pre; }
  .recon b { color:var(--muted); font-weight:600; }

  .tw { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th,td { padding:9px 13px; text-align:left; border-bottom:1px solid var(--line-soft); }
  th { font:600 10px/1.4 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--faint); background:var(--panel-2); }
  tbody tr:last-child td { border-bottom:none; }
  td.mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }

  footer { margin-top:40px; padding-top:18px; border-top:1px solid var(--line); color:var(--faint);
    font:400 11.5px/1.6 var(--mono); display:flex; justify-content:space-between; gap:20px; flex-wrap:wrap; }

  /* PRIORITIES kanban. Every class is kb-/kcol-prefixed: the lane list below
     queries .lane, .detail and .chip, and must never see these cards. */
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .kb-bar { display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; margin:0 0 12px; }
  .kb-status { display:flex; align-items:center; gap:8px; margin:0; min-height:18px; color:var(--muted); font:500 11.5px/1.4 var(--mono); }
  .kb-status::before { content:''; flex:none; width:7px; height:7px; border-radius:50%; background:var(--faint); }
  .kb-status[data-k="ok"]::before { background:var(--ok); }
  .kb-status[data-k="warn"]::before { background:var(--warn); }
  .kb-status[data-k="crit"]::before { background:var(--crit); }
  .kb-status[data-k="crit"] { color:var(--crit); }
  .kb-board { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; align-items:start; }
  .kcol { min-width:0; padding:8px; border:1px solid var(--line); border-radius:var(--r); background:var(--panel-2); }
  .kcol.kb-over { border-color:var(--ok); background:var(--ok-bg); }
  .kb-h { margin:0; font:inherit; }
  .kb-head { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; padding:6px 4px; border:0; background:none;
    color:var(--ink); font:600 12px/1.2 var(--mono); letter-spacing:.04em; text-align:left; cursor:default; }
  .kb-count { min-width:22px; padding:3px 7px; border:1px solid var(--line); border-radius:999px; background:var(--panel); color:var(--muted);
    font:600 10.5px/1.2 var(--mono); text-align:center; }
  .kb-sub { margin:0 4px 6px; color:var(--faint); font:400 10.5px/1.4 var(--mono); }
  .kb-list { display:flex; flex-direction:column; gap:8px; min-height:56px; margin:0; padding:0; list-style:none; }
  .kcol[data-n="0"] .kb-list::after { content:'Nothing here'; display:block; padding:14px 10px; border:1px dashed var(--line); border-radius:var(--r);
    color:var(--faint); font:400 11px/1.4 var(--mono); text-align:center; }
  .kb-card { min-width:0; padding:10px 11px; border-left:3px solid var(--line); }
  .kb-card[data-state="active"] { border-left-color:var(--ok); }
  .kb-card[data-state="ready"] { border-left-color:var(--info); }
  .kb-card[data-state="blocked"] { border-left-color:var(--crit); }
  .kb-card[data-state="review"] { border-left-color:var(--warn); }
  .kb-card.kb-dragging { opacity:.4; }
  .kb-ph { height:44px; border:2px dashed var(--ok); border-radius:var(--r); background:var(--ok-bg); list-style:none; }
  .kb-top { display:flex; align-items:center; gap:8px; }
  .kb-rank { flex:none; display:grid; place-items:center; min-width:22px; height:22px; padding:0 5px; border-radius:999px;
    background:var(--ink); color:var(--ground); font:700 11px/1 var(--mono); }
  .kb-id { flex:1; min-width:0; font:600 12.5px/1.3 var(--mono); letter-spacing:-.01em; overflow-wrap:anywhere; }
  .kb-grip { flex:none; padding:2px 6px; color:var(--faint); font:700 14px/1 var(--mono); letter-spacing:-2px; cursor:grab; user-select:none; touch-action:none; }
  .kb-board:not(.kb-on) .kb-grip { display:none; }
  .kb-title { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; line-clamp:3; overflow:hidden; overflow-wrap:anywhere;
    margin:6px 0 0; color:var(--muted); font:400 12px/1.45 var(--sans); }
  .kb-open .kb-title { display:block; overflow:visible; }
  .kb-meta, .kb-holder { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:8px; }
  .kb-track, .kb-prio, .kb-lease { color:var(--faint); font:500 10.5px/1.4 var(--mono); overflow-wrap:anywhere; }
  .kb-who { color:var(--live); font:600 11px/1.4 var(--mono); }
  .kb-more { margin-top:8px; padding:4px 0; border:0; background:none; color:var(--info); font:500 11px/1.4 var(--mono); cursor:pointer; }
  .kb-more:hover { text-decoration:underline; }
  .kb-detail { margin:8px 0 0; min-width:0; }
  .kb-detail[hidden] { display:none; }
  .kb-dl { display:grid; grid-template-columns:62px minmax(0,1fr); gap:4px 8px; margin:0; padding:8px 10px; border:1px solid var(--line-soft);
    border-radius:6px; background:var(--panel-2); }
  .kb-dl dt { color:var(--faint); font:600 10px/1.5 var(--mono); letter-spacing:.07em; text-transform:uppercase; }
  .kb-dl dd { margin:0; font:400 11.5px/1.45 var(--mono); overflow-wrap:anywhere; }
  .kb-chip, .kb-sync { display:inline-flex; max-width:100%; padding:3px 8px; border:1px solid var(--line); border-radius:999px; background:var(--panel-2);
    color:var(--muted); font:600 10px/1.4 var(--mono); letter-spacing:.03em; overflow-wrap:anywhere; }
  .kb-chip[hidden], .kb-sync[hidden] { display:none; }
  .kb-chip[data-k="pending"], .kb-sync[data-k="pending"] { color:var(--warn); background:var(--warn-bg); border-color:color-mix(in srgb,var(--warn) 30%,transparent); }
  .kb-sync[data-k="synced"] { color:var(--ok); background:var(--ok-bg); border-color:color-mix(in srgb,var(--ok) 30%,transparent); }
  .kb-plain { margin-top:8px; }
  .kb-plain[hidden], .kb-plain-out[hidden] { display:none; }
  .kb-plain-out { margin:8px 0 0; padding:8px 10px; border:1px solid var(--line-soft); border-left:3px solid var(--info); border-radius:6px;
    background:var(--panel-2); color:var(--ink); font:400 12px/1.5 var(--sans); white-space:pre-line; overflow-wrap:anywhere; }
  .kb-plain-out[data-k="warn"] { border-left-color:var(--warn); color:var(--warn); }
  .kb-plain-out[data-k="crit"] { border-left-color:var(--crit); color:var(--crit); }
  .kb-edit { display:flex; flex-direction:column; gap:8px; margin-top:8px; min-width:0; }
  .kb-fl { display:flex; flex-direction:column; gap:4px; min-width:0; color:var(--faint); font:600 10px/1.4 var(--mono); letter-spacing:.07em; text-transform:uppercase; }
  .kb-st, .kb-note, .kb-q { width:100%; min-width:0; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--panel);
    color:var(--ink); font:400 12px/1.45 var(--sans); letter-spacing:normal; text-transform:none; }
  .kb-st { min-height:34px; font-family:var(--mono); }
  .kb-note, .kb-q { resize:vertical; min-height:60px; }
  .kb-st:disabled, .kb-note:disabled, .kb-q:disabled { color:var(--faint); background:var(--panel-2); cursor:not-allowed; }
  .kb-sv { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .kb-saved { min-width:0; color:var(--muted); font:500 11px/1.4 var(--mono); overflow-wrap:anywhere; }
  .kb-saved[data-k="ok"] { color:var(--ok); }
  .kb-saved[data-k="crit"] { color:var(--crit); }
  .kb-why { margin:0; color:var(--faint); font:400 10.5px/1.4 var(--mono); }
  .kb-why:empty { display:none; }
  .kb-ctl { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:9px; }
  .kb-btn, .kb-to { min-height:30px; padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:var(--panel);
    color:var(--ink); font:500 11px/1 var(--mono); cursor:pointer; }
  .kb-btn:hover:not(:disabled), .kb-to:hover:not(:disabled) { border-color:var(--muted); }
  .kb-btn:disabled, .kb-to:disabled { color:var(--faint); cursor:not-allowed; opacity:.6; }
  .kb-mv { display:flex; flex-direction:column; align-items:stretch; gap:4px; flex:1 1 100%; min-width:0; color:var(--faint); font:500 10.5px/1 var(--mono); }
  .kb-to { width:100%; min-width:0; }
  @media (max-width:1080px) { .kb-board { grid-template-columns:repeat(3,minmax(0,1fr)); } }
  @media (max-width:720px) {
    .kb-board { grid-template-columns:minmax(0,1fr); }
    .kb-head { cursor:pointer; }
    .kb-head::after { content:'▾'; color:var(--faint); }
    .kcol.kb-collapsed .kb-head::after { content:'▸'; }
    .kcol.kb-collapsed .kb-list, .kcol.kb-collapsed .kb-sub { display:none; }
  }
  @media (pointer:coarse), (max-width:720px) {
    .kb-head, .kb-more, .kb-btn, .kb-to, .kb-st { min-height:44px; }
    .kb-btn { min-width:44px; }
    .kb-more { padding:4px 10px 4px 0; }
  }

  @media (max-width:1080px) { .lane { grid-template-columns:3px minmax(160px,1.4fr) 92px 130px 56px; } .lane .scope { display:none; } }
  @media (max-width:720px) { .lane { grid-template-columns:3px 1fr 56px; } .lane .state-c, .lane .own { display:none; } .counters { width:100%; } }
  @media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration:.01ms !important; transition-duration:.01ms !important; } }${KANBAN ? '' : KB_RO_CSS}
</style>

<header class="top">
  <div class="top-in">
    <div class="brand">
      <span class="mark">AOS</span>
      <span><b>Lane Board${KEY === DEFAULT_BOARD ? '' : ` &middot; ${esc(KEY)}`}</b><span>generated from agentic_os.lane (board ${esc(KEY)}) &middot; ${localStamp()} local &middot; <span class="gen" id="gen-ago" data-ts="${GENERATED_AT.toISOString()}">generated just now</span></span></span>
    </div>
    <div class="counters">
      <span class="ctr"><b>${open.length}</b><span>open lanes</span></span>
      <span class="ctr is-ok"><b>${held}</b><span>held now</span></span>
      <span class="ctr"><b>${byState('ready')}</b><span>claimable</span></span>
      <span class="ctr${byState('blocked') ? ' is-crit' : ''}"><b>${byState('blocked')}</b><span>blocked</span></span>
      <span class="ctr is-ok"><b>${sessions.length}</b><span>active (${STALE_MINUTES} min)</span></span>
      <span class="ctr"><b>${quietCount}</b><span>open, quiet</span></span>
    </div>
    <button class="themebtn" id="tt" type="button">theme</button>
  </div>
</header>

<div class="wrap">

  ${KANBAN ? `<section id="priorities" aria-labelledby="kb-title">
    <div class="sec-head">
      <h2 id="kb-title">Priorities</h2>
      <p>Drag or use Move to. Your order saves to this board and Claude reads it.</p>
    </div>
    <div class="kb-bar">
      <p class="kb-status" id="kb-status" role="status" data-k="idle">Default order. Saved order not loaded yet.</p>
      <span class="kb-chip" id="kb-order" data-k="pending" hidden>Order not yet synced to sessions</span>
    </div>
    <div class="sr" id="kb-live" aria-live="polite"></div>
    <div class="kb-board" id="kb-board">
      ${KB_COLS.map(([k, name]) => kbColumn(k, name, kbPlaced[k], true)).join('')}
      ${kbColumn('progress', 'In progress', kbPlaced.inProgress, false)}
    </div>
    <script type="application/json" id="kb-data">${kbJson}</script>
  </section>` : `<section id="priorities" class="kb-ro" aria-labelledby="kb-title">
    <div class="sec-head">
      <h2 id="kb-title">Priorities</h2>
      <p>${KB_RO_INTRO}</p>
    </div>
    <div class="kb-board" id="kb-board">
      ${KB_COLS.map(([k, name]) => kbColumn(k, name, kbPlaced[k], true, true)).join('')}
      ${kbColumn('progress', 'In progress', kbPlaced.inProgress, false, true)}
    </div>
  </section>`}

  <section>
    <div class="sec-head">
      <h2>Right now</h2>
      <p>Sessions that have beaten within ${STALE_MINUTES} minutes, and what each one holds. This is the question a second session actually needs answered before it starts typing.</p>
    </div>
    <div class="now">
      ${sessions.length ? sessions.map((s) => `
      <div class="card sess">
        <div class="sid"><span class="dot"></span>${esc(short(s.id))}<span style="color:var(--faint);font-weight:400">&middot; ${esc(ago(s.last_heartbeat))}</span></div>
        <p class="doing">${esc(String(s.working_on || '').replace(/\s+/g, ' ').slice(0, 130)) || '&mdash;'}</p>
        ${s.lanes.length ? `<ul>${s.lanes.map((l) => `
          <li><b>${esc(l.id)}</b>${l.note ? `<span>${esc(l.note)}</span>` : ''}${l.scope ? `<span>scope: ${esc(l.scope)}</span>` : ''}</li>`).join('')}</ul>`
        : '<p class="none">holds no lane</p>'}
      </div>`).join('') : '<div class="card sess"><p class="none">no active sessions</p></div>'}
    </div>
    <div class="card" style="margin-top:10px"><span class="recon"><b>sessions</b>  SELECT id, working_on, GREATEST(last_heartbeat, last_activity_at) AS last_alive
            FROM sessions
            WHERE GREATEST(last_heartbeat, last_activity_at) &gt; now() - interval '${STALE_MINUTES} minutes'
              AND (the session's project is under a root of board ${esc(KEY)} OR it owns a lane with project_key = '${esc(KEY)}');
            -- NOT bare last_heartbeat: that column fires on UserPromptSubmit only, so it
            -- measures the human typing, not the agent working (peak drift 505s mid-edit).
<b>held</b>      SELECT count(*) FROM agentic_os.lane l
            WHERE l.project_key = '${esc(KEY)}' AND l.state &lt;&gt; 'done' AND l.owner_session_id IS NOT NULL AND NOT (
              (l.lease_expires_at IS NULL OR l.lease_expires_at &lt; now())
              AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = l.owner_session_id
                AND GREATEST(s.last_heartbeat, s.last_activity_at) &gt; now() - interval '${STALE_MINUTES} minutes'));
            -- held = has an owner who is STILL THERE, the complement of lane.mjs's
            -- RECLAIMABLE. BOTH an expired lease AND a quiet holder are required to
            -- unhold a lane, so an owned-but-lapsed lane is reclaimable, not held.</span></div>
  </section>

  <section>
    <div class="sec-head">
      <h2>Lanes</h2>
      <p>A lane is a durable work thread with a declared scope. Two sessions are safe to run at once exactly when their scopes are disjoint. Click a lane for its standing case and the command to claim it.</p>
    </div>
    <div class="filters" role="group" aria-label="Filter lanes">
      <button class="chip" data-f="open" aria-pressed="true">open ${open.length}</button>
      <button class="chip" data-f="ready" aria-pressed="false">claimable ${byState('ready')}</button>
      <button class="chip" data-f="held" aria-pressed="false">held ${held}</button>
      <button class="chip" data-f="blocked" aria-pressed="false">blocked ${byState('blocked')}</button>
      <button class="chip" data-f="all" aria-pressed="false">all ${lanes.length}</button>
    </div>
    ${tracks.map((t) => {
      const rows = lanes.filter((l) => l.track === t);
      return `<div class="grp" data-track="${esc(t)}">
        <div class="grp-h"><span class="nm">${esc(t)}</span><span class="ct">${rows.filter((r) => r.state !== 'done').length} open / ${rows.length}</span><span class="rule"></span></div>
        ${rows.map((l, i) => laneRow(l, `${esc(t)}-${i}`)).join('')}
      </div>`;
    }).join('')}
    <div class="card" style="margin-top:6px"><span class="recon"><b>lanes</b>     SELECT id, state, owner_session_id, lease_expires_at, scope
            FROM agentic_os.lane WHERE project_key = '${esc(KEY)}' ORDER BY track, priority;
<b>claim</b>     ${esc(laneCliCmd())} claim &lt;id&gt;    # atomic: one winner, loser is told who won
<b>gate</b>      node scripts/coordination/lane-race-probe.mjs   # 10 properties, incl. both reclaim negatives</span></div>
  </section>

  <section>
    <div class="sec-head"><h2>Activity</h2><p>The last ${events.length} lane events of board ${esc(KEY)} (agentic_os.lane_event WHERE project_key = '${esc(KEY)}'). This log is also the message bus between sessions &mdash; a <span class="mono">note</span> is one session talking to the others.</p></div>
    <div class="card feed">
      ${events.map((e) => `<div>
        <span class="t">${esc(new Date(e.occurred_at).toTimeString().slice(0, 5))}</span>
        <span class="s">${esc(short(e.session_id))}</span>
        <span><b>${esc(e.kind)}</b>${e.lane_id ? ` <span class="mono" style="color:var(--muted)">[${esc(e.lane_id)}]</span>` : ''}${e.to_session_id ? ' <span class="mono" style="color:var(--info)">direct</span>' : ''}${e.body ? `<br>${esc(String(e.body).slice(0, 400))}` : ''}</span>
      </div>`).join('') || '<div><span class="t"></span><span class="s"></span><span>no events yet</span></div>'}
    </div>
  </section>

  <section>
    <div class="sec-head"><h2>Coordination integrity</h2><p>Is the file lock underneath the lanes telling the truth? Point-in-time &mdash; &ldquo;live&rdquo; only means something while somebody is mid-edit. <b>Machine-wide, every board:</b> file_claims and coordination_event carry no board key, so these rows are not filtered to ${esc(KEY)}.</p></div>
    <div class="card">
      <div class="tw"><table>
        <thead><tr><th>Signal</th><th class="mono">Value</th><th>Reading</th></tr></thead>
        <tbody>
          <tr><td>file_claims with no session row</td><td class="mono">${claimHealth.orphaned}</td><td><span class="pill ${claimHealth.orphaned === 0 ? 'p-ok' : 'p-crit'}">${claimHealth.orphaned === 0 ? 'clean' : 'orphaned'}</span></td></tr>
          <tr><td>claims held by a stale session</td><td class="mono">${claimHealth.stale}</td><td><span class="pill p-idle">ages out</span></td></tr>
          <tr><td>claims held by a live session</td><td class="mono">${claimHealth.live}</td><td><span class="pill p-idle">point-in-time</span></td></tr>
          ${eventKinds.map((k) => `<tr><td><span class="mono">${esc(k.kind)}</span>, last 24h</td><td class="mono">${k.n}</td><td><span class="pill p-idle">coordination_event</span></td></tr>`).join('')}
        </tbody>
      </table></div>
      <span class="recon"><b>careful</b>   the column is <b>occurred_at</b>, NOT ts. And <b>blocked_on</b> means "waiting on a
          human", NOT a claim conflict -- easy to misread as one.
<b>clocks</b>    the DB runs UTC and this machine runs UTC-5. Every time on this page is LOCAL.</span>
    </div>
  </section>

  <footer>
    <span>generated ${localStamp()} local &middot; ${lanes.length} lanes &middot; ${events.length} events</span>
    <span>${esc(renderBoardCmd(KEY))}</span>
  </footer>
</div>

<script>
  (function () {
    var root = document.documentElement;
    document.getElementById('tt').addEventListener('click', function () {
      var now = root.getAttribute('data-theme');
      if (!now) {
        now = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      root.setAttribute('data-theme', now === 'dark' ? 'light' : 'dark');
    });

    document.querySelectorAll('.lane').forEach(function (b) {
      b.addEventListener('click', function () {
        var d = document.getElementById(b.getAttribute('aria-controls'));
        var openNow = d.classList.toggle('open');
        b.setAttribute('aria-expanded', String(openNow));
      });
    });

    var chips = document.querySelectorAll('.chip');
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        chips.forEach(function (o) { o.setAttribute('aria-pressed', String(o === chip)); });
        var f = chip.dataset.f;
        document.querySelectorAll('.lane').forEach(function (lane) {
          var st = lane.dataset.state, held = lane.dataset.held === '1';
          var show = f === 'all' ? true
            : f === 'open' ? st !== 'done'
            : f === 'held' ? held
            : st === f;
          lane.style.display = show ? '' : 'none';
          var d = document.getElementById(lane.getAttribute('aria-controls'));
          if (!show) { d.classList.remove('open'); lane.setAttribute('aria-expanded', 'false'); }
          d.dataset.hidden = show ? '' : '1';
        });
        // A track heading with nothing under it is noise, not structure.
        document.querySelectorAll('.grp').forEach(function (g) {
          var any = Array.prototype.some.call(g.querySelectorAll('.lane'), function (l) { return l.style.display !== 'none'; });
          g.style.display = any ? '' : 'none';
        });
      });
    });
    document.querySelector('.chip[data-f="open"]').click();
  })();
</script>
<script>
  // "generated N min ago": computed here from the embedded time, so a page nobody republished shows its age.
  (function () {
    var el = document.getElementById('gen-ago');
    if (!el) return;
    var t = Date.parse(el.getAttribute('data-ts'));
    function tick() {
      var m = Math.max(0, Math.round((Date.now() - t) / 60000));
      el.textContent = m < 1 ? 'generated just now' : 'generated ' + m + ' min ago';
      el.className = 'gen' + (m >= 60 ? ' stale' : '');
    }
    tick();
    setInterval(tick, 30000);
  })();
</script>${KANBAN ? `
<script>
${kbScript}
</script>` : ''}`;

writeAtomic(OUT, html);
console.log(`wrote ${OUT} (${(html.length / 1024).toFixed(1)}kb) -- board ${KEY}, ${lanes.length} lanes, ${sessions.length} active sessions, ${quietCount} open, quiet, ${events.length} events`);
