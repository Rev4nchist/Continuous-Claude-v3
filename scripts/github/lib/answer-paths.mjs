/**
 * answer-paths.mjs - the answer-key path match list and its check. Side-effect free: constants and functions only.
 * Moved byte-for-byte from scripts/github/review-router.mjs (globToRegExp, matchGlob) and scripts/github/pre-pr.mjs
 * (ANSWER_KEY_GLOBS, answerKeyGlobs, answerKeyCheck) so the coderabbit-guard hook can import them. pre-pr.mjs and
 * review-router.mjs re-export every name, so each current importer still works.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseReviewMd } from '../../ratchets/lib/review-md.mjs';
import { ANSWER_KEY_GLOBS, answerKeyHitsOf, slashLower } from './answer-key.mjs';

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

// The match list (ANSWER_KEY_GLOBS), slashLower and answerKeyHitsOf live in ./answer-key.mjs, the ONE list that the push gate also reads
// (card prflow-push-blocks). This file re-exports the list and the normaliser, so the hook and the old importers keep their names.
// A glob in the branch's own REVIEW.md earns nothing: REVIEW.md "Skip paths" is only the drift alarm (answerKeyGlobs below).

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
  const hits = answerKeyHitsOf(paths, globs);
  return hits.length === 0 ? null : { hits };
}

// ANSWER_KEY_GLOBS is the frozen list of ./answer-key.mjs. slashLower is also used by pre-pr.mjs (baseProblem).
export { ANSWER_KEY_GLOBS, slashLower };