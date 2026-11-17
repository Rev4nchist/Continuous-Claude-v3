// The holdout ids of the review-engine eval, and a matcher that finds them in text (card prflow-push-blocks).
// Pure: no import, no file or process access, no output of an id. esbuild bundles this file into the push gate hook
// (.claude/hooks/src/shared/holdout-ids.ts reads the files and passes the parsed values in).
//
// Source at run time: the dataset .claudedocs/2026-11-01-pr-review-dataset.json (git-ignored, read from the PRIMARY checkout) and the set rule of
// scripts/eval/review-eval/config.json (holdoutExclude, reserve). A PR is in the holdout when it is neither excluded (dev) nor reserved (the
// same rule as setOf in scripts/eval/review-eval/dataset.mjs; this file repeats those two lines because dataset.mjs imports gh and git
// code that must not be bundled into a hook; the test H-S2 ties the two together).

/** The ids of the holdout PRs as text: the PR number, each comment id, the finding keys (<pr>:<comment id>) and every round sha. */
export function holdoutIdsOf(ds, cfg) {
  const reserved = new Set((cfg?.reserve ?? []).map((r) => r?.pr));
  const excluded = new Set(cfg?.holdoutExclude ?? []);
  const inHoldout = (pr) => !reserved.has(pr) && !excluded.has(pr);
  const out = new Set();
  for (const p of ds?.prs ?? []) if (inHoldout(p?.pr)) out.add(String(p.pr));
  for (const f of ds?.findings ?? []) {
    if (!inHoldout(f?.pr)) continue;
    out.add(String(f.pr));
    if (f.comment_id !== undefined && f.comment_id !== null) { out.add(String(f.comment_id)); out.add(`${f.pr}:${f.comment_id}`); }
    if (typeof f.round === 'string' && /^[0-9a-f]{7,40}$/i.test(f.round)) out.add(f.round.toLowerCase());
  }
  out.delete('undefined');
  out.delete('null');
  return [...out];
}

/** A gold PR number shorter than this is not listed: our own PR references ("#123") would hit it (design note, section 4; seat ruling 2026-11-16). */
export const MIN_GOLD_PR_DIGITS = 4;

/**
 * The gold ids as text, from the parsed gold files (card coord-content-scan-followups, item gold ids; the warn and mask guards only, never the deny
 * list). `files` is a list of parsed files, each a list of rows. A sha is any string of 7 to 40 hex with a letter, in ANY field of a row (target,
 * provenance, a head map, both sides of a range written "a..b" or "a...b"); a 64-hex hash is not one. A PR number is `target.pr` when it is an
 * integer of MIN_GOLD_PR_DIGITS digits or more. Sorted, each once. Pure like the rest of this file: no import, no file access, no output of an id.
 */
export function goldIdsOf(files) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { for (const part of v.split(/\.{2,3}/)) if (isSha(part)) out.add(part.toLowerCase()); return; }
    if (v !== null && typeof v === 'object') Object.values(v).forEach(walk); // an array too: Object.values lists its items
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

/**
 * The shape check of the gold input: throws one fixed text, never a value, when `files` is not a non-empty list of lists of objects or when no
 * sha is found at all (a renamed field would give a short list that passes ids unseen: the same reason as checkHoldoutShape).
 */
export function checkGoldShape(files) {
  const bad = () => { throw new Error('the gold id files have the wrong shape'); };
  if (!Array.isArray(files)) bad();
  for (const rows of files) {
    if (!Array.isArray(rows)) bad();
    for (const row of rows) if (row === null || typeof row !== 'object' || Array.isArray(row)) bad();
  }
  if (!goldIdsOf(files).some((id) => isSha(id))) bad();
}

// Seat read 2 (minor) asked for "PR: n", "pr_n", a JSON "pr": n field and "pull request n" too. Measured on 600 commits of main (2026-11-15):
// the JSON form adds 10 hits and "PR: n" 2, all short PR numbers: this repo's own JSON (Gold A, eval files) holds CCv3 PR numbers that
// collide with holdout PR numbers, so those forms would deny ordinary re/ pushes. Not added; a known limit of the matcher.
const CONTEXT = /(?:#|\bPR\s*#?|\bpull\/|\bpulls\/|\bissues\/|\bpr-)\s*$/i;

/**
 * How many ids of the list stand in the text. Each id counts once. Forms: a digit id of 7 or more digits (a comment id) matches as a whole
 * digit run; a shorter digit id (a PR number) matches only right after #, "PR", "pull/" or "pulls/"; a finding key (<pr>:<id>) matches as a
 * whole token. A sha (7 to 40 hex characters with a letter) matches when a hex run of 7 or more in the text is a prefix of it, or it is a
 * prefix of the run (card coord-decision-gate-round3-content-scan, F1: a short sha in a commit message; the holdout-scan hook rule, seat R1).
 * A bare small number never matches. The count is returned, never the id. The one matcher of the push gate, commit-preflight and holdout-scan.
 */
export function countIdsIn(text, ids) {
  const s = String(text ?? '');
  let runs = null;
  let low = null;
  let n = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue;
    if (isSha(id)) {
      runs ??= hexRuns(s);
      const want = id.toLowerCase();
      // A run of 7 to 40 is a sha: either may be the prefix. A longer run (seat read 2, minor) holds a sha anywhere inside it.
      if (runs.some((r) => (r.length > 40 ? r.includes(want) : want.startsWith(r) || r.startsWith(want)))) n += 1;
    } else if (/^\d+$/.test(id)) { if (digitHit(s, id)) n += 1; } else if (tokenHit((low ??= s.toLowerCase()), id)) n += 1;
  }
  return n;
}

const isSha = (id) => /^[0-9a-f]{7,40}$/i.test(id) && /[a-f]/i.test(id);
/** Every run of 7 or more hex characters with no hex character next to it, in lower case. */
function hexRuns(s) {
  return [...s.matchAll(/(?<![0-9a-f])[0-9a-f]{7,}(?![0-9a-f])/gi)].map((m) => m[0].toLowerCase());
}

/**
 * The shape check of the scan input (card coord-decision-gate-round3-content-scan, item 14). Throws a fixed text when the dataset or the
 * config cannot give the whole id list: a missing findings key gives the PR numbers only, so the scan would pass comment ids and shas.
 * Rules: the dataset is an object; prs and findings are non-empty arrays; each pr is a positive integer; reserve and holdoutExclude are
 * arrays when present. The text never holds a value from the files.
 */
export function checkHoldoutShape(ds, cfg) {
  const bad = () => { throw new Error('the holdout dataset or its config has the wrong shape'); };
  const posInt = (v) => Number.isInteger(v) && v > 0;
  if (ds === null || typeof ds !== 'object' || Array.isArray(ds)) bad();
  if (!Array.isArray(ds.prs) || ds.prs.length === 0 || !Array.isArray(ds.findings) || ds.findings.length === 0) bad();
  if (!ds.prs.every((p) => p !== null && typeof p === 'object' && posInt(p.pr))) bad();
  if (!ds.findings.every((f) => f !== null && typeof f === 'object' && posInt(f.pr))) bad();
  // Seat read 2, item 4, fitted to the real dataset (2026-11-15: of 93 findings, 51 carry a digit comment_id, 32 none, 10 another string; round
  // is an integer): a comment_id that is present is a positive integer or a non-empty string; a round that is present is a string or an
  // integer; and at least one finding carries a digit comment_id, so a renamed key throws instead of dropping every comment id.
  const absent = (v) => v === undefined || v === null;
  if (!ds.findings.every((f) => absent(f.comment_id) || posInt(f.comment_id) || (typeof f.comment_id === 'string' && f.comment_id !== ''))) bad();
  if (!ds.findings.every((f) => absent(f.round) || typeof f.round === 'string' || Number.isInteger(f.round))) bad();
  if (!ds.findings.some((f) => posInt(f.comment_id) || (typeof f.comment_id === 'string' && /^\d+$/.test(f.comment_id)))) bad();
  if (cfg !== null && cfg !== undefined && (typeof cfg !== 'object' || Array.isArray(cfg))) bad();
  for (const k of ['reserve', 'holdoutExclude']) if (cfg?.[k] !== undefined && !Array.isArray(cfg[k])) bad();
}

function digitHit(s, id) {
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

/** `low` is the text in lower case, made once by the caller (seat read 2, item 7: not once per id on 8 MB). */
function tokenHit(low, id) {
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
