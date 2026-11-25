/**
 * The listed-id mask of the app (card agentic-os-listed-id-mask). PURE: no 'server-only', no file access, no output of an id.
 *
 * A COPY, like src/server/sources/redact.ts: scripts/coordination/board-mask.mjs and scripts/github/lib/holdout-ids.mjs sit outside
 * apps/agentic-os, so Next and tsc cannot import them. What is copied: the matcher (countIdsIn), the id list rules (holdoutIdsOf, goldIdsOf,
 * checkGoldShape), the mask (maskListed) and its field rule (maskString: the text as a reader sees it). The copy has no id in it. The list is
 * read at run time (src/server/sources/listed-ids.ts) from the same files as readIdList.
 *
 * DRIFT: e2e/listed-id-drift.spec.ts imports both originals, read only, and fails when this copy and they differ in a file name, the token,
 * an id list rule or a fold rule. Change this file and the originals together.
 */

export const DATASET_REL = '.claudedocs/2026-11-01-pr-review-dataset.json';
export const EVAL_CONFIG_REL = 'scripts/eval/review-eval/config.json';
/** The tracked gold answer keys and the one json file of that folder with no rows. */
export const GOLD_DIR_REL = 'scripts/eval/review-eval/gold';
export const GOLD_NON_ROW_FILES: readonly string[] = Object.freeze(['escape-baseline.json']);
/** Holds no digit and no hex run, so the matcher never counts it. */
export const TOKEN = 'masked-id';
/** A gold PR number shorter than this is not listed: our own PR references would hit it. */
export const MIN_GOLD_PR_DIGITS = 4;

export type ListedIds = { ok: true; ids: string[] } | { ok: false; reason: 'absent' | 'bad' | 'empty' };
export type Masked = { text: string; masked: number };

// ---------- the id list (holdout-ids.mjs) ----------

const isSha = (id: string): boolean => /^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id);

/** The ids of the holdout PRs as text: the PR number, each comment id, the finding keys (<pr>:<comment id>) and every round sha. */
export function holdoutIdsOf(ds: any, cfg: any): string[] {
  const reserved = new Set((cfg?.reserve ?? []).map((r: any) => r?.pr));
  const excluded = new Set(cfg?.holdoutExclude ?? []);
  const inHoldout = (pr: unknown) => !reserved.has(pr) && !excluded.has(pr);
  const out = new Set<string>();
  for (const p of ds?.prs ?? []) if (inHoldout(p?.pr)) out.add(String(p.pr));
  for (const f of ds?.findings ?? []) {
    if (!inHoldout(f?.pr)) continue;
    out.add(String(f.pr));
    if (f.comment_id !== undefined && f.comment_id !== null) {
      out.add(String(f.comment_id));
      out.add(`${f.pr}:${f.comment_id}`);
    }
    if (typeof f.round === 'string' && /^[0-9a-f]{7,40}$/i.test(f.round)) out.add(f.round.toLowerCase());
  }
  out.delete('undefined');
  out.delete('null');
  return [...out];
}

/** The gold ids as text, from the parsed gold files: every sha in any field of a row (also both sides of "a..b"), and target.pr of enough digits. */
export function goldIdsOf(files: any): string[] {
  const out = new Set<string>();
  const walk = (v: any): void => {
    if (typeof v === 'string') {
      for (const part of v.split(/\.{2,3}/)) if (isSha(part)) out.add(part.toLowerCase());
      return;
    }
    if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const rows of Array.isArray(files) ? files : []) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      walk(row);
      const pr = row?.target?.pr;
      if (Number.isInteger(pr) && pr > 0 && String(pr).length >= MIN_GOLD_PR_DIGITS) out.add(String(pr));
    }
  }
  return [...out].sort();
}

/** The shape check of the gold input: throws one fixed text, never a value; returns the ids. */
export function checkGoldShape(files: any): string[] {
  const bad = (): never => {
    throw new Error('the gold id files have the wrong shape');
  };
  if (!Array.isArray(files)) bad();
  for (const rows of files) {
    if (!Array.isArray(rows)) bad();
    for (const row of rows) if (row === null || typeof row !== 'object' || Array.isArray(row)) bad();
  }
  const ids = goldIdsOf(files);
  if (!ids.some((id) => isSha(id))) bad();
  return ids;
}

// ---------- the matcher (holdout-ids.mjs countIdsIn) ----------

const CONTEXT = /(?:#|\bPR\s*#?|\bpull\/|\bpulls\/|\bissues\/|\bpr-)\s*$/i;

/** Every run of 7 or more hex characters with no hex character next to it, in lower case. */
function hexRuns(s: string): string[] {
  return [...s.matchAll(/(?<![0-9a-f])[0-9a-f]{7,}(?![0-9a-f])/gi)].map((m) => m[0].toLowerCase());
}

function digitHit(s: string, id: string): boolean {
  const long = id.length >= 7;
  let from = 0;
  for (;;) {
    const at = s.indexOf(id, from);
    if (at < 0) return false;
    from = at + 1;
    const before = s[at - 1];
    const after = s[at + id.length];
    if ((before !== undefined && /\d/.test(before)) || (after !== undefined && /\d/.test(after))) continue; // part of a longer number
    if (long || CONTEXT.test(s.slice(Math.max(0, at - 8), at))) return true;
  }
}

function tokenHit(low: string, id: string): boolean {
  const want = id.toLowerCase();
  const word = /[0-9a-f:]/;
  let from = 0;
  for (;;) {
    const at = low.indexOf(want, from);
    if (at < 0) return false;
    from = at + 1;
    const before = low[at - 1];
    const after = low[at + want.length];
    if ((before !== undefined && word.test(before)) || (after !== undefined && word.test(after))) continue;
    return true;
  }
}

/** How many ids of the list stand in the text. Each id counts once. A number, never an id. */
export function countListed(text: unknown, ids: string[]): number {
  const s = String(text ?? '');
  let runs: string[] | null = null;
  let low: string | null = null;
  let n = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || id === '') continue;
    if (isSha(id)) {
      runs ??= hexRuns(s);
      const want = id.toLowerCase();
      // A run of 7 to 40 is a sha: either may be the prefix. A longer run holds a sha anywhere inside it.
      if (runs.some((r) => (r.length > 40 ? r.includes(want) : want.startsWith(r) || r.startsWith(want)))) n += 1;
    } else if (/^\d+$/.test(id)) {
      if (digitHit(s, id)) n += 1;
    } else if (tokenHit((low ??= s.toLowerCase()), id)) n += 1;
  }
  return n;
}

// ---------- the mask (board-mask.mjs maskListed, maskLaneRows field rule) ----------

const HEX_RUN = /(?<![0-9a-f])[0-9a-f]{7,}(?![0-9a-f])/gi;
const DIGIT_RUN = /\d+/g;
const KEY_RUN = /\d+:\d+/g;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function shaHit(run: string, shas: string[]): boolean {
  const r = run.toLowerCase();
  return r.length > 40 ? shas.some((s) => r.includes(s)) : shas.some((s) => s.startsWith(r) || r.startsWith(s));
}

/** Replaces each match of `re` in `text` that `listed(match, at, text)` accepts with TOKEN. */
function replaceWhere(text: string, re: RegExp, listed: (m: string, at: number, whole: string) => boolean): { text: string; n: number } {
  let n = 0;
  const out = text.replace(re, (m: string, ...rest: any[]) => {
    const at = rest[rest.length - 2] as number;
    if (!listed(m, at, text)) return m;
    n += 1;
    return TOKEN;
  });
  return { text: out, n };
}

/** The text as a reader sees it: compatibility forms folded (fullwidth digits), invisible marks removed, each white-space run one space. */
const readerView = (s: string): string => s.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').replace(/\s+/g, ' ');

/**
 * The mask for one list, prepared once (the id groups and the word regexps), so a whole snapshot costs one set-up. Four passes, longest form
 * first: the digit keys <pr>:<id>; every other id that is not digits and not a sha (longest first, any letter case); the shas (the whole hex
 * run); the digit ids, only where the matcher accepts the run in its place. Exactly as wide as countListed.
 */
export function prepareMask(ids: string[]): (text: string) => Masked {
  const list = Array.isArray(ids) ? ids : [];
  const shas = list.filter(isSha).map((s) => s.toLowerCase());
  const keys = new Set(list.filter((id) => /^\d+:\d+$/.test(id)));
  const digits = new Set(list.filter((id) => /^\d+$/.test(id)));
  const wordRes = list
    .filter((id) => typeof id === 'string' && id !== '' && !isSha(id) && !/^\d+$/.test(id) && !/^\d+:\d+$/.test(id))
    .sort((a, b) => b.length - a.length)
    // 'u' too: the matcher lowercases with toLowerCase, which folds the Kelvin sign to k; /i alone does not.
    .map((w) => new RegExp(`(?<![0-9a-f:])${escapeRe(w)}(?![0-9a-f:])`, 'giu'));
  return (text: string): Masked => {
    const src = String(text ?? '');
    if (src === '' || list.length === 0) return { text: src, masked: 0 };
    let total = 0;
    let out = replaceWhere(src, KEY_RUN, (m) => keys.has(m));
    total += out.n;
    for (const re of wordRes) {
      re.lastIndex = 0;
      out = replaceWhere(out.text, re, () => true);
      total += out.n;
    }
    out = replaceWhere(out.text, HEX_RUN, (m) => shaHit(m, shas));
    total += out.n;
    out = replaceWhere(out.text, DIGIT_RUN, (m, at, whole) => {
      if (!digits.has(m)) return false;
      // The matcher decides, on the run and the 8 characters before it (the context rule of countListed).
      return countListed(whole.slice(Math.max(0, at - 8), at + m.length), [m]) > 0;
    });
    total += out.n;
    return { text: out.text, masked: total };
  };
}

/** The text with every listed id replaced by TOKEN, and how many were replaced. */
export function maskListed(text: string, ids: string[]): Masked {
  return prepareMask(ids)(text);
}

/**
 * The field rule of the board page: two passes, composed. The raw text is masked, then the reader view of the masked text (white space collapsed,
 * invisible marks gone, fullwidth folded) is masked ("PR", 7 spaces, a number escapes the 8-character look-back of the matcher). Never "the
 * bigger count": on equal counts that kept the raw text and left an id that only the reader view finds (CodeRabbit CLI run 1).
 */
export function maskStringWith(mask: (text: string) => Masked, text: string): Masked {
  if (typeof text !== 'string' || text === '') return { text, masked: 0 };
  const m = mask(text);
  // The token ends in a hex letter, so before the second pass it is swapped for one private-use character that the text does not hold, and
  // swapped back after: a folded fullwidth sha glued to the token must not make one long hex run (CodeRabbit CLI run 2, finding 1).
  const mark = freeMark(m.text);
  const swapped = m.text.split(TOKEN).join(mark);
  const flat = readerView(swapped);
  const f = flat === swapped ? { text: m.text, masked: 0 } : mask(flat);
  const total = m.masked + f.masked;
  return total > 0 ? { text: f.masked > 0 ? f.text.split(mark).join(TOKEN) : m.text, masked: total } : { text, masked: 0 };
}

/** One private-use character that the text does not hold. */
function freeMark(s: string): string {
  for (let c = 0xe000; c < 0xf8ff; c++) if (!s.includes(String.fromCharCode(c))) return String.fromCharCode(c);
  return '';
}

export function maskString(text: string, ids: string[]): Masked {
  return maskStringWith(prepareMask(ids), text);
}

// ---------- reading the list (board-mask.mjs readIdList), with the file access passed in ----------

const withoutTrailingSlash = (root: string): string => root.replace(/[\\/]+$/, '');

/** The gold ids of the gold folder: [] when the folder does not exist; throws 'bad' when it cannot be read or holds a broken file. */
function readGoldIds(root: string, read: (path: string) => string, list: (dir: string) => string[]): string[] {
  const dir = `${root}/${GOLD_DIR_REL}`;
  let names: string[];
  try {
    names = list(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw new Error('bad');
  }
  try {
    const files = names.filter((n) => n.endsWith('.json') && !GOLD_NON_ROW_FILES.includes(n)).map((n) => JSON.parse(read(`${dir}/${n}`)));
    return checkGoldShape(files);
  } catch {
    throw new Error('bad');
  }
}

/**
 * The listed ids of the board root `root`, or why there are none. NEVER an empty list that passes: no dataset file is "absent", a broken file
 * or a missing config or a bad gold file is "bad", no id at all is "empty". `read` and `list` are the file reader and folder lister.
 */
export function loadListedIds(root: string, read: (path: string) => string, list: (dir: string) => string[]): ListedIds {
  const base = withoutTrailingSlash(root);
  let datasetText: string;
  try {
    datasetText = read(`${base}/${DATASET_REL}`);
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'bad' };
  }
  let ids: string[];
  try {
    ids = holdoutIdsOf(JSON.parse(datasetText), JSON.parse(read(`${base}/${EVAL_CONFIG_REL}`)));
  } catch {
    return { ok: false, reason: 'bad' };
  }
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, reason: 'empty' };
  try {
    return { ok: true, ids: [...new Set([...ids, ...readGoldIds(base, read, list)])] };
  } catch {
    return { ok: false, reason: 'bad' };
  }
}

/**
 * Where the list files are. AGENTIC_OS_LISTED_ID_ROOT first (a worktree or a moved app sets it); else two folders above the app
 * (next dev and next start run in apps/agentic-os). A root with no list files is "absent": the snapshot stops, it never reads as an empty list.
 */
export function listedIdRoot(env: Record<string, string | undefined>, cwd: string): string {
  const fromEnv = env.AGENTIC_OS_LISTED_ID_ROOT?.trim();
  if (fromEnv) return fromEnv;
  const parts = withoutTrailingSlash(cwd).split(/[\\/]/);
  return parts.slice(0, -2).join('/') || '.';
}
