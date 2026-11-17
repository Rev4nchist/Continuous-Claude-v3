/**
 * board-mask -- the listed-id mask of the lane board page (card coord-board-mask-listed-ids).
 *
 * A published lane page must carry no listed id (an id of the review-engine answer key). The hook holdout-scan counts them in the first 1 MiB of
 * a publish; this module masks them in the WHOLE page before render-board.mjs writes it, so a later lane note cannot put one back.
 *
 * Source of the list: the same two files and the same matcher as the hook. The matcher is scripts/github/lib/holdout-ids.mjs (imported, not
 * copied). The two file names are repeated here (the hook reader is TypeScript) and a test ties them to the hook text. The sha-prefix rule of the
 * hook (holdout-scan.ts countHits) is repeated in shaHit below and a test ties it to the hook text too.
 *
 * Nothing here prints, returns in a message or logs an id. A caller gets counts (masked, left, bytes) and fixed texts. The token holds no digit and
 * no hex run, so the matcher never counts it, and it stays valid inside JSON strings, HTML attributes and link paths.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGoldShape, countIdsIn, goldIdsOf, holdoutIdsOf } from '../github/lib/holdout-ids.mjs';

export const DATASET_REL = '.claudedocs/2026-11-01-pr-review-dataset.json';
export const EVAL_CONFIG_REL = 'scripts/eval/review-eval/config.json';
/** The tracked gold answer keys and the one json file of that folder with no rows (the hook repeats both: .claude/hooks/src/shared/holdout-ids.ts; a test ties them). */
export const GOLD_DIR_REL = 'scripts/eval/review-eval/gold';
export const GOLD_NON_ROW_FILES = Object.freeze(['escape-baseline.json']);
export const TOKEN = 'masked-id';

const MSG_BAD = 'the listed id list could not be read';
const MSG_ABSENT = 'the listed id list is absent';
const MSG_EMPTY = 'the listed id list is empty';
const LINE_NO_PAGE = 'render-board: the listed-id list could not be read; no page written';
const LINE_LEFT = 'render-board: a listed id is left after the mask; no page written';
const LINE_NOTE = 'render-board: note: this board has no listed-id list; the page is not masked';

const HEX_RUN = /(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/gi;
const DIGIT_RUN = /\d+/g;
const KEY_RUN = /\d+:\d+/g;

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
    const files = names.filter((n) => n.endsWith('.json') && !GOLD_NON_ROW_FILES.includes(n)).sort().map((n) => JSON.parse(read(join(dir, n))));
    checkGoldShape(files);
    return goldIdsOf(files);
  } catch {
    throw listError('bad', MSG_BAD);
  }
}

/** The stored shas of the list: 7 to 40 hex characters with at least one letter (the rule of holdout-scan.ts countHits). */
function shasOf(ids) {
  return ids.filter((id) => /^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id)).map((s) => s.toLowerCase());
}

/** A hex run hits when a stored sha starts with it or it starts with a stored sha (7 hex floor: HEX_RUN). */
function shaHit(run, shas) {
  const r = run.toLowerCase();
  return shas.some((s) => s.startsWith(r) || r.startsWith(s));
}

/**
 * How many listed ids stand in `text`, by the rule of the hook: countIdsIn for digit ids, keys and shas, plus the sha-prefix rule for each
 * stored sha that a hex run of the text is a prefix of (or the reverse). A number, never an id.
 */
export function countListed(text, ids) {
  const s = String(text ?? '');
  const shas = shasOf(ids);
  const rest = ids.filter((id) => !shas.includes(id.toLowerCase()));
  const runs = [...s.matchAll(HEX_RUN)].map((m) => m[0].toLowerCase());
  const shaHits = shas.filter((sha) => runs.some((r) => sha.startsWith(r) || r.startsWith(sha))).length;
  return countIdsIn(s, rest) + shaHits;
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
 * The text with every listed id replaced by TOKEN, and how many were replaced. Pure: no file, no output. Three passes, longest form first:
 * the <pr>:<id> keys, the shas (a hex run of 7 to 40 that the sha rule accepts), then the digit ids. A digit id is replaced only where
 * countIdsIn accepts it in its place: a short number only after #, PR, pull/ and the like, a long comment id anywhere as a whole run.
 */
export function maskListed(text, ids) {
  const src = String(text ?? '');
  if (src === '' || !Array.isArray(ids) || ids.length === 0) return { text: src, masked: 0 };
  const shas = shasOf(ids);
  const keys = new Set(ids.filter((id) => /^\d+:\d+$/.test(id)));
  const digits = new Set(ids.filter((id) => /^\d+$/.test(id)));
  let total = 0;

  const pass1 = replaceWhere(src, KEY_RUN, (m) => keys.has(m));
  total += pass1.n;
  const pass2 = replaceWhere(pass1.text, HEX_RUN, (m) => /[a-f]/i.test(m) && shaHit(m, shas));
  total += pass2.n;
  const pass3 = replaceWhere(pass2.text, DIGIT_RUN, (m, at, whole) => {
    if (!digits.has(m)) return false;
    // The matcher decides, on the run and the 8 characters before it (the context rule of countIdsIn): the same rule as the hook.
    return countIdsIn(whole.slice(Math.max(0, at - 8), at + m.length), [m]) > 0;
  });
  total += pass3.n;
  return { text: pass3.text, masked: total };
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
  const left = count(m.text, ids);
  if (left > 0) return fail(LINE_LEFT);
  const bytes = Buffer.byteLength(m.text);
  return { ok: true, html: m.text, exit: 0, line: `masked ${m.masked}, left 0, bytes checked ${bytes}`, masked: m.masked, left: 0, bytes };
}
