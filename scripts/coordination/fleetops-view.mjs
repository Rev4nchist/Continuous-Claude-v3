/**
 * fleetops-view -- the pure view model of the FleetOps Notion page (card coord-fleetops-notion).
 *
 * buildView(files, ids) reads the lane-dash export files and returns a plain object. Every text field is MASKED first (maskListed on the whole
 * source field), then CUT at a word boundary, and only then left for the renderer to escape. The order is fixed: a cut before the mask can leave a
 * part of a listed id that the mask no longer sees. The renderer (fleetops-notion.mjs) checks the whole page again.
 *
 * What it never reads: tile text (the old tiles give other growth numbers), meta.board_url, and any note field. The pile has ONE figure: the
 * change of the open count over the last 7 calendar days of snapshots. Every age is a count of America/Chicago calendar days (cstDayDiff) to meta.exported_at.
 */
import { maskListed } from './board-mask.mjs';

export const TZ = 'America/Chicago';
export const OLD_DAYS = 7;
export const CUT = Object.freeze({ title: 60, goal: 90, holder: 40, name: 40 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SPARK = '▁▂▃▄▅▆▇█';
const NEVER_EDGES = Object.freeze([1, 3, 7]);
const NEVER_LABELS = Object.freeze(['Under 1 d', '1–3 d', '3–7 d', '7 d or more']);
const FOLD_MIN = 3;

const stamp = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  weekday: 'short', hourCycle: 'h23', timeZoneName: 'short',
});

/** The America/Chicago calendar parts of an ISO time. The error text holds no value. */
export function cstParts(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error('a timestamp in the export is not a date');
  const p = Object.fromEntries(stamp.formatToParts(ms).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: p.hour.padStart(2, '0'), mm: p.minute.padStart(2, '0'), wd: p.weekday, tz: p.timeZoneName, ms };
}

/** Whole America/Chicago calendar days from `fromIso` to `toIso`. The one age function of the page: never a UTC floor. */
export function cstDayDiff(fromIso, toIso) {
  const a = cstParts(fromIso);
  const b = cstParts(toIso);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const dayLabel = (iso) => { const p = cstParts(iso); return `${p.d} ${MONTHS[p.m - 1]}`; };
const ymdLabel = (ymd) => { const [, m, d] = String(ymd).split('-'); return `${+d} ${MONTHS[+m - 1]}`; };
const stampLabel = (ms) => { const p = cstParts(new Date(ms).toISOString()); return `${p.wd} ${p.d} ${MONTHS[p.m - 1]}, ${p.hh}:${p.mm} ${p.tz}`; };

/** Cuts `s` (whitespace already single) at a word boundary to at most `max` chars and adds "…". A text with no space is kept whole. */
export function cutWords(s, max) {
  if (s.length <= max) return s;
  let at = s.lastIndexOf(' ', max);
  if (at <= 0) at = s.indexOf(' ');
  return at <= 0 ? s : `${s.slice(0, at).trimEnd()}…`;
}

function makeCtx(files, ids) {
  const meta = files.meta.rows[0];
  const ctx = { exportedAt: meta.exported_at, masked: 0, names: new Map() };
  const mask = (v) => { const r = maskListed(String(v ?? ''), ids); ctx.masked += r.masked; return clean(r.text); };
  const field = (max) => (v) => cutWords(mask(v), max);
  Object.assign(ctx, {
    meta, mask, title: field(CUT.title), goal: field(CUT.goal), holder: field(CUT.holder), name: field(CUT.name), id: mask,
    age: (iso) => cstDayDiff(iso, meta.exported_at), day: dayLabel,
  });
  for (const p of files.projects.rows) ctx.names.set(p.key, ctx.name(p.name));
  ctx.project = (key) => ctx.names.get(key) ?? ctx.name(key ?? 'No project');
  return ctx;
}

function askRow(l, c) {
  const age = c.age(l.dave_ask_at);
  return {
    title: c.title(l.title), id: c.id(l.id), project: c.project(l.project), band: l.band ?? null, state: clean(l.state),
    p0: l.band === 'P0', asked: c.day(l.dave_ask_at), askedAt: l.dave_ask_at, age, old: age > OLD_DAYS,
  };
}

const tier = (r) => (r.p0 ? 0 : r.old ? 1 : 2);
const askOrder = (a, b) => tier(a) - tier(b) || a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id);

function buildAsks(lanes, c) {
  const rows = lanes.filter((l) => l.dave_ask_at).map((l) => askRow(l, c)).sort(askOrder);
  const rest = rows.filter((r) => tier(r) === 2);
  const groups = new Map();
  for (const r of rest) groups.set(r.project, [...(groups.get(r.project) ?? []), r]);
  const big = [...groups].filter(([, g]) => g.length >= FOLD_MIN).sort((x, y) => y[1].length - x[1].length);
  const folded = new Set(big.flatMap(([, g]) => g));
  return {
    total: rows.length, over: rows.filter((r) => r.old).length, main: rows.filter((r) => tier(r) < 2),
    folds: big.map(([name, g]) => ({ name, rows: g, oldest: g[0].age })), other: rest.filter((r) => !folded.has(r)),
    blockedNoAsk: lanes.filter((l) => l.state === 'blocked' && !l.dave_ask_at).length,
  };
}

function sparkOf(values) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return values.map((v) => SPARK[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join('');
}

/** The calendar day `n` days before the 'YYYY-MM-DD' day `day` (date arithmetic only: no time zone). */
function dayMinus(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

/**
 * The one pile figure: the open count of the last snapshot minus the open count 7 calendar days before it (the oldest snapshot on or after
 * that day when one is missing). null when there are fewer than 2 snapshots in the window.
 */
function buildPile(snaps, c) {
  const sorted = [...snaps].sort((a, b) => a.day.localeCompare(b.day));
  if (sorted.length === 0) return null;
  const from = dayMinus(sorted[sorted.length - 1].day, 7);
  const s = sorted.filter((r) => r.day >= from);
  if (s.length < 2) return null;
  const open = s.map((r) => r.open);
  return {
    count: s.length, span: (Date.parse(s[s.length - 1].day) - Date.parse(s[0].day)) / 86400000, from: open[0], to: open[open.length - 1], change: open[open.length - 1] - open[0], min: Math.min(...open), max: Math.max(...open),
    spark: sparkOf(open), first: ymdLabel(s[0].day), last: ymdLabel(s[s.length - 1].day), partialDay: s[s.length - 1].day === c.meta.today,
    days: s.map((r, i) => ({ label: ymdLabel(r.day), open: r.open, change: i === 0 ? null : r.open - s[i - 1].open })),
  };
}

function buildNever(lanes, c) {
  const never = lanes.filter((l) => !l.last_work_at);
  const counts = NEVER_LABELS.map(() => 0);
  for (const l of never) counts[NEVER_EDGES.filter((e) => c.age(l.created_at) >= e).length] += 1;
  const top = new Map();
  for (const l of never) top.set(c.project(l.project), (top.get(c.project(l.project)) ?? 0) + 1);
  const peak = Math.max(1, ...counts);
  return {
    total: never.length, open: lanes.length, old: counts[3],
    buckets: counts.map((n, i) => ({ label: NEVER_LABELS[i], count: n, width: n ? Math.max(1, Math.round((n / peak) * 20)) : 0, old: i === 3 })),
    top: [...top].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([name, count]) => ({ name, count })),
  };
}

function buildWip(lanes, c) {
  const now = Date.parse(c.exportedAt);
  const rows = lanes.filter((l) => l.held).map((l) => {
    const lapsed = Boolean(l.lease_expires_at) && Date.parse(l.lease_expires_at) < now;
    return {
      title: c.title(l.title), id: c.id(l.id), goal: l.goal ? c.goal(l.goal) : '', holder: l.holder ? c.holder(l.holder) : '', state: clean(l.state),
      lapsed, leaseAt: l.lease_expires_at ?? '', lapsedOn: lapsed ? c.day(l.lease_expires_at) : '', lapsedDays: lapsed ? c.age(l.lease_expires_at) : 0,
    };
  });
  rows.sort((a, b) => Number(b.lapsed) - Number(a.lapsed) || a.leaseAt.localeCompare(b.leaseAt) || a.id.localeCompare(b.id));
  return { rows, live: rows.filter((r) => !r.lapsed).length, lapsed: rows.filter((r) => r.lapsed).length };
}

function buildP0(lanes, targets, c) {
  const p0 = lanes.filter((l) => l.band === 'P0');
  const cap = targets.rows.find((t) => t.key === 'p0_cap');
  return {
    open: p0.length, cap: cap ? cap.value : null,
    unheld: p0.filter((l) => !l.held).map((l) => ({ title: c.title(l.title), id: c.id(l.id), age: l.dave_ask_at ? c.age(l.dave_ask_at) : null })),
  };
}

function buildProjects(files, c) {
  const open = (key) => files.lanes.rows.filter((l) => l.project === key).length;
  return files.projects.rows
    .map((p) => ({ p, open: open(p.key) }))
    .filter(({ p, open: n }) => !(clean(p.name).toLowerCase() === 'unassigned' && n === 0 && !p.terminal_total))
    .filter(({ p, open: n }) => p.status !== 'done' || p.visible_until || n > 0)
    .map(({ p, open: n }) => {
      const doneOpen = p.status === 'done' && n > 0;
      const state = p.status === 'no_end' ? 'Ongoing' : p.status === 'done' ? (doneOpen ? `Done · ${n} open` : 'Done') : 'Open';
      return { name: c.project(p.key), state, decision: doneOpen, ended: p.terminal_total ? `${p.terminal_done ?? 0} of ${p.terminal_total}` : '—' };
    });
}

export function buildView(files, ids) {
  const c = makeCtx(files, ids);
  const lanes = files.lanes.rows;
  const staleAtMs = c.meta.stale_after_hours == null ? null : cstParts(c.exportedAt).ms + c.meta.stale_after_hours * 3600000;
  const view = {
    exportedAt: c.exportedAt, dataFrom: stampLabel(Date.parse(c.exportedAt)), staleAtMs, staleAt: staleAtMs == null ? '' : stampLabel(staleAtMs),
    openCount: lanes.length, asks: buildAsks(lanes, c), pile: buildPile(files.snapshots.rows, c), never: buildNever(lanes, c),
    wip: buildWip(lanes, c), p0: buildP0(lanes, files.targets, c), projects: buildProjects(files, c),
    daily: [...files.snapshots.rows].sort((a, b) => a.day.localeCompare(b.day)).map((s) => [ymdLabel(s.day), s.open, s.done, s.blocked, s.active, s.p0_open, s.p1_open, s.p2_open, s.unbanded_open, s.never_started_open]),
  };
  view.masked = c.masked;
  return view;
}
