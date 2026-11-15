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

const CONTEXT = /(?:#|\bPR\s*#?|\bpull\/|\bpulls\/|\bissues\/|\bpr-)\s*$/i;

/**
 * How many ids of the list stand in the text. Each id counts once. Forms: a digit id of 7 or more digits (a comment id) matches as a whole
 * digit run; a shorter digit id (a PR number) matches only right after #, "PR", "pull/" or "pulls/"; a finding key (<pr>:<id>) and a sha
 * (7 to 40 hex characters) match as a whole token. A bare small number never matches. The count is returned, never the id.
 */
export function countIdsIn(text, ids) {
  const s = String(text ?? '');
  let n = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue;
    if (/^\d+$/.test(id)) { if (digitHit(s, id)) n += 1; } else if (tokenHit(s, id)) n += 1;
  }
  return n;
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

function tokenHit(s, id) {
  const low = s.toLowerCase();
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
