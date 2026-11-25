/**
 * board-mask -- the listed-id mask of the lane board page (card coord-board-mask-listed-ids).
 *
 * A published lane page must carry no listed id (an id of the review-engine answer key). The hook holdout-scan counts them in the first 1 MiB of
 * a publish; this module masks them in the WHOLE page before render-board.mjs writes it, so a later lane note cannot put one back.
 *
 * Source of the list: the same files and the same matcher as the warn hook: the dataset and the eval config (the holdout ids) and the tracked gold
 * folder (the gold ids: card coord-content-scan-followups, item gold ids). The matcher is scripts/github/lib/holdout-ids.mjs (imported, not
 * copied). The file and folder names are repeated here (the hook readers are TypeScript: shared/holdout-ids.ts and shared/gold-ids.ts) and tests
 * tie them to the hook text. The sha-prefix rule of the
 * hook (holdout-scan.ts countHits) is repeated in shaHit below and a test ties it to the hook text too.
 *
 * Card coord-board-mask-ids: render-board masks every lane text at the SOURCE (maskLaneRows, right after the DB read, before any escape, JSON or
 * cut), and finishPage stays the belt. Renderer rule: count listed ids on the display text (entities decoded, JSON strings parsed, fullwidth
 * and zero-width forms folded), not only on the escaped source; any count fails closed.
 *
 * Nothing here prints, returns in a message or logs an id. A caller gets counts (masked, left, bytes) and fixed texts. The token holds no digit and
 * no hex run, so the matcher never counts it, and it stays valid inside JSON strings, HTML attributes and link paths.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGoldShape, countIdsIn, holdoutIdsOf } from '../github/lib/holdout-ids.mjs';

export const DATASET_REL = '.claudedocs/2026-11-01-pr-review-dataset.json';
export const EVAL_CONFIG_REL = 'scripts/eval/review-eval/config.json';
/** The tracked gold answer keys and the one json file of that folder with no rows (the hook repeats both: .claude/hooks/src/shared/gold-ids.ts; a test ties them). */
export const GOLD_DIR_REL = 'scripts/eval/review-eval/gold';
export const GOLD_NON_ROW_FILES = Object.freeze(['escape-baseline.json']);
export const TOKEN = 'masked-id';

const MSG_BAD = 'the listed id list could not be read';
const MSG_ABSENT = 'the listed id list is absent';
const MSG_EMPTY = 'the listed id list is empty';
const LINE_NO_PAGE = 'render-board: the listed-id list could not be read; no page written';
const LINE_LEFT = 'render-board: a listed id is left after the mask; no page written';
const LINE_NOTE = 'render-board: note: this board has no listed-id list; the page is not masked';

const LINE_JSON = 'render-board: a JSON data block of the page does not parse; no page written';

// Every hex run of 7 or more: the run set of countIdsIn (holdout-ids.mjs hexRuns). A run over 40 holds a sha anywhere inside it.
const HEX_RUN = /(?<![0-9a-f])[0-9a-f]{7,}(?![0-9a-f])/gi;
const DIGIT_RUN = /\d+/g;
const KEY_RUN = /\d+:\d+/g;
const isShaId = (id) => /^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function listError(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

/**
 * The listed ids of the board root `root`: the holdout ids of the dataset and the eval config in it, and the gold ids of its gold folder (card
 * coord-content-scan-followups, item gold ids). `read` is the file reader and `list` the folder lister (passed in, so a test needs no disk).
 * A gold folder that does not exist adds no id; one that exists and cannot be read, or holds a broken file, is kind 'bad'.
 * Throws an Error with `.kind` ('absent' when the dataset file does not exist, 'bad' for any other read or parse problem or a missing config,
 * 'empty' for no ids) and a fixed message that holds no file content.
 */
export function readIdList(root, read = (p) => readFileSync(p, 'utf8'), list = (d) => readdirSync(d)) {
  let datasetText;
  try {
    datasetText = read(join(root, DATASET_REL));
  } catch (err) {
    if (err && err.code === 'ENOENT') throw listError('absent', MSG_ABSENT);
    throw listError('bad', MSG_BAD);
  }
  let ids;
  try {
    const ds = JSON.parse(datasetText);
    const cfg = JSON.parse(read(join(root, EVAL_CONFIG_REL)));
    ids = holdoutIdsOf(ds, cfg);
  } catch {
    throw listError('bad', MSG_BAD);
  }
  if (!Array.isArray(ids) || ids.length === 0) throw listError('empty', MSG_EMPTY);
  return [...new Set([...ids, ...readGoldIds(root, read, list)])];
}

/** The gold ids of the gold folder of `root`: [] when the folder does not exist, kind 'bad' when it cannot be read or holds a broken file. */
function readGoldIds(root, read, list) {
  const dir = join(root, GOLD_DIR_REL);
  let names;
  try {
    names = list(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw listError('bad', MSG_BAD);
  }
  try {
    const files = names.filter((n) => n.endsWith('.json') && !GOLD_NON_ROW_FILES.includes(n)).map((n) => JSON.parse(read(join(dir, n))));
    return checkGoldShape(files); // throws on a wrong shape, else the ids
  } catch {
    throw listError('bad', MSG_BAD);
  }
}

/** The stored shas of the list: 7 to 40 hex characters with at least one letter (the rule of holdout-scan.ts countHits). */
function shasOf(ids) {
  return ids.filter((id) => /^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id)).map((s) => s.toLowerCase());
}

/**
 * A hex run hits by the rule of countIdsIn (holdout-ids.mjs:94): a run of 7 to 40 when a stored sha starts with it or it starts with a stored
 * sha; a longer run when it holds a stored sha anywhere inside it.
 */
function shaHit(run, shas) {
  const r = run.toLowerCase();
  return r.length > 40 ? shas.some((s) => r.includes(s)) : shas.some((s) => s.startsWith(r) || r.startsWith(s));
}

/**
 * How many listed ids stand in `text`: exactly countIdsIn, the matcher of the push gate, commit-preflight and holdout-scan (card
 * coord-board-mask-ids: a second sha rule here had drifted from it and missed hex runs over 40). A number, never an id.
 */
export function countListed(text, ids) {
  return countIdsIn(String(text ?? ''), Array.isArray(ids) ? ids : []);
}

/** Replaces each match of `re` in `text` that `listed(match, at, text)` accepts with TOKEN. Returns { text, n }. */
function replaceWhere(text, re, listed) {
  let n = 0;
  const out = text.replace(re, (m, ...rest) => {
    const at = rest[rest.length - 2];
    if (!listed(m, at, text)) return m;
    n += 1;
    return TOKEN;
  });
  return { text: out, n };
}

/**
 * The text with every listed id replaced by TOKEN, and how many were replaced. Pure: no file, no output. Exactly as wide as countIdsIn (card
 * coord-board-mask-ids, seat ruling: parity): the masked text has a count of 0, and a text with a count of 0 is not changed. Four passes,
 * longest form first:
 *   1. the digit keys <pr>:<id>;
 *   2. every other id that is not digits and not a sha (a non-digit comment id, a <pr>:<string id> key), longest first, in any letter case,
 *      where the tokenHit boundary of countIdsIn holds (no 0-9, a-f or ':' on either side);
 *   3. the shas: every hex run of 7 or more that the sha rule accepts (shaHit), the whole run;
 *   4. the digit ids, only where countIdsIn accepts the run in its place (a short number after #, PR, pull/; a long id anywhere).
 */
export function maskListed(text, ids) {
  const src = String(text ?? '');
  if (src === '' || !Array.isArray(ids) || ids.length === 0) return { text: src, masked: 0 };
  const shas = shasOf(ids);
  const keys = new Set(ids.filter((id) => /^\d+:\d+$/.test(id)));
  const digits = new Set(ids.filter((id) => /^\d+$/.test(id)));
  const words = ids
    .filter((id) => typeof id === 'string' && id !== '' && !isShaId(id) && !/^\d+$/.test(id) && !/^\d+:\d+$/.test(id))
    .sort((a, b) => b.length - a.length);
  let total = 0;

  let out = replaceWhere(src, KEY_RUN, (m) => keys.has(m));
  total += out.n;
  for (const w of words) {
    // 'u' too: the matcher lowercases with toLowerCase, which folds the Kelvin sign to k; /i alone does not (critic pass 2, item 6).
    out = replaceWhere(out.text, new RegExp(`(?<![0-9a-f:])${escapeRe(w)}(?![0-9a-f:])`, 'giu'), () => true);
    total += out.n;
  }
  out = replaceWhere(out.text, HEX_RUN, (m) => shaHit(m, shas));
  total += out.n;
  out = replaceWhere(out.text, DIGIT_RUN, (m, at, whole) => {
    if (!digits.has(m)) return false;
    // The matcher decides, on the run and the 8 characters before it (the context rule of countIdsIn): the same rule as the hook.
    return countIdsIn(whole.slice(Math.max(0, at - 8), at + m.length), [m]) > 0;
  });
  total += out.n;
  return { text: out.text, masked: total };
}

const LANE_TEXT = ['title', 'scope', 'note', 'track', 'branch', 'done_when', 'rationale'];
const SESSION_LANE_TEXT = ['title', 'scope', 'note'];

/** The text as a reader sees it: compatibility forms folded (fullwidth digits), invisible marks removed, each white-space run one space. */
const readerView = (s) => s.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').replace(/\s+/g, ' ');

/**
 * Masks, in place, every lane text the page shows, at the source: right after the DB read, before any HTML escape, JSON.stringify or cut
 * (card coord-board-mask-ids; the kb-data JSON block and the cut session lines hid ids from a page-level mask). Fields: lane title, scope,
 * note, track; session working_on and its lanes' title, scope, note; event body. Ids, uuids and times are not text and stay. Returns the
 * count masked. The rows are the render's own copy: nothing writes them back to the lane database.
 */
export function maskLaneRows({ lanes = [], sessions = [], events = [] } = {}, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  let n = 0;
  // Two passes, composed: the raw text, then the reader view (white space collapsed, invisible marks gone, as the browser shows it) of the
  // masked text (critic pass 2, item 1: "PR", 7 spaces, a number escapes the 8-character look-back of the matcher). Never "the bigger count":
  // on equal counts that kept the raw text and left an id that only the reader view finds (CodeRabbit CLI run 1, agentic-os-listed-id-mask).
  const field = (row, key) => {
    if (!row || typeof row[key] !== 'string' || row[key] === '') return;
    const m = maskListed(row[key], ids);
    const flat = readerView(m.text);
    const f = flat === m.text ? { text: m.text, masked: 0 } : maskListed(flat, ids);
    if (m.masked + f.masked > 0) { row[key] = f.masked > 0 ? f.text : m.text; n += m.masked + f.masked; }
  };
  for (const l of lanes) for (const k of LANE_TEXT) field(l, k);
  for (const s of sessions) {
    field(s, 'working_on');
    for (const l of Array.isArray(s?.lanes) ? s.lanes : []) for (const k of SESSION_LANE_TEXT) field(l, k);
  }
  for (const e of events) field(e, 'body');
  return n;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·' };

/** The text as a browser shows it, entities decoded ONCE (a literal "&amp;#35;" stays text). A bad code point becomes U+FFFD, never a throw. */
function decodeOnce(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] !== '#') return Object.hasOwn(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : all;
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
  });
}

/** The string values of every application/json block, as a list; null when a block does not parse. An empty block holds no data. */
function jsonStrings(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (m[1].trim() === '') continue;
    let v;
    try { v = JSON.parse(m[1]); } catch { return null; }
    const walk = (x) => {
      if (typeof x === 'string') out.push(x);
      else if (x !== null && typeof x === 'object') for (const y of Object.values(x)) walk(y);
    };
    walk(v);
  }
  return out;
}

/**
 * The last step of a render: mask the whole page, check the whole page again, and say what to do.
 *   board `defaultBoard` (continuous-claude): any list problem, or a hit left after the mask, is exit 3 and no page.
 *   any other board: an ABSENT list (a board root has none by design) renders unmasked with one note line; a list that is present but bad or
 *   empty, or a hit left after the mask, is exit 3 and no page.
 * `readList` returns the ids or throws (see readIdList). `mask` and `count` are injectable for a test. Returns
 * { ok, html, exit, line, masked, left, bytes }. The lines hold no id.
 */
export function finishPage({ html, board, defaultBoard, readList, mask = maskListed, count = countListed }) {
  const fail = (line) => ({ ok: false, html: null, exit: 3, line, masked: 0, left: null, bytes: 0 });
  let ids;
  try {
    ids = readList();
  } catch (err) {
    if (err && err.kind === 'absent' && board !== defaultBoard) {
      return { ok: true, html, exit: 0, line: LINE_NOTE, masked: 0, left: null, bytes: Buffer.byteLength(html) };
    }
    return fail(LINE_NO_PAGE);
  }
  if (!Array.isArray(ids) || ids.length === 0) return fail(LINE_NO_PAGE);
  const m = mask(html, ids);
  // Count what the reader sees, not only the source (card coord-board-mask-ids, D3): the HTML as written, the HTML with entities decoded once,
  // its reader view (fullwidth folded, invisible marks gone, white space collapsed), and each string value of each JSON data block on its own
  // (and its reader view; one by one, so a context cannot cross two fields). Count only, never masked: a hit in any view is exit 3, no page.
  const strings = jsonStrings(m.text);
  if (strings === null) return fail(LINE_JSON);
  const decoded = decodeOnce(m.text);
  const views = [m.text, decoded, readerView(decoded)];
  for (const s of strings) views.push(s, readerView(s));
  const left = views.reduce((sum, v) => sum + count(v, ids), 0);
  if (left > 0) return fail(LINE_LEFT);
  const bytes = Buffer.byteLength(m.text);
  return { ok: true, html: m.text, exit: 0, line: `masked ${m.masked}, left 0, bytes checked ${bytes}`, masked: m.masked, left: 0, bytes };
}
