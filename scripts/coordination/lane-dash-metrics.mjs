/**
 * lane-dash-metrics -- every tile figure, verdict word and summary sentence of the lane dashboard, in tested Node code.
 *
 * The FleetOps page is plain HTML. It only marks and draws numbers and words. This module computes them.
 * export-dash-data.mjs calls buildTileRows and writes the result as tiles.json ({sql, exportedAt, rows}).
 * Ported from the practice app (shadcn-dash-practice src/lib/metrics.ts) with the gate 4 fixes applied.
 *
 * Pure: no database, no file, no clock. "Now" is always meta.exported_at. The two helpers that need the
 * browser clock (hoursOld, isStale) take it as an explicit nowMs argument.
 *
 * ---------------------------------------------------------------- tiles.json row schema
 * Flat long format. One row is one value or one string. Every row has exactly these seven columns, in this order:
 *   id     unique key, "<prefix>.<name>". Lists: "<prefix>.row.<rank>.<field>". Bars: "<prefix>.bar.<rank>[.<series>]".
 *          Days: "<prefix>.day.<rank>". Ticks: "<prefix>.tick.<rank>". One tile is the rows that share one prefix:
 *          1 wait, 2 pile, 3 never, 4 wip, 5 p0, 6 proj, 7 assign, 8 verdict, 9 cat, 10 daily, page.
 *   tile   1 to 10 (a number), or "page" for the takeaway and the data-age lines.
 *   kind   figure  a number the page prints big; value is the number, text its display form ("+3", "2 of 5").
 *          text    a label, note or sentence; text is the string (value may repeat a number inside it).
 *          chip    a status word with a tone; text is the word.
 *          row     one field of a list row (rank is the row order, from 1).
 *          bar     one bar or one bar segment (value is the length, text its label).
 *          day     one day column or trend point (value is the total, text its label: "Nov 1" or "today").
 *          tick    one axis tick (value only).
 *   rank   row, bar, day or tick order from 1. null for every other kind.
 *   value  a finite number, or null.
 *   text   the display string, or null. Never an ISO date. Never an 8-hex session handle (masked as "#[handle]").
 *   tone   "neutral", "ok", "warn", "bad", or null. "bad" (red) is used only by p0.chip when open P0 is above a set cap.
 * Each tile has "<prefix>.summary" (the one visible sentence) and "<prefix>.detail" (the longer text for screen
 * readers; tile 7 has none). A row that does not apply is left out, not written with nulls: no ask, no
 * "wait.oldest"; no earlier week, no "pile.line.prior". Tile 5 has no meter rows. Tile 6 has no goal text.
 * The page rows page.rows.wait, page.rows.proj and page.rows.log hold the list limits (show_rows, project_rows,
 * log_rows), so the page can size its loading boxes without reading targets.json. Tile 3 and tile 2 and tile 7
 * write axis ticks (<prefix>.tick.<rank>) for their charts. The tile column mixes numbers and the string "page":
 * compare it as a string, or use the id prefix.
 * Tiles 8 to 10 (the progress page, 2026-11-13) leave out cards on track "reminders", so the category nets sum to
 * verdict.net and the daily rows sum to the verdict week. Tile 2 still counts them. Names and counts only: no lane
 * title or id. 8 verdict: verdict.net, .growth, .sentence, .week, .waited, .prior, .share (only while the net and the
 * top category net are above 0), .note (reminders left out). 9 cat: cat.row.<k>.name|closed|total|meta|bands and
 * .chip.growth (net not 0), one row per category with cards, "No category yet" (key unassigned) always last, cap
 * category_rows (page.rows.cat), cat.more, cat.note. 10 daily: daily.row.<k>.label|created|closed|net, 7 days oldest
 * first, the last "today so far"; daily.note. The page no longer draws tiles 2 and 6, but their rows stay.
 * Stale text needs the browser clock, so page.stale.* and page.fresh.sentence are templates with the slot
 * "{h}" (HOURS_TOKEN). The page fills the slot with hoursOld. The Node functions staleChipText, staleSentence
 * and freshSentence are the tested source of the wording.
 *
 * Importing this file does nothing.
 */

export const TZ = 'America/Chicago';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const DEFAULT_SHOW_ROWS = 4;
export const DEFAULT_PROJECT_ROWS = 4;
export const DEFAULT_CATEGORY_ROWS = 9;
export const NO_CATEGORY_KEY = 'unassigned';
export const NO_CATEGORY_NAME = 'No category yet';
export const HOURS_TOKEN = '{h}';
export const TILE_COLUMNS = ['id', 'tile', 'kind', 'rank', 'value', 'text', 'tone'];

// ---------------------------------------------------------------- words (moved out of the views)

export const STATE_WORD = { nocap: 'no limit set', none: 'under cap', under: 'under cap', at: 'at cap', over: 'over cap' };
export const STATUS_WORD = { open: 'Open', done: 'Done', no_end: 'No end defined' };

/** +3, -3 (hyphen minus) or 0. */
export function sign(n) {
  return n > 0 ? `+${n}` : n < 0 ? `-${Math.abs(n)}` : '0';
}

/** The word only: pluralize(1, "lane") is "lane", else "lanes". */
export function pluralize(n, word) {
  return n === 1 ? word : `${word}s`;
}

/** Whole hours between the export and the clock the caller passes in. Never below 0. */
export function hoursOld(exportedAt, nowMs) {
  return Math.max(0, Math.round((nowMs - Date.parse(exportedAt)) / HOUR_MS));
}

/** The short chip on a tile: "Stale, 40 h". */
export const staleChipText = (hours) => `Stale, ${hours} h`;
/** The full sentence in the header, shown once: "Stale: data from Nov 7, 11:32 PM CST, 40 h old". */
export const staleSentence = (stamp, hours) => `Stale: data from ${stamp}, ${hours} h old`;
/** The header line when data is fresh. */
export const freshSentence = (stamp, hours) => `Data from ${stamp}, ${hours} hours ago.`;

/** The first line of the page: the queue first, then the pile change. */
export function takeaway(q, p) {
  const head = q.n === 1 ? '1 lane waits on Dave' : `${q.n} lanes wait on Dave`;
  return `${head}: ${q.m} asked in the last ${q.windowDays} days, ${q.older} older. The pile changed by ${sign(p.net)} in the last ${p.windowDays} days.`;
}

/** Growing, Shrinking or Flat, with its tone. No earlier week, or a flat net, is neutral: no verdict colour. */
export function growthState(net, priorKnown) {
  const word = net > 0 ? 'Growing' : net < 0 ? 'Shrinking' : 'Flat';
  if (!priorKnown || net === 0) return { word, tone: 'neutral' };
  return { word, tone: net > 0 ? 'warn' : 'ok' };
}

/** "2 P0 lanes open, no limit set, 2 with no holder" or "2 of 5 P0 lanes open, 0 with no holder". */
export function p0Sentence(t) {
  const open = t.cap === null
    ? `${t.p0} P0 ${pluralize(t.p0, 'lane')} open, no limit set`
    : `${t.p0} of ${t.cap} P0 lanes open`;
  return `${open}, ${t.unheld} with no holder`;
}

// ---------------------------------------------------------------- days and windows

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const STAMP_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SPACE_LIKE = new RegExp('[\u202f\u00a0]', 'g'); // narrow no-break space (newer ICU) and no-break space

/** Chicago calendar day (YYYY-MM-DD) of an ISO instant. */
export function chicagoDay(iso) {
  return DAY_FORMAT.format(new Date(iso));
}

/** "Nov 7, 11:32 PM CST". The zone letters come from Intl. Newer ICU puts a narrow no-break space before PM: made a plain space. */
export function formatChicago(iso) {
  return STAMP_FORMAT.format(new Date(iso)).replace(SPACE_LIKE, ' ');
}

/** "2026-11-07" to "Nov 7". One date style in body text. */
export function formatDay(day) {
  const [, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** Add days to a YYYY-MM-DD string. Calendar math in UTC, so no DST drift. */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The last `days` Chicago days to `today`, inclusive at both ends. */
export function windowOf(today, days) {
  return { start: addDays(today, -(days - 1)), end: today };
}

/** The `days` days before the current window. */
export function priorWindowOf(today, days) {
  return { start: addDays(today, -(2 * days - 1)), end: addDays(today, -days) };
}

export function inWindow(day, w) {
  return day !== null && day !== undefined && day >= w.start && day <= w.end;
}

/** A full earlier week exists when history starts 14 or more days before today. A null start means no history. */
export function hasPriorWindow(historyStart, today, days) {
  return typeof historyStart === 'string' && historyStart <= addDays(today, -2 * days);
}

export function hoursSince(iso, nowMs) {
  return (nowMs - Date.parse(iso)) / HOUR_MS;
}

/** Stale: the clock passed in, minus exported_at, is over the limit. */
export function isStale(exportedAt, nowMs, staleAfterHours) {
  return nowMs - Date.parse(exportedAt) > staleAfterHours * HOUR_MS;
}

export function targetMap(rows) {
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const num = (t, key, fallback) => t[key] ?? fallback;
const isOpen = (l) => l.state !== 'done';
const cleanText = (s) => String(s ?? '').replace(/#[0-9a-f]{8}/gi, '#[handle]');

// ---------------------------------------------------------------- tile 1

export function daveQueue(lanes, meta, targets) {
  const days = num(targets, 'window_days', 7);
  const w = windowOf(meta.today, days);
  const exportedMs = Date.parse(meta.exported_at);
  const asks = lanes
    .filter((l) => isOpen(l) && l.dave_ask_at !== null && l.dave_ask_at !== undefined)
    .sort((a, b) => Date.parse(a.dave_ask_at) - Date.parse(b.dave_ask_at));
  const m = asks.filter((l) => chicagoDay(l.dave_ask_at) >= w.start).length;
  const ageDays = (iso) => Math.floor((exportedMs - Date.parse(iso)) / DAY_MS);
  const rows = asks.slice(0, num(targets, 'show_rows', DEFAULT_SHOW_ROWS)).map((l) => ({
    id: l.id, title: l.title, project: l.project, band: l.band, askAt: l.dave_ask_at, ageDays: ageDays(l.dave_ask_at),
  }));
  return {
    openCheck: meta.open_check,
    n: asks.length,
    m,
    older: asks.length - m,
    oldestDays: asks.length ? ageDays(asks[0].dave_ask_at) : null,
    rows,
    windowDays: days,
    cap: targets.dave_queue_cap ?? null,
    blockedNoAsk: lanes.filter((l) => l.state === 'blocked' && !l.dave_ask_at).length,
  };
}

// ---------------------------------------------------------------- tile 2

function flow(lanes, w) {
  const created = lanes.filter((l) => inWindow(l.created_day, w)).length;
  const done = lanes.filter((l) => inWindow(l.done_day, w)).length;
  return { created, done, net: created - done };
}

/** Lanes done in the window whose first claim came edgeDays or more after creation (the pull-rate count). */
function waitedIn(lanes, w, edgeDays) {
  return lanes.filter((l) => inWindow(l.done_day, w) && l.first_claim_at != null
    && Date.parse(l.first_claim_at) - Date.parse(l.created_at) >= edgeDays * DAY_MS).length;
}

export function pileTile(lanes, meta, targets) {
  const days = num(targets, 'window_days', 7);
  const w = windowOf(meta.today, days);
  const edgeDays = num(targets, 'age_edge_1', 1);
  const { created, done, net } = flow(lanes, w);
  const before = addDays(w.start, -1);
  const openStart = lanes.filter((l) => l.created_day <= before && !(l.done_day != null && l.done_day <= before)).length;
  const waited = waitedIn(lanes, w, edgeDays);
  const prior = hasPriorWindow(meta.history_start, meta.today, days) ? flow(lanes, priorWindowOf(meta.today, days)) : null;
  return {
    created, done, net, openStart, openNow: meta.open_check, waited, edgeDays, windowDays: days, prior, totalLanes: lanes.length,
  };
}

/** Ticks for a count axis: 0 and even steps, at most five ticks, the top covers the max. */
export function niceTicks(max) {
  const steps = [1, 2, 5, 10, 15, 20, 25, 50, 100, 200, 250, 500, 1000];
  const step = steps.find((s) => Math.ceil(max / s) <= 4) ?? 1000;
  const top = Math.max(1, Math.ceil(max / step)) * step;
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

export function trendState(snapshots, targets) {
  const min = num(targets, 'trend_min_days', 7);
  return { have: snapshots.length, min, show: snapshots.length >= Math.max(1, min) }; // an empty list never draws a chart
}

// ---------------------------------------------------------------- tile 3

export function neverStarted(lanes, meta, targets) {
  const e1 = num(targets, 'age_edge_1', 1);
  const e2 = num(targets, 'age_edge_2', 3);
  const e3 = num(targets, 'age_edge_3', 7);
  const exportedMs = Date.parse(meta.exported_at);
  const counts = [0, 0, 0, 0];
  let n = 0;
  for (const l of lanes) {
    if (!isOpen(l) || l.last_work_at !== null) continue;
    n++;
    const age = (exportedMs - Date.parse(l.created_at)) / DAY_MS;
    counts[age < e1 ? 0 : age < e2 ? 1 : age < e3 ? 2 : 3]++;
  }
  // The buckets are [0,e1), [e1,e2), [e2,e3), [e3,...). Ages are fractional, so the labels say "to under".
  const labels = [
    `Under ${e1} ${pluralize(e1, 'day')}`,
    `${e1} to under ${e2} days`,
    `${e2} to under ${e3} days`,
    `${e3} ${pluralize(e3, 'day')} or more`,
  ];
  return {
    n, openCheck: meta.open_check, buckets: labels.map((label, i) => ({ label, count: counts[i] })),
    over: counts[3], edgeOver: e3, cap: targets.never_started_cap ?? null,
  };
}

// ---------------------------------------------------------------- tile 4

export function wipTile(lanes, meta, targets = {}) {
  const exportedMs = Date.parse(meta.exported_at);
  const active = lanes.filter((l) => l.state === 'active');
  const live = active.filter((l) => l.lease_expires_at != null && Date.parse(l.lease_expires_at) >= exportedMs).length;
  return { active: active.length, live, lapsed: active.length - live, limit: targets.wip_limit ?? null };
}

/** The bar needs two segments to say anything. With one segment at 0 the chips carry the counts. */
export function showWipBar(live, lapsed) {
  return live > 0 && lapsed > 0;
}

// ---------------------------------------------------------------- tile 5

export function p0Tile(lanes, cap) {
  const open = lanes.filter((l) => l.band === 'P0' && isOpen(l));
  const p0 = open.length;
  const state = cap === null ? 'nocap' : p0 === 0 ? 'none' : p0 < cap ? 'under' : p0 === cap ? 'at' : 'over';
  return {
    p0, cap, unheld: open.filter((l) => !l.held).length, state, extra: cap === null ? 0 : Math.max(0, p0 - cap),
  };
}

// ---------------------------------------------------------------- tile 6

export function projectRows(projects, lanes, meta, targets) {
  const days = num(targets, 'window_days', 7);
  const w = windowOf(meta.today, days);
  const showRows = num(targets, 'project_rows', DEFAULT_PROJECT_ROWS);
  const openLanes = lanes.filter(isOpen);
  const all = projects
    .filter((p) => p.key !== 'unassigned')
    .filter((p) => p.status !== 'done' || p.visible_until == null || p.visible_until >= meta.today)
    .map((p) => {
      const mine = lanes.filter((l) => l.project === p.key);
      // Same flow as tile 2. done_day is set only on done lanes.
      const { created: opened, done: closed } = flow(mine, w);
      const name = String(p.name ?? p.key);
      return {
        key: p.key,
        // The Parked chip says it, so " (parked)" leaves the name of a parked project.
        name: p.parked ? name.replace(/\s*\(parked\)\s*$/i, '') : name,
        status: p.status, proposed: p.proposed, parked: p.parked, focus: p.focus,
        terminalDone: p.terminal_done, terminalTotal: p.terminal_total,
        open: mine.filter(isOpen).length, opened, closed, net: opened - closed, growing: opened > closed,
      };
    });
  const rank = (r) => (r.focus ? 0 : r.growing ? 1 : 2);
  const sorted = all
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || (rank(a.r) === 1 ? b.r.net - a.r.net : 0) || a.i - b.i)
    .map((x) => x.r);
  return {
    rows: sorted.slice(0, showRows),
    hidden: Math.max(0, sorted.length - showRows),
    growing: sorted.filter((r) => r.growing).length,
    priorKnown: hasPriorWindow(meta.history_start, meta.today, days),
    withDoneWhen: openLanes.filter((l) => l.has_done_when).length,
    unassignedOpen: openLanes.filter((l) => l.project === 'unassigned').length,
    openCheck: meta.open_check,
    windowDays: days,
    rankedByNetFlow: targets.never_started_cap == null,
  };
}

// ---------------------------------------------------------------- tile 7

function countHow(rows) {
  const claims = rows.filter((a) => a.how === 'claim').length;
  const reclaims = rows.filter((a) => a.how === 'reclaim').length;
  const placed = rows.filter((a) => a.who === 'dave').length;
  return { total: claims + reclaims + placed, claims, reclaims, placed };
}

/** The one label list for the day columns: "today" for the last day, "Nov 1" style for the others. */
export function dayLabels(days) {
  return days.map((d, i) => (i === days.length - 1 ? 'today' : formatDay(d.day)));
}

export function assignmentTile(assignments, meta, targets) {
  const days = num(targets, 'window_days', 7);
  const w = windowOf(meta.today, days);
  const inWin = assignments.filter((a) => inWindow(a.day, w));
  const buckets = Array.from({ length: days }, (_, i) => {
    const day = addDays(w.start, i);
    const c = countHow(inWin.filter((a) => a.day === day));
    return { day, claims: c.claims, reclaims: c.reclaims, placed: c.placed };
  });
  const prior = hasPriorWindow(meta.history_start, meta.today, days)
    ? countHow(assignments.filter((a) => inWindow(a.day, priorWindowOf(meta.today, days))))
    : null;
  return {
    ...countHow(inWin),
    days: buckets,
    labels: dayLabels(buckets),
    log: [...inWin].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, num(targets, 'log_rows', 12)),
    prior,
    windowDays: days,
  };
}

// ---------------------------------------------------------------- tiles 8 to 10: verdict, categories, days

/*
 * One lane set for all three: every lane except the cards on track `reminders` (they recur and never close).
 * So the category nets sum to the verdict net, and the day table sums to the verdict week.
 * Tile 2 keeps its own count with reminders in it.
 */
const isReminder = (l) => l.track === 'reminders';
const workLanes = (lanes) => lanes.filter((l) => !isReminder(l));
const categoryKey = (l) => l.project ?? NO_CATEGORY_KEY;

export function verdictTile(lanes, meta, targets) {
  const days = num(targets, 'window_days', 7);
  const work = workLanes(lanes);
  const w = windowOf(meta.today, days);
  const edgeDays = num(targets, 'age_edge_1', 1);
  const prior = hasPriorWindow(meta.history_start, meta.today, days) ? flow(work, priorWindowOf(meta.today, days)) : null;
  return {
    ...flow(work, w), waited: waitedIn(work, w, edgeDays), edgeDays, prior, windowDays: days,
    reminders: lanes.length - work.length, empty: work.length === 0,
  };
}

function categoryOf(key, name, mine, w, edgeDays) {
  const open = mine.filter(isOpen);
  const done = mine.filter((l) => !isOpen(l));
  const { created, done: closedWindow, net } = flow(mine, w);
  const days = done.map((l) => l.done_day).filter(Boolean).sort();
  const bands = { P0: 0, P1: 0, P2: 0, none: 0 };
  for (const l of open) bands[bands[l.band] === undefined ? 'none' : l.band]++;
  return {
    key, name, total: mine.length, closed: done.length, open: open.length,
    blocked: open.filter((l) => l.state === 'blocked').length, created, closedWindow, net,
    waited: waitedIn(mine, w, edgeDays), lastClose: days.length ? days[days.length - 1] : null, bands,
  };
}

/**
 * One row per category. Every project counts, Done or not (no visible_until filter), plus any project key a lane
 * carries that the list lacks. A category with no card is left out, except "No category yet" (key unassigned):
 * always shown, always last. Order: open cards, most first; a tie keeps the project-list order.
 * The cap (category_rows) cuts from the end of the sorted list and never cuts "No category yet".
 */
export function categoryRows(projects, lanes, meta, targets) {
  const days = num(targets, 'window_days', 7);
  const w = windowOf(meta.today, days);
  const edgeDays = num(targets, 'age_edge_1', 1);
  const cap = num(targets, 'category_rows', DEFAULT_CATEGORY_ROWS);
  const work = workLanes(lanes);
  const byKey = new Map(projects.map((p) => [p.key, p]));
  // Same rule as tile 6: a Parked chip says it, so " (parked)" leaves the name.
  const nameOf = (p) => (p.parked ? String(p.name ?? p.key).replace(/\s*\(parked\)\s*$/i, '') : String(p.name ?? p.key));
  const keys = [...new Set([...projects.map((p) => p.key), ...work.map(categoryKey)])].filter((k) => k !== NO_CATEGORY_KEY);
  const of = (k, name) => categoryOf(k, name, work.filter((l) => categoryKey(l) === k), w, edgeDays);
  const sorted = keys
    .map((k) => ({ ...of(k, byKey.has(k) ? nameOf(byKey.get(k)) : k), parked: Boolean(byKey.get(k)?.parked) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.open - a.open);
  const none = of(NO_CATEGORY_KEY, NO_CATEGORY_NAME);
  const keep = Math.max(0, cap - 1);
  return {
    rows: [...sorted.slice(0, keep), none],
    all: [...sorted, none],
    hidden: Math.max(0, sorted.length - keep),
    cap,
    priorKnown: hasPriorWindow(meta.history_start, meta.today, days),
    windowDays: days,
  };
}

/** The window's days, oldest first, with created and closed counts. The last day is today, still running. */
export function dailyRows(lanes, meta, targets) {
  const days = num(targets, 'window_days', 7);
  const w = windowOf(meta.today, days);
  const work = workLanes(lanes);
  return Array.from({ length: days }, (_, i) => {
    const day = addDays(w.start, i);
    const created = work.filter((l) => l.created_day === day).length;
    const closed = work.filter((l) => l.done_day === day).length;
    return { day, label: i === days - 1 ? 'today so far' : formatDay(day), created, closed, net: created - closed };
  });
}

// ---------------------------------------------------------------- the tiles document rows

function rowMaker(rows) {
  return (tile) => (id, kind, f = {}) => {
    const value = f.value === undefined || f.value === null || !Number.isFinite(f.value) ? null : f.value;
    rows.push({ id, tile, kind, rank: f.rank ?? null, value, text: f.text ?? null, tone: f.tone ?? null });
  };
}

const withHistory = (meta) => (typeof meta.history_start === 'string' ? formatDay(meta.history_start) : null);

function tile1(add, c) {
  const q = daveQueue(c.lanes, c.meta, c.targets);
  add('wait.count', 'figure', { value: q.n, text: String(q.n) });
  add('wait.count.label', 'text', { value: q.openCheck, text: `of ${q.openCheck} open` });
  if (q.oldestDays !== null) add('wait.oldest', 'figure', { value: q.oldestDays, text: String(q.oldestDays) });
  add('wait.limit', 'text', { value: q.cap, text: q.cap === null ? 'no limit set' : `limit ${q.cap}` });
  if (q.n === 0) {
    add('wait.empty', 'text', { text: 'No lanes waiting on Dave' });
  } else {
    add('wait.split', 'text', { text: `${q.m} asked in the last ${q.windowDays} days, ${q.older} older` });
    q.rows.forEach((r, i) => {
      add(`wait.row.${i + 1}.title`, 'row', { rank: i + 1, text: cleanText(r.title) });
      add(`wait.row.${i + 1}.meta`, 'row', {
        rank: i + 1, value: r.ageDays,
        text: `${cleanText(r.project)} · ${r.band ?? 'no band'} · ${r.ageDays} ${pluralize(r.ageDays, 'day')}`,
      });
    });
    if (q.n > q.rows.length) add('wait.more', 'text', { value: q.n - q.rows.length, text: `${q.n - q.rows.length} more on the board` });
  }
  if (q.blockedNoAsk > 0) add('wait.blocked_no_ask', 'text', { value: q.blockedNoAsk, text: `${q.blockedNoAsk} blocked with no ask, not counted.` });
  add('wait.summary', 'text', { text: `${q.n} of ${q.openCheck} open lanes ${q.n === 1 ? 'waits' : 'wait'} on Dave.` });
  const detail = [
    q.n > 0 ? `${q.m} asked in the last ${q.windowDays} days, ${q.older} older.` : '',
    q.oldestDays !== null ? `The oldest ask is ${q.oldestDays} ${pluralize(q.oldestDays, 'day')} old, as of ${c.stamp}.` : '',
    q.cap === null ? "Dave's queue has no limit set." : `The queue limit is ${q.cap}.`,
  ].filter(Boolean).join(' ');
  add('wait.detail', 'text', { text: detail });
  return q;
}

function trendRows(add, c, trend) {
  if (!trend.show) {
    add('pile.trend.note', 'text', { value: trend.have, text: `Trend after ${trend.min} daily snapshots: ${trend.have} so far` });
    return;
  }
  const snaps = c.snapshots;
  snaps.forEach((s, i) => add(`pile.day.${i + 1}`, 'day', { rank: i + 1, value: s.open, text: formatDay(s.day) }));
  niceTicks(Math.max(...snaps.map((s) => s.open))).forEach((t, i) => add(`pile.tick.${i + 1}`, 'tick', { rank: i + 1, value: t }));
  const last = snaps[snaps.length - 1];
  add('pile.trend.aria', 'text', { text: `Line chart of open lanes per day, ${trend.have} snapshots, last ${last.open}` });
  add('pile.trend.data_to', 'text', { text: `data to ${formatDay(last.day)}` });
}

function tile2(add, c) {
  const p = pileTile(c.lanes, c.meta, c.targets);
  const trend = trendState(c.snapshots, c.targets);
  const g = growthState(p.net, p.prior !== null);
  const empty = c.lanes.length === 0;
  const w = p.windowDays;
  const hist = withHistory(c.meta);
  add('pile.net', 'figure', { value: p.net, text: sign(p.net) });
  add('pile.growth', 'chip', { text: g.word, tone: g.tone });
  if (p.prior === null && hist) add('pile.history_note', 'text', { text: `history from ${hist}, no earlier week` });
  if (empty) {
    add('pile.empty', 'text', { text: 'No lanes in this export' });
  } else {
    add('pile.created', 'figure', { value: p.created, text: String(p.created) });
    add('pile.done', 'figure', { value: p.done, text: String(p.done) });
    add('pile.open_start', 'figure', { value: p.openStart, text: String(p.openStart) });
    add('pile.open_now', 'figure', { value: p.openNow, text: String(p.openNow) });
    add('pile.waited', 'figure', { value: p.waited, text: String(p.waited) });
    add('pile.line.flow', 'text', { text: `${p.created} opened, ${p.done} done, net ${sign(p.net)}, ${w} days to ${formatDay(c.meta.today)}, today so far` });
    add('pile.line.open', 'text', { text: `From ${p.openStart} to ${p.openNow} open` });
    add('pile.line.waited', 'text', {
      text: p.done === 0 ? `No lanes done in the last ${w} days` : `${p.waited} of ${p.done} waited ${p.edgeDays} ${pluralize(p.edgeDays, 'day')} or more`,
    });
    if (p.prior) add('pile.line.prior', 'text', { text: `Earlier ${w} days: ${p.prior.created} opened, ${p.prior.done} done, net ${sign(p.prior.net)}` });
    add('pile.line.caveat', 'text', { text: 'Start count is rebuilt from lane dates. A reopened lane can move it.' });
    trendRows(add, c, trend);
  }
  add('pile.summary', 'text', {
    text: empty ? 'No lanes in this export.'
      : `In the ${w} days to ${formatDay(c.meta.today)}, today so far, ${p.created} ${pluralize(p.created, 'lane')} opened and ${p.done} ${pluralize(p.done, 'lane')} finished, a net change of ${sign(p.net)}.`,
  });
  if (!empty) {
    const waitedText = p.done === 0 ? 'No lanes finished in the window'
      : `${p.waited} of ${p.done} finished ${pluralize(p.done, 'lane')} waited ${p.edgeDays} ${pluralize(p.edgeDays, 'day')} or more`;
    const noPrior = p.prior === null && hist ? `, with history from ${hist} and no earlier week to compare` : '';
    add('pile.detail', 'text', {
      text: `Open went from ${p.openStart} to ${p.openNow}. ${waitedText}. The pile is ${g.word}${noPrior}. The trend line starts after ${trend.min} daily snapshots; there ${trend.have === 1 ? 'is' : 'are'} ${trend.have} so far.`,
    });
  }
  return p;
}

function tile3(add, c) {
  const s = neverStarted(c.lanes, c.meta, c.targets);
  add('never.count', 'figure', { value: s.n, text: String(s.n) });
  add('never.count.label', 'text', { value: s.openCheck, text: `of ${s.openCheck} open lanes never started` });
  add('never.limit', 'text', { value: s.cap, text: s.cap === null ? 'no limit set' : `limit ${s.cap}` });
  if (s.n === 0) {
    add('never.empty', 'text', { text: 'Every open lane has been worked' });
  } else {
    s.buckets.forEach((b, i) => add(`never.bar.${i + 1}`, 'bar', {
      rank: i + 1, value: b.count, text: b.label, tone: i === s.buckets.length - 1 ? 'warn' : 'neutral',
    }));
    niceTicks(Math.max(...s.buckets.map((b) => b.count))).forEach((t, i) => add(`never.tick.${i + 1}`, 'tick', { rank: i + 1, value: t }));
    add('never.aria', 'text', { text: `Bar chart of never-started lanes by age: ${s.buckets.map((b) => `${b.label} ${b.count}`).join(', ')}` });
    add('never.chip', 'chip', { value: s.over, text: `${s.over} at ${s.edgeOver} days or more need a decision (proposed edge)`, tone: 'warn' });
  }
  add('never.summary', 'text', { text: `${s.n} of ${s.openCheck} open lanes have never been worked.` });
  add('never.detail', 'text', {
    text: `${s.over} are ${s.edgeOver} days old or more and need a decision. ${s.cap === null ? 'No cap is set.' : `The cap is ${s.cap}.`}`,
  });
}

function tile4(add, c) {
  const w = wipTile(c.lanes, c.meta, c.targets);
  add('wip.live', 'figure', { value: w.live, text: String(w.live) });
  add('wip.lapsed', 'figure', { value: w.lapsed, text: String(w.lapsed) });
  add('wip.active', 'figure', { value: w.active, text: String(w.active) });
  add('wip.limit', 'text', { value: w.limit, text: w.limit === null ? 'no limit set' : `limit ${w.limit}` });
  if (w.active === 0) {
    add('wip.empty', 'text', { text: 'No active lanes' });
  } else {
    add('wip.chip.live', 'chip', { value: w.live, text: `${w.live} live`, tone: 'ok' });
    add('wip.chip.lapsed', 'chip', { value: w.lapsed, text: `${w.lapsed} lapsed`, tone: w.lapsed > 0 ? 'warn' : 'neutral' });
    if (showWipBar(w.live, w.lapsed)) {
      add('wip.bar.1', 'bar', { rank: 1, value: w.live, text: 'Live', tone: 'ok' });
      add('wip.bar.2', 'bar', { rank: 2, value: w.lapsed, text: 'Lapsed', tone: 'warn' });
      add('wip.aria', 'text', { text: `Stacked bar: ${w.live} live, ${w.lapsed} lapsed` });
    }
  }
  add('wip.live_at', 'text', { text: `Live at ${c.stamp}.` });
  add('wip.summary', 'text', { text: `${w.live} of ${w.active} active lanes have a live lease and ${w.lapsed} are lapsed.` });
  add('wip.detail', 'text', { text: w.limit === null ? 'No work-in-progress limit is set.' : `The work-in-progress limit is ${w.limit}.` });
}

function tile5(add, c) {
  const t = p0Tile(c.lanes, c.targets.p0_cap ?? null);
  add('p0.figure', 'figure', { value: t.p0, text: t.cap === null ? String(t.p0) : `${t.p0} of ${t.cap}` });
  add('p0.unheld', 'figure', { value: t.unheld, text: String(t.unheld) });
  if (t.state === 'over') add('p0.chip', 'chip', { value: t.extra, text: `over cap by ${t.extra}`, tone: 'bad' });
  else add('p0.chip', 'chip', { text: STATE_WORD[t.state], tone: 'neutral' });
  if (t.state === 'none') add('p0.empty', 'text', { text: 'No open P0 lanes' });
  add('p0.bands_since', 'text', { text: `bands since ${formatDay(c.meta.band_history_start)}` });
  add('p0.summary', 'text', { text: `${p0Sentence(t)}.` });
  add('p0.detail', 'text', { text: t.cap === null ? 'No limit is set.' : `The state is ${STATE_WORD[t.state]}.` });
}

function projectMeta(r, windowDays) {
  return [
    r.status === 'no_end' ? null : `${r.terminalDone} of ${r.terminalTotal} terminal ${pluralize(r.terminalTotal, 'lane')} done`,
    `net ${sign(r.net)} in ${windowDays} days`,
    `${r.open} open ${pluralize(r.open, 'lane')}`,
  ].filter(Boolean).join(' · ');
}

function projectDetail(p) {
  const g = p.growing;
  const head = p.priorKnown
    ? (g === 1 ? '1 project is Growing.' : `${g} projects are Growing.`)
    : `${g} ${pluralize(g, 'project')} opened more lanes than ${g === 1 ? 'it' : 'they'} closed; there is no earlier week to compare.`;
  const parts = p.rows.map((r) => (r.status === 'no_end'
    ? `Project ${cleanText(r.name)} has no end defined, net ${sign(r.net)} in ${p.windowDays} days, ${r.open} open ${pluralize(r.open, 'lane')}.`
    : `Project ${cleanText(r.name)} has ${r.terminalDone} of ${r.terminalTotal} terminal ${pluralize(r.terminalTotal, 'lane')} done, net ${sign(r.net)} in ${p.windowDays} days, ${r.open} open ${pluralize(r.open, 'lane')}.`));
  return [head, ...parts].join(' ');
}

function tile6(add, c) {
  const p = projectRows(c.projects, c.lanes, c.meta, c.targets);
  const hist = withHistory(c.meta);
  if (!p.priorKnown && p.rows.some((r) => r.growing) && hist) {
    add('proj.history_note', 'text', { text: `Growing is net flow only: history from ${hist}, no earlier week.` });
  }
  if (p.rows.length === 0) add('proj.empty', 'text', { text: 'No project rules match any lane' });
  p.rows.forEach((r, i) => {
    const k = i + 1;
    const pre = `proj.row.${k}`;
    add(`${pre}.name`, 'row', { rank: k, text: cleanText(r.name) });
    if (r.status !== 'open') add(`${pre}.chip.status`, 'chip', { rank: k, text: STATUS_WORD[r.status], tone: r.status === 'done' ? 'ok' : 'neutral' });
    if (r.parked) add(`${pre}.chip.parked`, 'chip', { rank: k, text: 'Parked', tone: 'neutral' });
    if (r.growing) add(`${pre}.chip.growing`, 'chip', { rank: k, value: r.net, text: 'Growing', tone: growthState(r.net, p.priorKnown).tone });
    if (r.proposed) add(`${pre}.chip.proposed`, 'chip', { rank: k, text: 'Proposed', tone: 'neutral' });
    add(`${pre}.meta`, 'row', { rank: k, value: r.net, text: projectMeta(r, p.windowDays) });
  });
  if (p.hidden > 0) add('proj.more', 'text', { value: p.hidden, text: `${p.hidden} more on the board` });
  if (p.rankedByNetFlow && p.rows.length > 0) add('proj.ranked_note', 'text', { text: 'ranked by net flow, no cap set' });
  add('proj.summary', 'text', {
    text: p.openCheck === 0 ? 'No open lanes.' : `${p.withDoneWhen} of ${p.openCheck} open lanes have a done-when; ${p.unassignedOpen} unassigned.`,
  });
  add('proj.detail', 'text', { text: projectDetail(p) });
}

function tile7(add, c) {
  const a = assignmentTile(c.assignments, c.meta, c.targets);
  const w = a.windowDays;
  const today = formatDay(c.meta.today);
  const noun = (n, word) => `${n} ${pluralize(n, word)}`;
  add('assign.total', 'figure', { value: a.total, text: String(a.total) });
  if (a.total === 0) {
    add('assign.empty', 'text', { text: `No assignments in the last ${w} days` });
  } else {
    add('assign.line', 'text', {
      text: `${noun(a.total, 'assignment')} in ${w} days to ${today}, today so far: ${noun(a.claims, 'claim')}, ${noun(a.reclaims, 'reclaim')}, ${a.placed} placed by Dave`,
    });
    const series = [['claims', 'Claims'], ['reclaims', 'Reclaims'], ['placed', 'Placed by Dave']];
    const totals = a.days.map((d) => d.claims + d.reclaims + d.placed);
    a.days.forEach((d, i) => {
      add(`assign.day.${i + 1}`, 'day', { rank: i + 1, value: totals[i], text: a.labels[i] });
      for (const [key, name] of series) add(`assign.bar.${i + 1}.${key}`, 'bar', { rank: i + 1, value: d[key], text: name });
    });
    niceTicks(Math.max(0, ...totals)).forEach((t, i) => add(`assign.tick.${i + 1}`, 'tick', { rank: i + 1, value: t }));
    add('assign.aria', 'text', { text: `Stacked columns per day: ${a.labels.map((l, i) => `${l} ${totals[i]}`).join(', ')}` });
    const hist = withHistory(c.meta);
    if (a.prior) add('assign.prior', 'text', { value: a.prior.total, text: `Earlier ${w} days: ${noun(a.prior.total, 'assignment')}` });
    else if (hist) add('assign.prior', 'text', { text: `history from ${hist}, no earlier week` });
    add('assign.log.button', 'text', { value: a.log.length, text: `Show log (${a.log.length} rows)` });
    a.log.forEach((r, i) => {
      add(`assign.log.${i + 1}.lane`, 'row', { rank: i + 1, text: cleanText(r.lane_id) });
      add(`assign.log.${i + 1}.when`, 'row', { rank: i + 1, text: `${r.how}, ${formatChicago(r.at)}` });
    });
  }
  add('assign.summary', 'text', {
    text: a.total === 0 ? `No assignments in the last ${w} days.`
      : `In the ${w} days to ${today}, today so far, ${noun(a.total, 'assignment')} started: ${noun(a.claims, 'claim')}, ${noun(a.reclaims, 'reclaim')} and ${a.placed} placed by Dave.`,
  });
}

function verdictSentence(v) {
  if (v.empty) return 'No cards in this export.';
  const tail = `net ${sign(v.net)} in ${v.windowDays} days.`;
  if (v.net > 0) return `We create more cards than we close: ${tail}`;
  if (v.net < 0) return `We close more cards than we create: ${tail}`;
  return `We create and close the same number of cards: ${tail}`;
}

/**
 * The category with the largest net gain, only while the page net and that net are both above 0. It names the
 * category and its own net, never "N of the page net": other categories can shrink, so a part can pass the whole.
 */
function shareLine(v, all) {
  if (v.net <= 0) return null;
  const top = all.reduce((best, r) => (best === null || r.net > best.net ? r : best), null);
  return top && top.net > 0 ? `Largest net gain: ${cleanText(top.name)}, ${sign(top.net)}.` : null;
}

function tile8(add, c, cats) {
  const v = verdictTile(c.lanes, c.meta, c.targets);
  const g = growthState(v.net, v.prior !== null);
  const w = v.windowDays;
  const sentence = verdictSentence(v);
  add('verdict.net', 'figure', { value: v.net, text: sign(v.net) });
  add('verdict.growth', 'chip', { text: g.word, tone: g.tone });
  add('verdict.sentence', 'text', { text: sentence });
  const week = `In the ${w} days to ${formatDay(c.meta.today)}, today so far: ${v.created} created, ${v.done} closed.`;
  const waited = v.done === 0 ? `No cards closed in the last ${w} days.`
    : `${v.waited} of ${v.done} closed ${pluralize(v.done, 'card')} waited ${v.edgeDays} ${pluralize(v.edgeDays, 'day')} or more.`;
  if (!v.empty) {
    add('verdict.week', 'text', { text: week });
    add('verdict.waited', 'text', { value: v.waited, text: waited });
  }
  if (v.prior) add('verdict.prior', 'text', { text: `Earlier ${w} days: ${v.prior.created} created, ${v.prior.done} closed, net ${sign(v.prior.net)}.` });
  const share = shareLine(v, cats.all);
  if (share) add('verdict.share', 'text', { text: share });
  if (v.reminders > 0) {
    add('verdict.note', 'text', { value: v.reminders, text: `${v.reminders} reminder ${pluralize(v.reminders, 'card')} ${v.reminders === 1 ? 'is' : 'are'} left out.` });
  }
  add('verdict.summary', 'text', { text: sentence });
  add('verdict.detail', 'text', { text: v.empty ? sentence : [sentence, week, waited, share].filter(Boolean).join(' ') });
}

function categoryMeta(r, windowDays) {
  return [
    r.blocked > 0 ? `${r.open} open, ${r.blocked} blocked` : `${r.open} open`,
    `${windowDays} days: ${r.created} created, ${r.closedWindow} closed, net ${sign(r.net)}`,
    r.closedWindow > 0 ? `${r.waited} waited` : null,
    r.lastClose ? `last close ${formatDay(r.lastClose)}` : null,
  ].filter(Boolean).join(' · ');
}

function tile9(add, c, cats) {
  cats.rows.forEach((r, i) => {
    const k = i + 1;
    const pre = `cat.row.${k}`;
    add(`${pre}.name`, 'row', { rank: k, text: cleanText(r.name) });
    add(`${pre}.closed`, 'row', { rank: k, value: r.closed, text: `${r.closed} of ${r.total} closed` });
    add(`${pre}.total`, 'row', { rank: k, value: r.total });
    if (r.parked) add(`${pre}.chip.parked`, 'chip', { rank: k, text: 'Parked', tone: 'neutral' });
    if (r.net !== 0) add(`${pre}.chip.growth`, 'chip', { rank: k, value: r.net, text: growthState(r.net, cats.priorKnown).word, tone: growthState(r.net, cats.priorKnown).tone });
    add(`${pre}.meta`, 'row', { rank: k, value: r.open, text: categoryMeta(r, cats.windowDays) });
    const b = r.bands;
    add(`${pre}.bands`, 'row', { rank: k, text: `Open by band: P0 ${b.P0} · P1 ${b.P1} · P2 ${b.P2} · none ${b.none}` });
  });
  if (cats.hidden > 0) add('cat.more', 'text', { value: cats.hidden, text: `${cats.hidden} more ${cats.hidden === 1 ? 'category' : 'categories'} not shown` });
  add('cat.note', 'text', { text: 'Closed includes dropped cards. Reopened cards count as open. Reminder cards are left out.' });
  const n = cats.rows.length;
  add('cat.summary', 'text', { text: `${n} ${n === 1 ? 'category' : 'categories'}, most open cards first, ${NO_CATEGORY_NAME} last.` });
  add('cat.detail', 'text', {
    text: cats.rows.map((r) => `${cleanText(r.name)}: ${r.closed} of ${r.total} closed, ${r.open} open.`).join(' '),
  });
}

function tile10(add, c) {
  const days = dailyRows(c.lanes, c.meta, c.targets);
  days.forEach((d, i) => {
    const k = i + 1;
    add(`daily.row.${k}.label`, 'row', { rank: k, text: d.label });
    add(`daily.row.${k}.created`, 'row', { rank: k, value: d.created, text: String(d.created) });
    add(`daily.row.${k}.closed`, 'row', { rank: k, value: d.closed, text: String(d.closed) });
    add(`daily.row.${k}.net`, 'row', { rank: k, value: d.net, text: sign(d.net) });
  });
  const beat = days.filter((d) => d.closed > d.created).length;
  add('daily.note', 'text', { text: "Rebuilt from today's card states." });
  add('daily.summary', 'text', { text: `In the ${days.length} days to ${formatDay(c.meta.today)}, closed beat created on ${beat} of ${days.length} days.` });
}

function pageRows(add, c, q, p) {
  add('page.takeaway', 'text', { text: takeaway(q, p) });
  add('page.data_from', 'text', { text: c.stamp });
  // Row limits, so the page can size its loading boxes without reading targets.json.
  for (const [id, key, fallback] of [
    ['wait', 'show_rows', DEFAULT_SHOW_ROWS], ['proj', 'project_rows', DEFAULT_PROJECT_ROWS], ['log', 'log_rows', 12],
    ['cat', 'category_rows', DEFAULT_CATEGORY_ROWS],
  ]) {
    const n = num(c.targets, key, fallback);
    add(`page.rows.${id}`, 'figure', { value: n, text: String(n) });
  }
  add('page.stale.limit', 'figure', { value: c.meta.stale_after_hours, text: String(c.meta.stale_after_hours) });
  add('page.stale.chip', 'chip', { text: staleChipText(HOURS_TOKEN), tone: 'warn' });
  add('page.stale.sentence', 'chip', { text: staleSentence(c.stamp, HOURS_TOKEN), tone: 'warn' });
  add('page.fresh.sentence', 'text', { text: freshSentence(c.stamp, HOURS_TOKEN) });
}

/**
 * The rows of tiles.json. `input` = {lanes, assignments, projects, targets (rows of {key, value}), meta (the one
 * meta row), snapshots}. Returns an array of {id, tile, kind, rank, value, text, tone}. Throws on nothing a board can hold.
 */
export function buildTileRows(input) {
  const rows = [];
  const mk = rowMaker(rows);
  const c = {
    lanes: input.lanes ?? [],
    assignments: input.assignments ?? [],
    projects: input.projects ?? [],
    snapshots: input.snapshots ?? [],
    targets: targetMap(input.targets ?? []),
    meta: input.meta,
    stamp: formatChicago(input.meta.exported_at),
  };
  const q = tile1(mk(1), c);
  const p = tile2(mk(2), c);
  tile3(mk(3), c);
  tile4(mk(4), c);
  tile5(mk(5), c);
  tile6(mk(6), c);
  tile7(mk(7), c);
  const cats = categoryRows(c.projects, c.lanes, c.meta, c.targets);
  tile8(mk(8), c, cats);
  tile9(mk(9), c, cats);
  tile10(mk(10), c);
  pageRows(mk('page'), c, q, p);
  return rows;
}
