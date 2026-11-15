// The answer-key path list and its matcher. One source for scripts/github/pre-pr.mjs (the CodeRabbit CLI guard) and the push gate
// (.claude/hooks/src/shared/answer-paths-door.ts). esbuild bundles this file into a hook, so it has NO entry code, no process.argv read,
// no file or network access and no import: keep it that way (card prflow-push-blocks, seat ruling 2026-11-14).
//
// The list: the four known answer-key globs, frozen here (seat ruling 2026-11-13). A glob in a branch's own REVIEW.md earns nothing.
// pre-pr.mjs ties this list to the live REVIEW.md "Skip paths" as a drift alarm (its test A5); that check stays in pre-pr.mjs.

export const ANSWER_KEY_GLOBS = Object.freeze([
  'scripts/eval/review-eval/gold/**',
  'scripts/eval/review-eval/seeds/**',
  'scripts/eval/review-eval/rubrics/**',
  'scripts/eval/review-eval/linktype-labels.json',
]);

/** A path in one form: forward slashes, no leading ./, lower case (Gold/ is gold/). */
export const slashLower = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/**
 * True when the path matches one glob. A glob that ends in /** matches every path under that folder (at least one character after the
 * slash, like review-router.mjs matchGlob); any other glob must equal the path. Both sides are in slashLower form.
 */
function matches(glob, p) {
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -2); // keeps the slash
    return p.length > prefix.length && p.startsWith(prefix);
  }
  return glob === p;
}

/** The paths that match an answer-key glob (the original spelling of each hit is kept). */
export function answerKeyHitsOf(paths, globs = ANSWER_KEY_GLOBS) {
  const list = globs.map(slashLower);
  return paths.filter((p) => { const n = slashLower(p); return list.some((g) => matches(g, n)); });
}
