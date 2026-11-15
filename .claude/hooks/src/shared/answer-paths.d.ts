/**
 * Types for scripts/github/lib/answer-paths.mjs, which the hook bundles (esbuild follows the relative import).
 * TypeScript reads no .mjs under this tsconfig (no allowJs), so the module is typed here by a pattern.
 */
declare module '*/scripts/github/lib/answer-paths.mjs' {
  /** The four frozen answer-key globs. */
  export const ANSWER_KEY_GLOBS: readonly string[];
  /** { hits } (the answer-key paths, at least one), { closed } (why the check cannot run) or null (no answer-key path). */
  export function answerKeyCheck(input: { root: string; paths: string[] | null }): { hits: string[] } | { closed: string } | null;
  export function matchGlob(glob: string, path: string): boolean;
  export function slashLower(path: string): string;
}
