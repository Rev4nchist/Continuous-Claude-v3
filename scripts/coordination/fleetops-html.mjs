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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
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
const USAGE = 'usage: node fleetops-html.mjs <folder> --out <outdir> [--ids-root <root>] | --check <file> --stamp <exportedAt> [--ids-root <root>]';

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

let coreCache = null;
/** The pure functions of the page (the CORE block of the template), run in a vm. A test calls the real page code, not a copy. */
export function pageCore() {
  if (coreCache) return coreCache;
  const tpl = readFileSync(TEMPLATE_PATH, 'utf8');
  const from = tpl.indexOf('/*CORE-START*/');
  const to = tpl.indexOf('/*CORE-END*/');
  if (from < 0 || to < from) throw new Error('the template has no CORE block');
  const names = ['clockState', 'clockText', 'leaseState', 'pileParts', 'pileSubtitle', 'axisTicks', 'cstHM', 'cstZone', 'plural'];
  coreCache = vm.runInNewContext(`${tpl.slice(from, to)}\n({ ${names.join(', ')} })`, {});
  return coreCache;
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

export function renderHtml(view, rawJson = JSON.stringify(view)) {
  const parts = readFileSync(TEMPLATE_PATH, 'utf8').split(SLOT);
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
export function produce(files, ids, { build = buildView } = {}) {
  const view = embedView(build(files, ids));
  const bad = scanView(view, ids);
  if (bad) throw new Error(`${bad.msg} at ${bad.path}`);
  const rawJson = JSON.stringify(view);
  const html = renderHtml(view, rawJson);
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

function runRender(o, build, err) {
  if (existsSync(o.out)) for (const n of OUT_NAMES) rmSync(join(o.out, n), { force: true });
  const ids = readIdList(o.idsRoot);
  const { view, html, page, masked } = produce(loadFiles(o.dir), ids, { build });
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
  build: buildView, out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`), ...deps,
});

/** The offline CLI (render and --check). `deps` is injectable for a test: build (the view builder), out (stdout line), err (stderr line). Returns the exit code. */
export function main(argv, deps = {}) {
  const { build, out, err } = defaultDeps(deps);
  try {
    const o = parseArgs(argv);
    if (o.verify) throw usageError('--verify-upload needs the async entry');
    return o.check ? runCheck(o, out) : runRender(o, build, err);
  } catch (e) {
    err(`fleetops-html: ${e.message}${e.usage || argv.includes('--check') ? '' : '; nothing written'}`);
    return 1;
  }
}

/** The whole CLI, with the one networked mode (--verify-upload). The other modes go to main. */
export async function mainAsync(argv, deps = {}) {
  const { out, err } = defaultDeps(deps);
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`fleetops-html: ${e.message}`); return 1; }
  if (!o.verify) return main(argv, deps);
  try { return await runVerify(o, out); } catch (e) { err(`fleetops-html: ${e.message}`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) mainAsync(process.argv.slice(2)).then((code) => { process.exitCode = code; });
