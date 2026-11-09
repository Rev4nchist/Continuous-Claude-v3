/**
 * factory-rows -- the rows of factory.json for the Fleet app Flow tab (Phase B): what four local files can say.
 * The files: the pre-PR gate log, the review ledger, the CodeRabbit paid ledger and the handoff YAML headers.
 *
 * export-factory-data.mjs reads the files, reduces each row to the allowed fields and calls buildFactoryRows. The Fleet
 * app reads the result. FleetOps does not: factory.json is not a dashboard source and is never uploaded there.
 * Design: .claudedocs/2026-11-09-factory-json-design.md (revision 2). Importing this file does nothing.
 *
 * Pure: no file, no clock, no path. "Today" and the run time come in as input. Every row is a count, a sum, a percent
 * or a date. No path, branch, head, session id, prompt or finding text can reach a row: every string in a row comes from
 * a closed list in this file, and a free string in the input (a status, a purpose, an outcome, a kind) is counted under
 * "other" and never copied. The run and head keys are opaque and only group rows in memory.
 *
 * ---------------------------------------------------------------- input
 * buildFactoryRows({today, exportedAt, targets, cap, prpr, rev, coderabbit, hand, prsLanded, prsOpened, prsCheck})
 *   today        Chicago day of the run, YYYY-MM-DD
 *   exportedAt   the run time, ISO UTC. A row after it is a bad line
 *   targets      rows {key, value}; window_days sets the week (default 7)
 *   cap          the CodeRabbit monthly file cap (a whole number, 0 allowed) or null
 *   each family  {ok: true, rows, bad} or {ok: false, reason}. reason is one of missing, empty, corrupt, too large, reader error, unreachable
 *     prpr       rows {ts, run, head, status}      head '' is a headless run
 *     rev        rows {ts, phase, purpose, timedOut}
 *     coderabbit rows {ts, kind, files, cost}      kind null is a PR row; cost in dollars
 *     hand       rows {date, outcome}               date is a calendar day, no time
 *     prsLanded  rows {ts}                          a PR landed on main (git), every event read, in the grid or not
 *     prsOpened  rows {ts}                          a PR opened (GitHub), every event read
 *   prsCheck     {ok: true, apiCount, weekStart} or {ok: false, reason}: the GitHub count of PRs merged this week. One integer
 *                and the first day of the week it was asked for. A missing key leaves the check row out.
 * Design for the PR rows: .claudedocs/2026-11-09-factory-json-b2-design.md (revision 4).
 *
 * ---------------------------------------------------------------- factory.json rows
 * The 7 columns of tiles.json (TILE_COLUMNS), tile is the string "factory", tone is always null. Kinds: figure, text, day, bar.
 * `week` = the last window_days Chicago days to today, today partial. The grid is 2 x window_days days, oldest first,
 * rank 2 x window_days = today. A row that does not apply is left out, not written with nulls.
 *   factory.days | factory.today | factory.day.<r>          the grid (day rows carry the ISO day in text)
 *   F.rows | F.bad_lines | F.as_of | F.first_day | F.note     for F in prpr, rev, rev.coderabbit, hand
 *   F.note                                                    "no data: <reason>" (family dark: the only row of F)
 *                                                             or "no data since <Mon D>" (family quiet: real zeros stay)
 *   prpr.bar.<r>.runs|fail_runs|fail_rows|heads|first_pass   prpr.week.* prpr.today.* prpr.summary
 *   prpr.prs.S.bar.<r>  prpr.prs.S.week|today|as_of|rows|bad_lines|note   for S in landed, opened (no first_day: a lookback is not history)
 *   prpr.prs.landed.check   figure: GitHub count minus git count for the week; text "GitHub agrees", "GitHub counts more" or "git counts more"
 *   rev.bar.<r>.runs  rev.week.runs|purpose.<p>|timed_out  rev.today.*  rev.all.runs  rev.summary
 *   rev.coderabbit.bar.<r>.usd|files  .today.usd  .week.usd|files  .month.*  .price_per_file  .floor_note  .summary
 *   hand.bar.<r>.<outcome>  hand.week.total|<outcome>|success_pct  hand.today.total  hand.summary
 */
import { addDays, chicagoDay, formatDay, inWindow, pluralize, targetMap, windowOf } from './lane-dash-metrics.mjs';

export const FACTORY_TILE = 'factory';

const REASONS = ['missing', 'empty', 'corrupt', 'too large', 'reader error', 'unreachable'];
const STATUS_KEYS = { PASS: 'pass', NOTE: 'note', FAIL: 'fail', SKIP: 'skip' };
const PURPOSES = ['review', 'bench', 'eval', 'other', 'verify', 'unknown'];
const OUTCOMES = [
  { word: 'SUCCEEDED', key: 'succeeded', label: 'Succeeded' },
  { word: 'PARTIAL_PLUS', key: 'partial_plus', label: 'Partial plus' },
  { word: 'PARTIAL_MINUS', key: 'partial_minus', label: 'Partial minus' },
  { word: 'FAILED', key: 'failed', label: 'Failed' },
  { word: null, key: 'other', label: 'Other' },
];
/** CodeRabbit price per file, in cents. Mirrors CENTS_PER_FILE in scripts/github/lib/cr-paid.mjs. */
const CENTS_PER_FILE = 25;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const SENTENCE = {
  capSource: 'repo cap: review-router.config.json coderabbit.monthly_file_cap, PR rows only',
  floorNote: 'paid rounds only; a review on a free slot is not in the ledger',
};

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const pct = (part, whole) => Math.round((part / whole) * 1000) / 10;
const pctText = (p) => `${p.toFixed(1)}%`;
const bump = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const sumOver = (map, days) => days.reduce((s, d) => s + (map.get(d) ?? 0), 0);

function rowMaker(rows) {
  return (id, kind, f = {}) => {
    const value = f.value === undefined || f.value === null || !Number.isFinite(f.value) ? null : f.value;
    rows.push({ id, tile: FACTORY_TILE, kind, rank: f.rank ?? null, value, text: f.text ?? null, tone: null });
  };
}

/**
 * One family's input as {rows, bad} or {reason}. Rows with an unparseable ts or a ts after the run time, and hand rows
 * with a date that is not a calendar day or is after today, are dropped and counted as bad. No valid row left is "empty".
 */
function intake(fam, { today, exportedMs, isHand }) {
  if (!fam || fam.ok !== true || !Array.isArray(fam.rows)) {
    return { reason: REASONS.includes(fam?.reason) ? fam.reason : (fam?.ok === false ? 'reader error' : 'missing') };
  }
  let bad = Number.isInteger(fam.bad) && fam.bad > 0 ? fam.bad : 0;
  const rows = [];
  for (const r of fam.rows) {
    if (isHand) {
      if (typeof r?.date === 'string' && ISO_DAY.test(r.date) && r.date <= today) rows.push({ ...r, day: r.date });
      else bad++;
      continue;
    }
    const ms = Date.parse(r?.ts);
    if (Number.isFinite(ms) && ms <= exportedMs) rows.push({ ...r, ms, day: chicagoDay(r.ts) });
    else bad++;
  }
  return rows.length === 0 ? { reason: 'empty' } : { rows, bad };
}

/**
 * The status rows every readable family has: rows, bad_lines, as_of, first_day, and the quiet note. Returns false for a dark one.
 * `firstDay: false` leaves first_day out: for the PR families the oldest row read is a lookback bound, not the start of history.
 */
function familyHeader(add, id, info, today, { firstDay = true } = {}) {
  if (info.reason) {
    add(`${id}.note`, 'text', { text: `no data: ${info.reason}` });
    return false;
  }
  const days = info.rows.map((r) => r.day).sort();
  const asOf = days[days.length - 1];
  add(`${id}.as_of`, 'text', { text: asOf });
  add(`${id}.rows`, 'figure', { value: info.rows.length, text: String(info.rows.length) });
  add(`${id}.bad_lines`, 'figure', { value: info.bad, text: String(info.bad) });
  if (firstDay) add(`${id}.first_day`, 'text', { text: days[0] });
  if (asOf < today) add(`${id}.note`, 'text', { text: `no data since ${formatDay(asOf)}` });
  return true;
}

/** Runs and heads of the pre-PR log, bucketed by Chicago day. A run's day is the day of its smallest ts. */
function prprCounts(rows) {
  const runs = new Map();
  for (const r of rows) {
    const run = runs.get(r.run) ?? { ms: Infinity, day: null, head: '', fail: false };
    runs.set(r.run, run);
    if (r.ms < run.ms) { run.ms = r.ms; run.day = r.day; }
    if (r.status === 'FAIL') run.fail = true;
    if (!run.head && typeof r.head === 'string' && r.head) run.head = r.head;
  }
  const firstRun = new Map();
  for (const run of runs.values()) {
    if (!run.head) continue; // a headless run is a run, never a head
    const cur = firstRun.get(run.head);
    if (!cur || run.ms < cur.ms || (run.ms === cur.ms && run.fail && !cur.fail)) firstRun.set(run.head, run);
  }
  const by = { runs: new Map(), failRuns: new Map(), failRows: new Map(), heads: new Map(), firstPass: new Map(), status: new Map() };
  for (const run of runs.values()) {
    bump(by.runs, run.day);
    if (run.fail) bump(by.failRuns, run.day);
  }
  for (const run of firstRun.values()) {
    bump(by.heads, run.day);
    if (!run.fail) bump(by.firstPass, run.day);
  }
  for (const r of rows) {
    if (r.status === 'FAIL') bump(by.failRows, r.day);
    bump(by.status, `${r.day} ${Object.hasOwn(STATUS_KEYS, r.status) ? STATUS_KEYS[r.status] : 'other'}`);
  }
  return by;
}

function prprRows(add, info, g) {
  const by = prprCounts(info.rows);
  const bar = (name, label, map) => g.grid.forEach((day, i) => add(`prpr.bar.${i + 1}.${name}`, 'bar', { rank: i + 1, value: map.get(day) ?? 0, text: label }));
  bar('runs', 'Runs', by.runs);
  bar('fail_runs', 'Runs with a FAIL', by.failRuns);
  bar('fail_rows', 'FAIL rows', by.failRows);
  bar('heads', 'First runs', by.heads);
  bar('first_pass', 'First-run pass', by.firstPass);

  const week = { runs: sumOver(by.runs, g.weekDays), failRuns: sumOver(by.failRuns, g.weekDays), heads: sumOver(by.heads, g.weekDays), firstPass: sumOver(by.firstPass, g.weekDays) };
  const figure = (id, value, text = String(value)) => add(id, 'figure', { value, text });
  figure('prpr.week.runs', week.runs);
  figure('prpr.week.fail_runs', week.failRuns);
  if (week.runs > 0) figure('prpr.week.fail_share_pct', pct(week.failRuns, week.runs), pctText(pct(week.failRuns, week.runs)));
  figure('prpr.week.heads', week.heads);
  figure('prpr.week.first_pass', week.firstPass);
  if (week.heads > 0) figure('prpr.week.first_pass_pct', pct(week.firstPass, week.heads), pctText(pct(week.firstPass, week.heads)));
  for (const key of [...Object.values(STATUS_KEYS), 'other']) {
    figure(`prpr.week.status.${key}`, g.weekDays.reduce((s, d) => s + (by.status.get(`${d} ${key}`) ?? 0), 0));
  }
  const daysOfData = g.weekDays.filter((d) => (by.runs.get(d) ?? 0) > 0).length;
  figure('prpr.week.days_of_data', daysOfData);
  if (daysOfData < g.windowDays) add('prpr.week.days_note', 'text', { text: `${daysOfData} of ${g.windowDays} days of data` });

  figure('prpr.today.runs', by.runs.get(g.today) ?? 0);
  figure('prpr.today.fail_runs', by.failRuns.get(g.today) ?? 0);
  const todayHeads = by.heads.get(g.today) ?? 0;
  if (todayHeads > 0) {
    const p = pct(by.firstPass.get(g.today) ?? 0, todayHeads);
    figure('prpr.today.first_pass_pct', p, pctText(p));
  }
  const parts = [
    `In the ${g.windowDays} days to ${formatDay(g.today)}, today so far, ${week.runs} pre-PR ${pluralize(week.runs, 'run')}, ${week.failRuns} with a FAIL.`,
    week.heads > 0 ? `First-run pass ${week.firstPass} of ${week.heads} ${pluralize(week.heads, 'head')} (${pctText(pct(week.firstPass, week.heads))}).` : '',
    daysOfData < g.windowDays ? `${daysOfData} of ${g.windowDays} days of data.` : '',
  ];
  add('prpr.summary', 'text', { text: parts.filter(Boolean).join(' ') });
}

function revRows(add, info, g) {
  const starts = info.rows.filter((r) => r.phase === 'start');
  const ends = info.rows.filter((r) => r.phase === 'end');
  const runsBy = new Map();
  const purposeBy = new Map();
  for (const r of starts) {
    bump(runsBy, r.day);
    const purpose = r.purpose === null || r.purpose === undefined ? 'unknown' : (PURPOSES.includes(r.purpose) ? r.purpose : 'other');
    bump(purposeBy, `${r.day} ${purpose}`);
  }
  g.grid.forEach((day, i) => add(`rev.bar.${i + 1}.runs`, 'bar', { rank: i + 1, value: runsBy.get(day) ?? 0, text: 'Review runs' }));
  const figure = (id, value) => add(id, 'figure', { value, text: String(value) });
  const weekRuns = sumOver(runsBy, g.weekDays);
  figure('rev.week.runs', weekRuns);
  for (const p of PURPOSES) figure(`rev.week.purpose.${p}`, g.weekDays.reduce((s, d) => s + (purposeBy.get(`${d} ${p}`) ?? 0), 0));
  figure('rev.week.timed_out', ends.filter((r) => r.timedOut === true && inWindow(r.day, g.w)).length);
  figure('rev.today.runs', runsBy.get(g.today) ?? 0);
  for (const p of PURPOSES) figure(`rev.today.purpose.${p}`, purposeBy.get(`${g.today} ${p}`) ?? 0);
  figure('rev.all.runs', starts.length);
  const lastRun = starts.map((r) => r.day).sort().pop();
  const first = info.rows.map((r) => r.day).sort()[0];
  const parts = [
    `${weekRuns} review ${pluralize(weekRuns, 'run')} in the ${g.windowDays} days to ${formatDay(g.today)}.`,
    lastRun ? `Last run ${formatDay(lastRun)}.` : '',
    starts.length > 0 ? `${starts.length} ${pluralize(starts.length, 'run')} since ${formatDay(first)}.` : '',
  ];
  add('rev.summary', 'text', { text: parts.filter(Boolean).join(' ') });
}

function coderabbitRows(add, info, g, cap) {
  const centsBy = new Map();
  const filesBy = new Map();
  const month = g.today.slice(0, 7);
  const m = { pr: { cents: 0, files: 0 }, cli: { cents: 0, files: 0 }, all: 0 };
  for (const r of info.rows) {
    const cents = Math.round(r.cost * 100);
    bump(centsBy, r.day, cents);
    bump(filesBy, r.day, r.files);
    if (!r.day.startsWith(month)) continue;
    m.all += cents;
    const kind = r.kind === null || r.kind === undefined ? 'pr' : (r.kind === 'cli' ? 'cli' : null);
    if (kind) { m[kind].cents += cents; m[kind].files += r.files; }
  }
  g.grid.forEach((day, i) => {
    add(`rev.coderabbit.bar.${i + 1}.usd`, 'bar', { rank: i + 1, value: (centsBy.get(day) ?? 0) / 100, text: 'CodeRabbit $' });
    add(`rev.coderabbit.bar.${i + 1}.files`, 'bar', { rank: i + 1, value: filesBy.get(day) ?? 0, text: 'Files' });
  });
  const money = (id, cents) => add(id, 'figure', { value: cents / 100, text: dollars(cents) });
  const count = (id, n) => add(id, 'figure', { value: n, text: String(n) });
  const todayCents = centsBy.get(g.today) ?? 0;
  const weekCents = sumOver(centsBy, g.weekDays);
  money('rev.coderabbit.today.usd', todayCents);
  money('rev.coderabbit.week.usd', weekCents);
  count('rev.coderabbit.week.files', sumOver(filesBy, g.weekDays));
  const monthLabel = `${formatDay(`${month}-01`).split(' ')[0]} ${month.slice(0, 4)}`;
  add('rev.coderabbit.month.label', 'text', { text: monthLabel });
  money('rev.coderabbit.month.pr.usd', m.pr.cents);
  count('rev.coderabbit.month.pr.files', m.pr.files);
  money('rev.coderabbit.month.cli.usd', m.cli.cents);
  count('rev.coderabbit.month.cli.files', m.cli.files);
  money('rev.coderabbit.month.usd', m.all);
  if (cap !== null && cap !== undefined) {
    add('rev.coderabbit.month.cap.files', 'figure', { value: cap, text: `${cap} files a month` });
    if (cap > 0) add('rev.coderabbit.month.cap.pct', 'figure', { value: pct(m.pr.files, cap), text: pctText(pct(m.pr.files, cap)) });
    money('rev.coderabbit.month.cap.usd', cap * CENTS_PER_FILE);
    add('rev.coderabbit.month.cap.source', 'text', { text: SENTENCE.capSource });
  }
  add('rev.coderabbit.price_per_file', 'figure', { value: CENTS_PER_FILE / 100, text: `${dollars(CENTS_PER_FILE)} per file` });
  add('rev.coderabbit.floor_note', 'text', { text: SENTENCE.floorNote });
  const asOf = info.rows.map((r) => r.day).sort().pop();
  const of = cap === null || cap === undefined ? '' : ` of ${cap}`;
  add('rev.coderabbit.summary', 'text', {
    text: `CodeRabbit: ${dollars(todayCents)} today, ${dollars(weekCents)} this week, ${dollars(m.all)} in ${monthLabel} (${dollars(m.pr.cents)} on PRs, ${m.pr.files}${of} files). Last paid run ${formatDay(asOf)}.`,
  });
}

function handRows(add, info, g) {
  const by = new Map();
  for (const r of info.rows) {
    const o = OUTCOMES.find((x) => x.word !== null && x.word === r.outcome) ?? OUTCOMES[OUTCOMES.length - 1];
    bump(by, `${r.day} ${o.key}`);
  }
  const on = (day, key) => by.get(`${day} ${key}`) ?? 0;
  g.grid.forEach((day, i) => {
    for (const o of OUTCOMES) add(`hand.bar.${i + 1}.${o.key}`, 'bar', { rank: i + 1, value: on(day, o.key), text: o.label });
  });
  const figure = (id, value, text = String(value)) => add(id, 'figure', { value, text });
  const weekOf = (key) => g.weekDays.reduce((s, d) => s + on(d, key), 0);
  const total = OUTCOMES.reduce((s, o) => s + weekOf(o.key), 0);
  figure('hand.week.total', total);
  for (const o of OUTCOMES) figure(`hand.week.${o.key}`, weekOf(o.key));
  const succeeded = weekOf('succeeded');
  if (total > 0) figure('hand.week.success_pct', pct(succeeded, total), pctText(pct(succeeded, total)));
  const todayTotal = OUTCOMES.reduce((s, o) => s + on(g.today, o.key), 0);
  figure('hand.today.total', todayTotal);
  const share = total > 0 ? ` (${pctText(pct(succeeded, total))})` : '';
  add('hand.summary', 'text', {
    text: `${total} ${pluralize(total, 'handoff')} in the ${g.windowDays} days to ${formatDay(g.today)}, ${succeeded} succeeded${share}. ${todayTotal} today.`,
  });
}

/** Events per Chicago day, from intake rows. */
function countByDay(rows) {
  const by = new Map();
  for (const r of rows) bump(by, r.day);
  return by;
}

/** One PR sub-family (landed or opened): a bar per grid day, the week and today figures. `id` is the row id prefix. */
function prsRows(add, id, info, g, label) {
  const by = countByDay(info.rows);
  g.grid.forEach((day, i) => add(`${id}.bar.${i + 1}`, 'bar', { rank: i + 1, value: by.get(day) ?? 0, text: label }));
  const week = sumOver(by, g.weekDays);
  add(`${id}.week`, 'figure', { value: week, text: String(week) });
  const todayCount = by.get(g.today) ?? 0;
  add(`${id}.today`, 'figure', { value: todayCount, text: String(todayCount) });
}

/** The three texts of the check row. */
const CHECK_TEXT = { 0: 'GitHub agrees', 1: 'GitHub counts more', [-1]: 'git counts more' };

/**
 * prpr.prs.landed.check: the GitHub search count of the week minus the git week sum (from the landed rows, never from the key).
 * Left out, with no note, when either PR family is dark, the key is dark or for another week, or the count is not a whole number.
 */
function checkRow(add, landed, opened, g, prsCheck) {
  if (landed.reason || opened.reason || prsCheck?.ok !== true) return;
  if (!Number.isInteger(prsCheck.apiCount) || prsCheck.apiCount < 0 || prsCheck.weekStart !== g.weekDays[0]) return;
  const diff = prsCheck.apiCount - sumOver(countByDay(landed.rows), g.weekDays);
  add('prpr.prs.landed.check', 'figure', { value: diff, text: CHECK_TEXT[Math.sign(diff)] });
}

/** The grid of a run: window_days from the targets (default 7), the 2 x window_days grid start and the first day of the week. */
export function gridOf(today, targets) {
  const configured = targetMap(targets ?? []).window_days;
  const windowDays = Number.isInteger(configured) && configured > 0 ? configured : 7;
  const size = 2 * windowDays;
  return { windowDays, size, start: addDays(today, -(size - 1)), weekStart: addDays(today, -(windowDays - 1)) };
}

/** The instant a Chicago day starts, ISO UTC: 05:00:00Z in CDT, 06:00:00Z in CST. */
export function chicagoMidnight(day) {
  const cdt = `${day}T05:00:00Z`;
  return chicagoDay(cdt) === day ? cdt : `${day}T06:00:00Z`;
}

/** The rows of factory.json. See the header for the input. Returns an array of {id, tile, kind, rank, value, text, tone}. */
export function buildFactoryRows(input) {
  const { today, exportedAt } = input;
  const { windowDays, size } = gridOf(today, input.targets);
  const grid = Array.from({ length: size }, (_, i) => addDays(today, i - (size - 1)));
  const w = windowOf(today, windowDays);
  const g = { today, windowDays, grid, w, weekDays: grid.filter((d) => inWindow(d, w)) };
  const ctx = { today, exportedMs: Date.parse(exportedAt) };

  const rows = [];
  const add = rowMaker(rows);
  add('factory.days', 'figure', { value: size, text: String(size) });
  add('factory.today', 'text', { text: today });
  grid.forEach((day, i) => add(`factory.day.${i + 1}`, 'day', { rank: i + 1, text: day }));

  const prpr = intake(input.prpr, ctx);
  if (familyHeader(add, 'prpr', prpr, today)) prprRows(add, prpr, g);
  const landed = intake(input.prsLanded, ctx);
  if (familyHeader(add, 'prpr.prs.landed', landed, today, { firstDay: false })) prsRows(add, 'prpr.prs.landed', landed, g, 'PRs landed');
  const opened = intake(input.prsOpened, ctx);
  if (familyHeader(add, 'prpr.prs.opened', opened, today, { firstDay: false })) prsRows(add, 'prpr.prs.opened', opened, g, 'PRs opened');
  checkRow(add, landed, opened, g, input.prsCheck);
  const rev = intake(input.rev, ctx);
  if (familyHeader(add, 'rev', rev, today)) revRows(add, rev, g);
  const cr = intake(input.coderabbit, ctx);
  if (familyHeader(add, 'rev.coderabbit', cr, today)) coderabbitRows(add, cr, g, input.cap ?? null);
  const hand = intake(input.hand, { ...ctx, isHand: true });
  if (familyHeader(add, 'hand', hand, today)) handRows(add, hand, g);
  return rows;
}
