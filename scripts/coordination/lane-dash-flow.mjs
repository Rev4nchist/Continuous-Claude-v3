/**
 * lane-dash-flow -- the Flow rows of the lane export (flow.json), phase A: what the lane database alone can say.
 *
 * export-dash-data.mjs calls buildFlowRows and writes the result as flow.json ({sql, exportedAt, rows}).
 * The Fleet app reads it. FleetOps does not: flow.json is not a dashboard source and is never uploaded there.
 * Design: .claudedocs/2026-11-09-lane-dash-flow-rows-design.md.
 *
 * Pure: no database, no file, no clock. "Today" is meta.today. Counts only: no lane id, title, note, session or handle
 * is read into a row. Tone is always null (Dave set no flow limit, so no verdict).
 *
 * ---------------------------------------------------------------- flow.json rows
 * The same 7 columns as tiles.json (TILE_COLUMNS), tile is the string "flow". Kinds: figure, text, day, bar.
 * `week` = the last window_days Chicago days to meta.today, today partial. The grid is 2 x window_days days,
 * oldest first, rank 2 x window_days = today. A row that does not apply is left out, not written with nulls.
 *   flow.days                     figure  length of the grid
 *   flow.day.<r>                  day     done lanes that day; text "Oct 26" or "today"
 *   flow.bar.<r>.claimed          bar     distinct lanes with a session claim that day (a reclaim of one lane counts once)
 *   flow.bar.<r>.done             bar     lanes whose done_day is that day
 *   flow.bar.<r>.created          bar     lanes whose created_day is that day
 *   flow.bar.<r>.reopened         bar     distinct lanes with a reopen signal that day
 *   flow.week.claimed|done|created|net
 *   flow.week.claimed.label       text    "lanes claimed, not claim events" (tile 7 of tiles.json counts claim events)
 *   flow.week.median_h            figure  median hours from first claim to done, over lanes done in the week (2 decimals)
 *   flow.week.median_n|median_skipped|median_negative   lanes behind the median, done with no claim, done before the first claim
 *   flow.week.rework.done|lanes|pct   distinct lanes with a done signal in the week; the part of them reopened after that done
 *                                 (a subset, so the rate never passes 100%); lanes over done lanes, one decimal
 *   flow.week.rework.done.label   text    "done lanes, including reopened"
 *   flow.week.rework.note         text    only when rework.done is 0 (then there is no pct)
 *   flow.today.claimed|done|reopened    the same figures as the last grid day
 *   flow.history_note, flow.summary
 *
 * `rework` input = rows {lane_id, done_at, reopen_at}: one per done signal, with the first reopen signal after it
 * (null when none; the SQL guarantees it is later than done_at). A reopen counts in rework.lanes only through a done
 * signal of the same week: a lane done before the week and reopened inside it is not in rework.done, so it is not in
 * rework.lanes. It still shows on its day in flow.bar.<r>.reopened. It comes from SQL_REWORK in export-dash-data.mjs and is never written out.
 *
 * Importing this file does nothing.
 */
import { addDays, chicagoDay, dayLabels, formatDay, inWindow, pluralize, sign, targetMap, windowOf } from './lane-dash-metrics.mjs';

export const FLOW_TILE = 'flow';
const HOUR_MS = 3_600_000;

/** The median of a non-empty list. An even count takes the mean of the two middle values, like percentile_cont(0.5). */
function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** A Map of day to Set of keys. */
function addTo(map, day, key) {
  if (!map.has(day)) map.set(day, new Set());
  map.get(day).add(key);
}
const countOn = (map, day) => map.get(day)?.size ?? 0;

/** Chicago day of an ISO time, or null for a missing one. The metrics chicagoDay turns null into 1969-12-31. */
const dayOf = (iso) => (iso === null || iso === undefined ? null : chicagoDay(iso));

/** Median claim-to-done of the lanes done in the window, and the lanes that stay out of it. */
function medianOf(lanes, w) {
  const hours = [];
  let skipped = 0;
  let negative = 0;
  for (const l of lanes) {
    if (!inWindow(l.done_day, w)) continue;
    if (l.first_claim_at === null || l.first_claim_at === undefined) { skipped++; continue; }
    const h = (Date.parse(l.done_at) - Date.parse(l.first_claim_at)) / HOUR_MS;
    if (!(h >= 0)) { negative++; continue; }
    hours.push(h);
  }
  const m = hours.length ? Math.round(median(hours) * 100) / 100 : null;
  return { hours: m, n: hours.length, skipped, negative };
}

/**
 * Distinct lanes with a done signal in the window, and the ones among them that were reopened after that done.
 * The second set is built from the first, so it is always a subset: the rate cannot pass 100%.
 */
function reworkOf(rework, w) {
  const done = new Set();
  const reopened = new Set();
  for (const r of rework) {
    if (!inWindow(dayOf(r.done_at), w)) continue;
    done.add(r.lane_id);
    if (r.reopen_at) reopened.add(r.lane_id);
  }
  return { done: done.size, lanes: reopened.size };
}

function rowMaker(rows) {
  return (id, kind, f = {}) => {
    const value = f.value === undefined || f.value === null || !Number.isFinite(f.value) ? null : f.value;
    rows.push({ id, tile: FLOW_TILE, kind, rank: f.rank ?? null, value, text: f.text ?? null, tone: null });
  };
}

/**
 * The rows of flow.json. `input` = {lanes, assignments, rework, meta (the one meta row), targets (rows of {key, value})}.
 * Returns an array of {id, tile, kind, rank, value, text, tone}.
 */
export function buildFlowRows(input) {
  const meta = input.meta;
  const lanes = input.lanes ?? [];
  const rework = input.rework ?? [];
  const windowDays = targetMap(input.targets ?? []).window_days ?? 7;
  const size = 2 * windowDays;
  const grid = Array.from({ length: size }, (_, i) => addDays(meta.today, i - (size - 1)));
  const w = windowOf(meta.today, windowDays);

  const claimed = new Map();
  for (const a of input.assignments ?? []) if (a.who === 'session') addTo(claimed, a.day, a.lane_id);
  const done = new Map();
  const created = new Map();
  for (const l of lanes) {
    if (l.done_day) addTo(done, l.done_day, l.id);
    if (l.created_day) addTo(created, l.created_day, l.id);
  }
  const reopened = new Map();
  for (const r of rework) if (r.reopen_at) addTo(reopened, dayOf(r.reopen_at), r.lane_id);

  const weekLanes = (map) => new Set(grid.filter((d) => inWindow(d, w)).flatMap((d) => [...(map.get(d) ?? [])]));
  const week = {
    claimed: weekLanes(claimed).size,
    done: lanes.filter((l) => inWindow(l.done_day, w)).length,
    created: lanes.filter((l) => inWindow(l.created_day, w)).length,
  };
  const med = medianOf(lanes, w);
  const rw = reworkOf(rework, w);

  const rows = [];
  const add = rowMaker(rows);
  const figure = (id, value, text = String(value)) => add(id, 'figure', { value, text });

  add('flow.days', 'figure', { value: size, text: String(size) });
  const labels = dayLabels(grid.map((day) => ({ day })));
  grid.forEach((day, i) => {
    const r = i + 1;
    add(`flow.day.${r}`, 'day', { rank: r, value: countOn(done, day), text: labels[i] });
    add(`flow.bar.${r}.claimed`, 'bar', { rank: r, value: countOn(claimed, day), text: 'Claimed' });
    add(`flow.bar.${r}.done`, 'bar', { rank: r, value: countOn(done, day), text: 'Done' });
    add(`flow.bar.${r}.created`, 'bar', { rank: r, value: countOn(created, day), text: 'Created' });
    add(`flow.bar.${r}.reopened`, 'bar', { rank: r, value: countOn(reopened, day), text: 'Reopened' });
  });

  figure('flow.week.claimed', week.claimed);
  add('flow.week.claimed.label', 'text', { text: 'lanes claimed, not claim events' });
  figure('flow.week.done', week.done);
  figure('flow.week.created', week.created);
  figure('flow.week.net', week.created - week.done, sign(week.created - week.done));
  if (med.n > 0) figure('flow.week.median_h', med.hours, `${med.hours.toFixed(2)} h`);
  figure('flow.week.median_n', med.n);
  figure('flow.week.median_skipped', med.skipped);
  if (med.negative > 0) figure('flow.week.median_negative', med.negative);
  figure('flow.week.rework.done', rw.done);
  add('flow.week.rework.done.label', 'text', { text: 'done lanes, including reopened' });
  figure('flow.week.rework.lanes', rw.lanes);
  if (rw.done > 0) {
    const pct = Math.round((rw.lanes / rw.done) * 1000) / 10;
    figure('flow.week.rework.pct', pct, `${pct.toFixed(1)}%`);
  } else {
    add('flow.week.rework.note', 'text', { text: `No lanes done in the last ${windowDays} days` });
  }

  const bars = { claimed, done, reopened };
  for (const [name, map] of Object.entries(bars)) figure(`flow.today.${name}`, countOn(map, grid[size - 1]));

  if (typeof meta.history_start === 'string' && meta.history_start > grid[0]) {
    add('flow.history_note', 'text', { text: `history from ${formatDay(meta.history_start)}` });
  }

  const was = (n) => (n === 1 ? 'was' : 'were');
  const parts = [
    `In the ${windowDays} days to ${formatDay(meta.today)}, today so far, ${week.claimed} ${pluralize(week.claimed, 'lane')} ${was(week.claimed)} claimed and ${week.done} finished.`,
    med.n > 0 ? `Median claim to done ${med.hours.toFixed(2)} h over ${med.n} ${pluralize(med.n, 'lane')}.` : '',
    rw.done > 0 ? `${rw.lanes} of ${rw.done} done ${pluralize(rw.done, 'lane')} ${was(rw.lanes)} reopened.` : '',
  ];
  add('flow.summary', 'text', { text: parts.filter(Boolean).join(' ') });
  return rows;
}
