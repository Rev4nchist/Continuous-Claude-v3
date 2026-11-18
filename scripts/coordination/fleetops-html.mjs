#!/usr/bin/env node
/**
 * fleetops-html -- renders the FleetOps HTML embed and the Notion page body from the 7 lane-dash export files (card coord-fleetops-notion).
 * Dave, 2026-11-17: FleetOps is a Notion page that hosts one self-contained HTML board (an embed) and the instructions to use and update it.
 * The fleetops-refresh skill runs this, uploads fleetops.html, binds the embed and replaces the page body with page.md.
 *
 * Usage:
 *   node scripts/coordination/fleetops-html.mjs <folder of the 7 .json files> --out <outdir> [--ids-root <repo root>]
 *     writes <outdir>/fleetops.html, page.md and manifest.json ({exportedAt, masked, htmlBytes, pageBytes, sha256Html, sha256Page}).
 *   node scripts/coordination/fleetops-html.mjs --check <file> --stamp <exportedAt> [--ids-root <repo root>]
 *     the read-back check of the skill: prints `check: listed N, stamp yes|no, embeds M, h2 K`; exit 0 only when N is 0, the stamp is there and M >= 1.
 *   node scripts/coordination/fleetops-html.mjs --verify-upload <url | @file> --manifest <manifest.json>
 *     (@file: the url is read from that file and the file is deleted, so a signed url never stands on a command line)
 *     the one NETWORKED mode: fetches the url (the signed download url of the uploaded file), compares its sha256 with sha256Html of the manifest and
 *     prints `verify-upload: sha ok|MISMATCH, bytes N`; exit 0 only on a match. The render and the check never touch the network.
 * Exit 1 and no output file at all: a usage error, a file missing or from another export, the id list absent, bad or empty, or a listed id left in
 * the display text. The old outputs are deleted first, the new ones are written to temp files and renamed at the end.
 *
 * The display-text gate (the seat rule: count listed ids on what the reader sees, not on the escaped source). Before anything is written:
 *   - the embed view (embedView: only what the page renders) is scanned leaf by leaf and pair by pair (two fields that the page puts side by side).
 *     A leaf is counted as it is, decoded, as "#leaf" and as "PR leaf"; a bidi control in any field is refused. A refusal names the field PATH
 *     (for example wip.rows[3].title) and never the value.
 *   - countListed runs on the raw view JSON, the whole html and page.md, each also decoded (\uXXXX and entities decoded, NFKC, invisible characters,
 *     backslashes and code spans removed).
 * maskListed cannot mask a string id such as "PRRC_x": the render REFUSES when one is left.
 */
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readIdList, countListed } from './board-mask.mjs';
import { buildView, INVISIBLE } from './fleetops-view.mjs';

export const FILE_IDS = Object.freeze(['lanes', 'tiles', 'assignments', 'projects', 'targets', 'meta', 'snapshots']);
export const OUT_NAMES = Object.freeze(['fleetops.html', 'page.md', 'manifest.json']);
export const EMBED_PLACEHOLDER = '{{FLEETOPS_EMBED}}';
export const MAX_HTML_BYTES = 150000;
const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(HERE, 'fleetops', 'page.template.html');
const SLOT = '__FLEETOPS_DATA__';
const RETIRED = Object.freeze(['claude.ai/artifact/', 'board_url', 'no_end', '{h}']);
const USAGE = 'usage: node fleetops-html.mjs <folder> --out <outdir> [--ids-root <root>] | --check <file> --stamp <exportedAt> [--ids-root <root>] | --lock-acquire <key> --session <sid8> [--force] [--dir <dir>] | --lock-release ok|failed --session <sid8> [--step <n>] [--dir <dir>] | --lock-rekey <key> --session <sid8> | --lock-touch --session <sid8>';

/** Reads the 7 files of `dir`. Throws when one is missing or when they come from more than one export. */
export function loadFiles(dir) {
  const read = (k) => {
    const text = readFileSync(join(dir, `${k}.json`), 'utf8');
    try { return JSON.parse(text); } catch { throw new Error(`${k}.json is not valid JSON`); }
  };
  const files = Object.fromEntries(FILE_IDS.map((k) => [k, read(k)]));
  for (const [k, f] of Object.entries(files)) if (typeof f?.exportedAt !== 'string' || f.exportedAt === '') throw new Error(`${k}.json has no exportedAt`);
  const stampOf = files.meta.exportedAt;
  for (const [k, f] of Object.entries(files)) if (f.exportedAt !== stampOf) throw new Error(`${k}.json is from another export`);
  return files;
}

/* ---------- the page code that a node test can run ---------- */

/**
 * The template text with LF line ends. `core.autocrlf` gives a Windows checkout a CRLF template; the page must be the same bytes on every
 * checkout, so the manifest `htmlBytes` and `sha256Html` equal an LF upload (R5).
 */
const readTemplate = (path) => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');

let coreCache = null;
/** The pure functions of the page (the CORE block of the template), run in a vm. A test calls the real page code, not a copy. `templatePath` is for a test; only the default is cached. */
export function pageCore(templatePath = TEMPLATE_PATH) {
  const isDefault = templatePath === TEMPLATE_PATH;
  if (isDefault && coreCache) return coreCache;
  const tpl = readTemplate(templatePath);
  const from = tpl.indexOf('/*CORE-START*/');
  const to = tpl.indexOf('/*CORE-END*/');
  if (from < 0 || to < from) throw new Error('the template has no CORE block');
  const names = ['clockState', 'clockText', 'leaseState', 'pileParts', 'pileSubtitle', 'axisTicks', 'cstHM', 'cstZone', 'plural'];
  const core = vm.runInNewContext(`${tpl.slice(from, to)}\n({ ${names.join(', ')} })`, {});
  if (isDefault) coreCache = core;
  return core;
}

export const axisTicks = (count, width, minGap) => Array.from(pageCore().axisTicks(count, width, minGap));

/* ---------- the display-text gate ---------- */

const NAMED = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', num: '#', Tab: '\t', NewLine: '\n', colon: ':', period: '.', comma: ',', semi: ';',
  lpar: '(', rpar: ')', excl: '!', lowbar: '_', hyphen: '-', dash: '-', commat: '@', percnt: '%', dollar: '$', sol: '/', bsol: '\\', lsqb: '[', rsqb: ']',
});
const fromCode = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

/** One round of decoding: \uXXXX and HTML entities (named ones from a table, unknown ones dropped). */
const decodeOnce = (s) => s
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#[xX]([0-9a-fA-F]{1,6});?/g, (_, h) => fromCode(parseInt(h, 16)))
  .replace(/&#(\d{1,7});?/g, (_, d) => fromCode(Number(d)))
  .replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, (_, n) => (Object.hasOwn(NAMED, n) ? NAMED[n] : ''));

/** Repeats `step` until the text stops changing (a double-encoded "&amp;#35;4242" needs two rounds). */
function untilStable(text, step) {
  let s = String(text ?? '');
  for (let round = 0; round < 6; round += 1) {
    const next = step(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

/** The text with its escapes and entities decoded and nothing else removed: a bidi control written as &#x202e; shows here. */
export const decodeEscapes = (text) => untilStable(text, decodeOnce);

/**
 * The text as a reader sees it: escapes and entities decoded, NFKC (a fullwidth "#\uff14\uff12\uff14\uff12" becomes "#4242"), every invisible character removed
 * (Default_Ignorable_Code_Point and the bidi controls), then backslashes and code-span ticks removed.
 */
export const decodeDisplay = (text) => untilStable(text, (s) => decodeOnce(s).normalize('NFKC').replace(INVISIBLE, '').replace(/[\\`]/g, ''));

const BIDI = new RegExp('[\\u202a-\\u202e\\u2066-\\u2069]');

/** The most listed ids that any one of the texts holds, raw or decoded. A number only: an id never leaves this function. */
const leftIn = (texts, ids) => Math.max(0, ...texts.map((t) => countListed(t, ids)));

/* ---------- the html ---------- */

/** JSON that is safe inside a script block: < > & and the two line separators are written as \uXXXX (still valid JSON). */
const scriptJson = (json) => json.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function renderHtml(view, rawJson = JSON.stringify(view), templatePath = TEMPLATE_PATH) {
  const parts = readTemplate(templatePath).split(SLOT);
  if (parts.length !== 2) throw new Error('the template must hold exactly one data slot');
  return `${parts[0]}${scriptJson(rawJson)}${parts[1]}`;
}

/* ---------- page.md (Notion markdown: a summary above the embed, the how-to below) ---------- */

const esc = (s) => String(s ?? '').replace(/[\\*_~`[\]$<>&|]/g, '\\$&');
const callout = (icon, color, body) => `<callout icon="${icon}" color="${color}">\n${body}\n</callout>`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const signed = (n) => (n > 0 ? `+${n}` : String(n));

function headline(v) {
  const p = v.pile;
  const asks = `${plural(v.asks.total, 'lane waits', 'lanes wait')} on you`;
  if (!p) return `**${asks}.**`;
  const move = p.change === 0 ? 'did not change' : `${p.change < 0 ? 'shrank' : 'grew'} by ${Math.abs(p.change)}`;
  return `**${asks}, and the pile ${move} in ${p.span} days.**`;
}

function summaryColumns(v) {
  const p = v.pile;
  const peak = !p ? 'too few snapshots' : p.sincePeak < 0 ? `${p.sincePeak} since the peak` : 'at the peak';
  const cards = [
    ['🙋', 'orange_bg', `<b>${v.asks.total}</b> wait on you<br />${v.asks.over} over a week`],
    ['📈', 'gray_bg', `<b>${p ? signed(p.change) : '–'}</b> open lanes${p ? `, ${p.span} d` : ''}<br />${esc(peak)}`],
    ['💤', 'gray_bg', `<b>${v.never.total}</b> of ${v.never.open} never started<br />${v.never.old} at 7 d or more`],
    ['⚙️', v.wip.lapsed ? 'red_bg' : 'green_bg', `<b>${v.wip.lapsed}</b> lapsed ${v.wip.lapsed === 1 ? 'lease' : 'leases'}<br />${v.wip.live} held`],
  ];
  return `<columns>\n${cards.map(([i, c, b]) => `<column>\n${callout(i, c, b)}\n</column>`).join('\n')}\n</columns>`;
}

const HOW_TO = [
  '- **What it shows.** The asks that wait on you, the open pile, lanes never started, work in progress and each project.',
  '- **On the phone.** Tap the file card above to open the board full screen.',
  '- **On the desktop.** The board sits in a frame. Drag the frame taller to see more. A refresh resets the height.',
  '- **To update.** Say "refresh FleetOps" in any Claude Code session, on either account. Both accounts follow the same skill.',
  '- **Do not edit this page by hand.** A refresh replaces the whole page.',
  '- **Ids are masked.** A lane id on the listed-id list shows as masked-id.',
];

/** The Notion page body. It holds numbers and times only, no lane text. The skill swaps the placeholder line for the embed tag. */
export function renderPageMd(view) {
  return [
    callout('🕒', 'gray_bg', `Data from ${esc(view.dataFrom)}. Goes stale ${esc(view.staleAt)}. Export ${view.exportedAt}.`),
    headline(view),
    summaryColumns(view),
    '## 📊 FleetOps live board',
    EMBED_PLACEHOLDER,
    '## 📘 How to use and update',
    HOW_TO.join('\n'),
  ].join('\n\n') + '\n';
}

/* ---------- produce: the view, both files, the gate ---------- */

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const askRowOf = (r) => pick(r, ['title', 'id', 'project', 'band', 'state', 'p0', 'age']);

/**
 * The part of the view that reaches the embed: exactly what the template renders (a test ties the keys to the template). The ask dates, the daily
 * rows, the sparkline text, the bar widths and the titles and ids of unheld P0 lanes stay out: the less text goes into the page, the less can leak.
 */
export function embedView(v) {
  return {
    exportedAt: v.exportedAt, dataFrom: v.dataFrom, staleAtMs: v.staleAtMs, staleAt: v.staleAt, masked: v.masked, openCount: v.openCount,
    asks: {
      total: v.asks.total, over: v.asks.over, blockedNoAsk: v.asks.blockedNoAsk,
      main: v.asks.main.map(askRowOf), folds: v.asks.folds.map((f) => ({ name: f.name, oldest: f.oldest, rows: f.rows.map(askRowOf) })), other: v.asks.other.map(askRowOf),
    },
    pile: v.pile && { ...pick(v.pile, ['change', 'span', 'from', 'to', 'min', 'max', 'sincePeak', 'first', 'last', 'partialDay']), days: v.pile.days.map((d) => pick(d, ['label', 'open', 'change'])) },
    never: { total: v.never.total, open: v.never.open, old: v.never.old, buckets: v.never.buckets.map((b) => pick(b, ['label', 'count', 'old'])), top: v.never.top.map((t) => pick(t, ['name', 'count'])) },
    wip: { live: v.wip.live, lapsed: v.wip.lapsed, rows: v.wip.rows.map((r) => pick(r, ['title', 'id', 'project', 'goal', 'holder', 'state', 'lapsed', 'leaseAt', 'lapsedOn', 'lapsedDays'])) },
    p0: { open: v.p0.open, cap: v.p0.cap, unheldCount: v.p0.unheld.length },
    projects: v.projects.map((p) => pick(p, ['name', 'state', 'decision', 'ended'])),
  };
}

/** Every string of a value with its path (wip.rows[3].title). */
function* leaves(v, path = '') {
  if (typeof v === 'string') yield [path, v];
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i += 1) yield* leaves(v[i], `${path}[${i}]`);
  else if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) yield* leaves(v[k], path ? `${path}.${k}` : k);
}

/** Every object of a value with its path. */
function* objects(v, path = '') {
  if (Array.isArray(v)) for (let i = 0; i < v.length; i += 1) yield* objects(v[i], `${path}[${i}]`);
  else if (v !== null && typeof v === 'object') {
    yield [path, v];
    for (const k of Object.keys(v)) yield* objects(v[k], path ? `${path}.${k}` : k);
  }
}

/** The text fields that the page puts side by side in one row (project next to id, state next to band, ...). */
const ADJACENT = Object.freeze(['title', 'goal', 'band', 'state', 'project', 'holder', 'id', 'name']);
const listedIn = (text, ids) => countListed(text, ids) > 0;

/**
 * The first problem in the embed view, as { msg, path }, or null. Never holds a value. A leaf is counted as it is, decoded, as "#leaf" and as
 * "PR leaf" (the page may put a context word before it); two adjacent fields of one object are counted joined by a space, in both orders.
 */
export function scanView(ev, ids) {
  for (const [path, s] of leaves(ev)) {
    if (BIDI.test(decodeEscapes(s))) return { msg: 'the view holds a bidi control', path };
    const shown = decodeDisplay(s);
    if (RETIRED.some((r) => shown.includes(r))) return { msg: 'the view holds a forbidden string', path };
    if ([s, shown, `#${shown}`, `PR ${shown}`].some((t) => listedIn(t, ids))) return { msg: 'a listed id is left in the display text', path };
  }
  for (const [path, o] of objects(ev)) {
    const keys = ADJACENT.filter((k) => typeof o[k] === 'string');
    for (const a of keys) {
      for (const b of keys) if (a !== b && listedIn(decodeDisplay(`${o[a]} ${o[b]}`), ids)) return { msg: 'a listed id is left in the display text', path: `${path}.${a}+${b}` };
    }
  }
  return null;
}

/**
 * Builds the embed view and both outputs, then runs the display-text gate. Throws (a field path, never a value) on a retired string, a bidi control,
 * a listed id left in the display text, or an html over the size limit. `build` is injectable for a test (buildView with an empty list is the
 * unmasked case).
 */
export function produce(files, ids, { build = buildView, template = TEMPLATE_PATH } = {}) {
  const view = embedView(build(files, ids));
  const bad = scanView(view, ids);
  if (bad) throw new Error(`${bad.msg} at ${bad.path}`);
  const rawJson = JSON.stringify(view);
  const html = renderHtml(view, rawJson, template);
  const page = renderPageMd(view);
  if (leftIn([rawJson, decodeDisplay(rawJson), html, decodeDisplay(html)], ids) > 0) throw new Error('a listed id is left in the display text of the html');
  if (leftIn([page, decodeDisplay(page)], ids) > 0) throw new Error('a listed id is left in the display text of page.md');
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error(`the html is over ${MAX_HTML_BYTES} bytes`);
  return { view, html, page, masked: view.masked };
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

/* ---------- the read-back check ---------- */

/** The check of a fetched Notion page: listed ids (raw or decoded), the stamp, embed lines and h2 lines. */
export function checkText(text, stamp, ids) {
  const decoded = decodeDisplay(text);
  const lines = String(text).split(/\r?\n/);
  const r = {
    listed: leftIn([text, decoded], ids), stamp: decoded.includes(stamp),
    embeds: lines.filter((l) => l.startsWith('<embed ')).length, h2: lines.filter((l) => /^##\s/.test(l)).length,
  };
  r.ok = r.listed === 0 && r.stamp && r.embeds >= 1 && r.h2 === 2;
  r.line = `check: listed ${r.listed}, stamp ${r.stamp ? 'yes' : 'no'}, embeds ${r.embeds}, h2 ${r.h2}`;
  return r;
}

/* ---------- the publication lock (one writer for the FleetOps page) ---------- */

/**
 * Files in the lane-dash state dir (LANE_DASH_STATE_DIR, else ~/.claude/state/lane-dash):
 *   publish.lock      {session, key, at}   the lock; its holder is the one session that writes the page
 *   publish.json      {state: writing|failed|ok, session, key, at, step?, lastOkAt?}   read by the Stop-gate hook (lane-dash-refresh.ts, failed only); no pid.
 *                     lastOkAt is the time of the last ok refresh; writing and a failed release carry it, so a forced run cannot erase the hour limit.
 *   publish.takeover  {session, at}        a mutex for a takeover, a rekey and a touch; dead after 10 seconds
 * Acquire is an exclusive create (flag wx). A lock over 20 minutes old counts as dead. The takeover holds the mutex, reads the lock a third time,
 * and renames the STALE file to a name only this taker uses (publish.lock.taken.<session>). A taken file that is not the stale one goes back with a
 * link that never overwrites; when the lock path is taken again the copy stays on disk and the exit is 3 with a conflict line.
 * One refresh an hour: a release ok leaves publish.json with state ok. An acquire exits 4 while the last ok is under 60 minutes old.
 * A failed export is not retried: an acquire on the key of a failed publish.json exits 5. `--force` skips exits 4 and 5 only (never a live lock).
 * A rekey (a restart on a newer export) and a touch (a keep-alive) are for the holder only.
 * Exit codes: 0 ok, 1 usage or an I/O error, 3 refused (another session holds the lock, or this session does not), 4 last refresh under an hour ago,
 * 5 this export key already failed.
 */
export const LOCK_STALE_MS = 20 * 60 * 1000;
export const REFRESH_EVERY_MS = 60 * 60 * 1000;
export const MUTEX_STALE_MS = 10 * 1000;
export const LOCK_FILE = 'publish.lock';
export const PUBLISH_FILE = 'publish.json';
export const MUTEX_FILE = 'publish.takeover';
const SESSION_RE = /^[0-9a-f]{8}$/;
const LOCK_KEY_RE = /^[A-Za-z0-9:.+_-]{1,64}$/;
const STEP_RE = /^\d{1,2}(\.\d{1,2})?$/;

export function laneDashDir(env = process.env) {
  if (env.LANE_DASH_STATE_DIR) return env.LANE_DASH_STATE_DIR;
  return join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'lane-dash');
}

const readText = (p) => {
  try { return readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const parseLock = (raw) => {
  try { const o = JSON.parse(raw); return o !== null && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
};
/** The session of a lock text, for a message: eight hex characters or "unknown". Nothing else from the file is printed. */
const holderOf = (raw) => { const s = parseLock(raw)?.session; return typeof s === 'string' && SESSION_RE.test(s) ? s : 'unknown'; };
const isoAt = (now) => new Date(now).toISOString();
const refused = (holder) => ({ code: 3, msg: `fleetops-html: another session writes the page (holder ${holder}). Stop and report. Write no failed state.` });
const notHolder = (session) => ({ code: 3, msg: `fleetops-html: session ${session} does not hold the lock. Nothing changed.` });

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** renameSync that retries on EPERM, EBUSY and EACCES (a scanner or an editor holds the file on Windows): 5 attempts, 50 ms apart. Other errors, ENOENT included, go up at once. */
export function renameRetry(from, to, { rename = renameSync, sleep = sleepSync } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { rename(from, to); return; } catch (e) {
      if (!RETRY_CODES.has(e.code) || attempt >= 5) throw e;
      sleep(50);
    }
  }
}

/** Stale = older than `limit` by `at`; a file with no usable `at` (empty, half written, corrupt) is judged by its mtime. A future time is live. */
function lockIsStale(raw, mtimeMs, now, limit = LOCK_STALE_MS) {
  const at = Date.parse(parseLock(raw)?.at);
  return now - (Number.isNaN(at) ? mtimeMs : at) > limit;
}

/** Atomic write of publish.json: a temp file, then a rename. */
function writePublish(dir, session, record) {
  const tmp = join(dir, `${PUBLISH_FILE}.${session}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    renameRetry(tmp, join(dir, PUBLISH_FILE));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** publish.json as an object; null for a missing, unreadable or corrupt file. */
function readPublish(dir) {
  try { const raw = readText(join(dir, PUBLISH_FILE)); return raw === null ? null : parseLock(raw); } catch { return null; }
}

/** The time (ms) of the last ok refresh in a publish.json record: lastOkAt, else the time of an ok record; null when unknown. */
function lastOkMs(rec) {
  const t = Date.parse(rec?.lastOkAt);
  if (!Number.isNaN(t)) return t;
  const a = rec?.state === 'ok' ? Date.parse(rec.at) : NaN;
  return Number.isNaN(a) ? null : a;
}
const withLastOk = (record, okMs) => (okMs === null ? record : { ...record, lastOkAt: isoAt(okMs) });

/** "14:00 CST" in America/Chicago (CST or CDT by the date), 24-hour clock. */
function clockChicago(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(new Date(ms));
  const p = (t) => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('hour')}:${p('minute')} ${p('timeZoneName')}`;
}

/**
 * Why an acquire must not start, as { code, msg }, or null. Code 4: the last ok refresh is under an hour old (a bad or future time does not block).
 * Code 5: publish.json says this export key already failed. Run before the lock is made and again right after, so a refresh that ended in between is caught.
 */
function acquireRefusal(dir, key, now) {
  const rec = readPublish(dir);
  const ok = lastOkMs(rec);
  if (ok !== null && now - ok >= 0 && now - ok < REFRESH_EVERY_MS) return { code: 4, msg: `fleetops-html: last refresh at ${clockChicago(ok)}, under 1 hour ago` };
  if (rec?.state === 'failed' && rec.key === key) {
    const at = Date.parse(rec.at);
    const when = Number.isNaN(at) ? '' : ` at ${clockChicago(at)}`;
    const step = typeof rec.step === 'string' && STEP_RE.test(rec.step) ? ` (step ${rec.step})` : '';
    return { code: 5, msg: `fleetops-html: this export already failed${when}${step}. Do not retry until a new export. Skip the run.` };
  }
  return null;
}

/**
 * The state of the lock: { state: 'free' } | { state: 'live', holder } | { state: 'stale', raw, holder }.
 * A stale verdict needs two reads with equal text. `hooks.betweenReads` runs between them (a test changes the lock there).
 */
export function lockSnapshot(dir, now = Date.now(), hooks = {}) {
  const file = join(dir, LOCK_FILE);
  let raw1;
  let mtime;
  try { raw1 = readFileSync(file, 'utf8'); mtime = statSync(file).mtimeMs; } catch (e) { if (e.code === 'ENOENT') return { state: 'free' }; throw e; }
  const holder = holderOf(raw1);
  if (!lockIsStale(raw1, mtime, now)) return { state: 'live', holder };
  if (hooks.betweenReads) hooks.betweenReads();
  const raw2 = readText(file);
  if (raw2 === null) return { state: 'free' };
  return raw2 === raw1 ? { state: 'stale', raw: raw1, holder } : { state: 'live', holder: holderOf(raw2) };
}

/* ---- the takeover mutex ---- */

/**
 * Creates publish.takeover (wx). A mutex over 10 seconds old is dead: it is removed once two reads agree, then the create is tried again.
 * `waitMs` > 0 polls every 50 ms for a live mutex. Returns true when this call holds the mutex.
 */
function takeMutex(dir, who, waitMs) {
  const file = join(dir, MUTEX_FILE);
  const deadline = Date.now() + waitMs;
  for (let tries = 0; tries < 200; tries += 1) {
    try { writeFileSync(file, JSON.stringify({ session: who.session, at: isoAt(who.now) }), { flag: 'wx' }); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let raw;
    let mtime = 0;
    try { raw = readFileSync(file, 'utf8'); mtime = statSync(file).mtimeMs; } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (lockIsStale(raw, mtime, who.now, MUTEX_STALE_MS) && readText(file) === raw) { rmSync(file, { force: true }); continue; }
    if (Date.now() >= deadline) return false;
    sleepSync(50);
  }
  return false;
}

/** Runs `fn` while this call holds the mutex; the mutex is removed in a finally. `busy` is the result when the mutex is held by another session. */
function withMutex(dir, who, waitMs, fn, busy) {
  if (!takeMutex(dir, who, waitMs)) return busy;
  try { return fn(); } finally { rmSync(join(dir, MUTEX_FILE), { force: true }); }
}

/* ---- create, take over, release ---- */

const newLock = (dir, { key, session, now }) => writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ session, key, at: isoAt(now) }), { flag: 'wx' });
const writing = (dir, { key, session, now }) => writePublish(dir, session, withLastOk({ state: 'writing', session, key, at: isoAt(now) }, lastOkMs(readPublish(dir))));

/**
 * Makes the lock and the writing record. Returns null when the lock exists (EEXIST), else { code, msg }.
 * Right after the create the refusal check runs again (code 4 or 5 removes the new lock). A write failure removes the lock and gives code 1.
 */
function createLock(dir, who, hooks, okMsg) {
  try { newLock(dir, who); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  try {
    if (hooks.afterNewLock) hooks.afterNewLock();
    const again = who.force ? null : acquireRefusal(dir, who.key, who.now);
    if (again) { rmSync(join(dir, LOCK_FILE), { force: true }); return again; }
    if (hooks.beforeWriting) hooks.beforeWriting();
    writing(dir, who);
  } catch (e) {
    rmSync(join(dir, LOCK_FILE), { force: true });
    return { code: 1, msg: `fleetops-html: could not write publish.json (${typeof e.code === 'string' ? e.code : 'error'}); the lock was removed. Stop and report.` };
  }
  return { code: 0, msg: okMsg };
}

/** Puts a taken file back as the lock without overwriting. When the lock path is taken again, the copy stays on disk and the exit is 3 with a conflict line. */
function putBack(file, taken) {
  try { linkSync(taken, file); } catch (e) {
    if (e.code === 'EEXIST') return { code: 3, msg: `fleetops-html: lock conflict: a fresh lock was moved aside and the lock path is taken again. The copy stays as ${basename(taken)}. Stop and report. Write no failed state.` };
    throw e;
  }
  rmSync(taken, { force: true });
  return refused(holderOf(readText(file) ?? ''));
}

function takeUnderMutex(dir, snap, who, hooks) {
  const file = join(dir, LOCK_FILE);
  const taken = join(dir, `${LOCK_FILE}.taken.${who.session}`);
  if (hooks.afterMutex) hooks.afterMutex();
  const cur = readText(file);
  if (cur !== null && cur !== snap.raw) return refused(holderOf(cur));
  if (cur !== null) {
    if (hooks.beforeRename) hooks.beforeRename();
    try { renameRetry(file, taken); } catch (e) {
      if (e.code === 'ENOENT') return { code: 3, msg: 'fleetops-html: another session took the stale lock first. Stop and report. Write no failed state.' };
      throw e;
    }
    if (hooks.afterRename) hooks.afterRename();
    if (readText(taken) !== snap.raw) return putBack(file, taken);
    rmSync(taken, { force: true });
  }
  const made = createLock(dir, who, hooks, `fleetops-html: lock taken over from a dead holder (${snap.holder}, over 20 minutes old); session ${who.session} writes now`);
  return made ?? refused(holderOf(readText(file) ?? ''));
}

/**
 * Takes over the stale lock of `snap`, under the takeover mutex. `hooks` (for a test): afterMutex, beforeRename, afterRename, afterNewLock, beforeWriting.
 * ENOENT on the rename: another taker won. A taken file that differs from the stale read is a fresh lock of another session: it goes back (see putBack).
 */
export function lockTake(dir, snap, who, hooks = {}) {
  const busy = { code: 3, msg: 'fleetops-html: another session is taking over the lock now. Stop and report. Write no failed state.' };
  return withMutex(dir, who, 0, () => takeUnderMutex(dir, snap, who, hooks), busy);
}

/**
 * Acquire: exclusive create; on EEXIST a live lock refuses, a stale one is taken over. Returns { code, msg }.
 * Code 4: the last ok refresh is under an hour old (Dave's limit: one refresh an hour on this machine). Code 5: this export key already failed.
 * `force` skips codes 4 and 5 only.
 */
export function lockAcquire({ dir, key, session, now = Date.now(), force = false }, hooks = {}) {
  mkdirSync(dir, { recursive: true });
  const who = { key, session, now, force };
  const first = force ? null : acquireRefusal(dir, key, now);
  if (first) return first;
  for (let i = 0; i < 3; i += 1) {
    const made = createLock(dir, who, hooks, `fleetops-html: lock acquired by ${session}`);
    if (made !== null) return made;
    const snap = lockSnapshot(dir, now, hooks);
    if (snap.state === 'live') return refused(snap.holder);
    if (snap.state === 'stale') return lockTake(dir, snap, who, hooks);
  }
  return refused('unknown');
}

/**
 * Release: only the holder. `ok` writes publish.json state ok with lastOkAt = now (the hour limit reads it; the hook ignores any state but failed);
 * `failed` writes publish.json state failed (the key and the step; lastOkAt carried). The lock is removed in a finally, also when the write fails.
 */
export function lockRelease({ dir, session, outcome, step = null, now = Date.now() }) {
  const file = join(dir, LOCK_FILE);
  const raw = readText(file);
  const lock = raw === null ? null : parseLock(raw);
  if (!lock || lock.session !== session) return notHolder(session);
  try {
    const rec = outcome === 'failed'
      ? withLastOk({ state: 'failed', session, key: lock.key, at: isoAt(now), ...(step ? { step } : {}) }, lastOkMs(readPublish(dir)))
      : { state: 'ok', session, key: lock.key, at: isoAt(now), lastOkAt: isoAt(now) };
    writePublish(dir, session, rec);
  } finally {
    rmSync(file, { force: true });
  }
  return { code: 0, msg: `fleetops-html: lock released (${outcome})` };
}

/** The holder rewrites its lock (a new key, a new time) under the mutex, so a takeover cannot interleave. */
function rewriteHolder({ dir, session, key, now }, done) {
  const file = join(dir, LOCK_FILE);
  const busy = { code: 3, msg: 'fleetops-html: the lock is busy (a takeover runs). Nothing changed. Stop and report.' };
  return withMutex(dir, { session, now }, 1000, () => {
    const raw = readText(file);
    const lock = raw === null ? null : parseLock(raw);
    if (!lock || lock.session !== session) return notHolder(session);
    const newKey = key ?? lock.key;
    const tmp = join(dir, `${LOCK_FILE}.${session}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify({ session, key: newKey, at: isoAt(now) }));
      renameRetry(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    if (key !== null) writePublish(dir, session, withLastOk({ state: 'writing', session, key, at: isoAt(now) }, lastOkMs(readPublish(dir))));
    return { code: 0, msg: done };
  }, busy);
}

/** Restart on a newer export: the holder keeps the lock, sets the new key and a new time. Only the holder may run it. */
export const lockRekey = ({ dir, session, key, now = Date.now() }) => rewriteHolder({ dir, session, key, now }, `fleetops-html: lock rekeyed to ${key}`);

/** Keep-alive: the holder sets a new time on its lock. Only the holder may run it. */
export const lockTouch = ({ dir, session, now = Date.now() }) => rewriteHolder({ dir, session, key: null, now }, 'fleetops-html: lock touched');

const LOCK_VERBS = Object.freeze(['--lock-acquire', '--lock-release', '--lock-rekey', '--lock-touch']);
const isLockArgv = (argv) => argv.some((a) => LOCK_VERBS.includes(a));

function parseLockArgs(argv) {
  const o = { verb: null, arg: null, session: null, step: null, dir: null, force: false };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw usageError(`${flag} needs a value`);
    return v;
  };
  const verb = (a, v) => {
    if (o.verb !== null) throw usageError('one lock verb only');
    o.verb = a;
    o.arg = v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--lock-acquire' || a === '--lock-release' || a === '--lock-rekey') verb(a, value(++i, a));
    else if (a === '--lock-touch') verb(a, null);
    else if (a === '--session') o.session = value(++i, a);
    else if (a === '--step') o.step = value(++i, a);
    else if (a === '--dir') o.dir = value(++i, a);
    else if (a === '--force') o.force = true;
    else throw usageError(`unknown argument ${a.startsWith('--') ? a : 'in a lock command'}`);
  }
  if (o.session === null || !SESSION_RE.test(o.session)) throw usageError('--session must be 8 lowercase hex characters');
  if (o.force && o.verb !== '--lock-acquire') throw usageError('--force goes with --lock-acquire');
  if (o.verb === '--lock-acquire' || o.verb === '--lock-rekey') {
    if (!LOCK_KEY_RE.test(o.arg)) throw usageError('the key must be 1 to 64 characters of letters, digits and : . + _ -');
  } else if (o.verb === '--lock-release' && o.arg !== 'ok' && o.arg !== 'failed') throw usageError('--lock-release takes ok or failed');
  if (o.step !== null && (o.verb !== '--lock-release' || o.arg !== 'failed' || !STEP_RE.test(o.step))) throw usageError('--step is a step number such as 7 or 7.3, with --lock-release failed');
  return o;
}

/** The lock verbs. A refusal (exit 3, 4 or 5) prints one line and no "nothing written" suffix. */
function runLockCli(argv, { out, err, env, now }) {
  try {
    const o = parseLockArgs(argv);
    const dir = o.dir ?? laneDashDir(env);
    const base = { dir, session: o.session, now: now() };
    let r;
    if (o.verb === '--lock-acquire') r = lockAcquire({ ...base, key: o.arg, force: o.force });
    else if (o.verb === '--lock-rekey') r = lockRekey({ ...base, key: o.arg });
    else if (o.verb === '--lock-touch') r = lockTouch(base);
    else r = lockRelease({ ...base, outcome: o.arg, step: o.step });
    (r.code === 0 ? out : err)(r.msg);
    return r.code;
  } catch (e) {
    err(`fleetops-html: ${e.message}`);
    return 1;
  }
}

/* ---------- CLI ---------- */

function usageError(why) {
  const e = new Error(`${USAGE} (${why})`);
  e.usage = true;
  return e;
}

const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const MAX_DOWNLOAD_BYTES = 2000000;

function parseArgs(argv) {
  const o = { dir: null, out: null, check: null, stamp: null, verify: null, manifest: null, idsRoot: resolve(HERE, '..', '..') };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw usageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') o.out = value(++i, a);
    else if (a === '--ids-root') o.idsRoot = resolve(value(++i, a));
    else if (a === '--check') o.check = value(++i, a);
    else if (a === '--stamp') o.stamp = value(++i, a);
    else if (a === '--verify-upload') o.verify = value(++i, a);
    else if (a === '--manifest') o.manifest = value(++i, a);
    else if (a.startsWith('--')) throw usageError(`unknown flag ${a}`);
    else if (!o.dir) o.dir = a;
    else throw usageError('one folder only');
  }
  if (o.verify) {
    if (!o.manifest || o.dir || o.out || o.check || o.stamp) throw usageError('--verify-upload takes a url and --manifest only');
    if (!/^https?:\/\//i.test(o.verify) && !/^@./.test(o.verify)) throw usageError('the url must be http or https, or @<file that holds it>');
  } else if (o.manifest) throw usageError('--manifest goes with --verify-upload');
  else if (o.check) {
    if (!o.stamp || o.dir || o.out) throw usageError('--check takes a file and --stamp only');
    if (!ISO_STAMP.test(o.stamp)) throw usageError('--stamp must be an ISO time such as 2026-11-17T17:30:02.680Z');
  } else if (!o.dir || !o.out) throw usageError('a folder and --out are required');
  return o;
}

function writeAtomic(outDir, contents) {
  mkdirSync(outDir, { recursive: true });
  const temps = OUT_NAMES.map((n) => join(outDir, `.${n}.${process.pid}.tmp`));
  try {
    OUT_NAMES.forEach((n, i) => writeFileSync(temps[i], contents[n]));
    OUT_NAMES.forEach((n, i) => renameSync(temps[i], join(outDir, n)));
  } catch (err) {
    for (const p of [...temps, ...OUT_NAMES.map((n) => join(outDir, n))]) rmSync(p, { force: true });
    throw err;
  }
}

function runRender(o, build, template, err) {
  if (existsSync(o.out)) for (const n of OUT_NAMES) rmSync(join(o.out, n), { force: true });
  const ids = readIdList(o.idsRoot);
  const { view, html, page, masked } = produce(loadFiles(o.dir), ids, { build, template });
  const manifest = { exportedAt: view.exportedAt, masked, htmlBytes: Buffer.byteLength(html), pageBytes: Buffer.byteLength(page), sha256Html: sha(html), sha256Page: sha(page) };
  writeAtomic(o.out, { 'fleetops.html': html, 'page.md': page, 'manifest.json': `${JSON.stringify(manifest, null, 2)}\n` });
  err(`fleetops-html: masked ${masked} listed id(s), html ${manifest.htmlBytes} bytes, page ${manifest.pageBytes} bytes, listed ids left 0`);
  return 0;
}

function runCheck(o, out) {
  let text;
  try { text = readFileSync(o.check, 'utf8'); } catch { throw new Error('the file to check could not be read'); }
  const r = checkText(text, o.stamp, readIdList(o.idsRoot));
  out(r.line);
  return r.ok ? 0 : 1;
}

/**
 * The url to verify. `@<path>` reads it from a file and deletes the file, so a signed url (it carries a token) never stands on a
 * command line or stays on disk. A plain value is used as the url (tests on 127.0.0.1).
 */
function urlOf(arg) {
  if (!arg.startsWith('@')) return arg;
  const path = arg.slice(1);
  let url;
  try { url = readFileSync(path, 'utf8').trim(); } catch { throw new Error('the url file could not be read'); }
  try { rmSync(path, { force: true }); } catch { /* the url expires in minutes; a left file is not a hard error */ }
  if (!/^https?:\/\//.test(url)) throw new Error('the url file holds no http url');
  return url;
}

/** The upload check: the bytes of the url against sha256Html of the manifest. No url or answer text goes into a message. */
async function runVerify(o, out) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(o.manifest, 'utf8')); } catch { throw new Error('the manifest could not be read'); }
  const want = manifest?.sha256Html;
  if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want)) throw new Error('the manifest has no sha256Html');
  const url = urlOf(o.verify);
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(30000) }); } catch { throw new Error('the url could not be fetched'); }
  if (!res.ok) throw new Error(`the url answered http ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) throw new Error('the download is over 2 MB');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('the download is over 2 MB');
  const match = sha(bytes) === want;
  out(`verify-upload: ${match ? 'sha ok' : 'MISMATCH'}, bytes ${bytes.length}`);
  return match ? 0 : 1;
}

const defaultDeps = (deps) => ({
  build: buildView, template: TEMPLATE_PATH, env: process.env, now: () => Date.now(), out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`), ...deps,
});

/** The offline CLI (render and --check). `deps` is injectable for a test: build (the view builder), out (stdout line), err (stderr line). Returns the exit code. */
export function main(argv, deps = {}) {
  const d = defaultDeps(deps);
  const { build, template, out, err } = d;
  if (isLockArgv(argv)) return runLockCli(argv, d);
  try {
    const o = parseArgs(argv);
    if (o.verify) throw usageError('--verify-upload needs the async entry');
    return o.check ? runCheck(o, out) : runRender(o, build, template, err);
  } catch (e) {
    err(`fleetops-html: ${e.message}${e.usage || argv.includes('--check') ? '' : '; nothing written'}`);
    return 1;
  }
}

/** The whole CLI, with the one networked mode (--verify-upload). The other modes go to main. */
export async function mainAsync(argv, deps = {}) {
  const { out, err } = defaultDeps(deps);
  if (isLockArgv(argv)) return main(argv, deps);
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`fleetops-html: ${e.message}`); return 1; }
  if (!o.verify) return main(argv, deps);
  try { return await runVerify(o, out); } catch (e) { err(`fleetops-html: ${e.message}`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) mainAsync(process.argv.slice(2)).then((code) => { process.exitCode = code; });
