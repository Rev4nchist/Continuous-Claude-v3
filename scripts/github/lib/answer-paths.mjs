/**
 * answer-paths.mjs - the answer-key path match list and its check. Side-effect free: constants and functions only.
 * Moved byte-for-byte from scripts/github/review-router.mjs (globToRegExp, matchGlob) and scripts/github/pre-pr.mjs
 * (ANSWER_KEY_GLOBS, answerKeyGlobs, answerKeyCheck) so the coderabbit-guard hook can import them. pre-pr.mjs and
 * review-router.mjs re-export every name, so each current importer still works.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseReviewMd } from '../../ratchets/review-skip-sync.mjs';

// ---------- glob: ** (whole segments, zero or more), * (one segment), ? (one char). Nothing else is special. ----------

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
const segmentToRe = (seg) => escapeRe(seg).replace(/\*+/g, '[^/]*').replace(/\?/g, '[^/]');

export function globToRegExp(glob) {
  if (typeof glob !== 'string' || glob === '') throw new Error('empty glob');
  const segs = glob.split('/');
  let re = '';
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === '**') re += last ? '.+' : '(?:[^/]+/)*';
    else re += segmentToRe(seg) + (last ? '' : '/');
  });
  return new RegExp(`^${re}$`);
}

export const matchGlob = (glob, p) => globToRegExp(glob).test(p);

/**
 * The match list: the four known answer-key globs, frozen here (Seat ruling 2026-11-13). A glob in the branch's own REVIEW.md earns nothing:
 * a wider one cannot widen the skip. REVIEW.md "Skip paths" is only the drift alarm (answerKeyGlobs). The test A5 ties this list to the live
 * REVIEW.md and to the answer-key entries of cursor-review.mjs TREE_EXCLUDES.
 */
export const ANSWER_KEY_GLOBS = Object.freeze([
  'scripts/eval/review-eval/gold/**',
  'scripts/eval/review-eval/seeds/**',
  'scripts/eval/review-eval/rubrics/**',
  'scripts/eval/review-eval/linktype-labels.json',
]);
const slashLower = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/** { globs } (the frozen four) or { reason }: fail closed when REVIEW.md "Skip paths" cannot be read or lacks any of the four. */
export function answerKeyGlobs(root) {
  let text;
  try { text = readFileSync(path.join(root, 'REVIEW.md'), 'utf8'); } catch (err) { return { reason: `REVIEW.md could not be read (${err.code ?? 'error'})` }; }
  let listed;
  try { listed = parseReviewMd(text).map(slashLower); } catch (err) { return { reason: String(err.message) }; }
  const missing = ANSWER_KEY_GLOBS.filter((g) => !listed.includes(slashLower(g)));
  return missing.length === 0 ? { globs: ANSWER_KEY_GLOBS } : { reason: `REVIEW.md "Skip paths" lacks ${missing.join(', ')}` };
}

/**
 * { hits } (the answer-key paths, at least one), { closed } (why the guard cannot check the diff) or null (no answer-key path). A path
 * matches a whole glob, after slashes and case are normalised (Gold/ is gold/).
 */
export function answerKeyCheck({ root, paths }) {
  if (!Array.isArray(paths)) return { closed: 'the changed-file list is unknown' };
  const { globs, reason } = answerKeyGlobs(root);
  if (!globs) return { closed: reason };
  const hits = paths.filter((p) => globs.some((g) => matchGlob(slashLower(g), slashLower(p))));
  return hits.length === 0 ? null : { hits };
}

// slashLower is also used by pre-pr.mjs (baseProblem).
export { slashLower };