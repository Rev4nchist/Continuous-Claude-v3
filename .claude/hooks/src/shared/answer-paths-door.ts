/**
 * Typed door to the answer-key path list (scripts/github/lib/answer-key.mjs). pre-pr.mjs and the push gate read the same module, so the list
 * exists once. The module has no entry code and no import: esbuild bundles it into the hook, never pre-pr.mjs (its entry guard compares the
 * running file with import.meta.url, which can be true inside a bundle).
 */
// @ts-ignore TS7016: answer-key.mjs has no declaration file.
import * as lib from '../../../../scripts/github/lib/answer-key.mjs';

/** The paths that match an answer-key glob (original spelling kept). */
export const answerKeyHitsOf: (paths: string[]) => string[] = lib.answerKeyHitsOf;
