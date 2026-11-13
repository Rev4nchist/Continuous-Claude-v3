/**
 * Which file does a tool call write? Used by file-claims (card coord-file-claims-all-writers, gap 3, rule O3.1).
 *
 * Group A: the tool input names the path. Edit, Write, NotebookEdit and three Desktop Commander tools.
 * `directWritePaths` reads the field. No parsing.
 *
 * Group B: the tool input is shell text. There is NO lexer here (memory guard-shell-lexer-arms-race).
 * The match is a needle search built from a path that another live session HOLDS:
 *   (a) a redirect: ">" or ">>", optional spaces, an optional quote, then the path. A ">" that is not directly
 *       before the path is no cue (`2>&1`, `> scratch.txt`, `2>/dev/null`).
 *   (b) a command cue as a whole word (tee, Set-Content, mv, git checkout ...) with the path LATER in the text.
 *   Anything else that holds the path is a mention. A mention never denies.
 * Not seen: a path built at run time (variable, glob, a script that writes the file, `cd` then a bare
 * name), and git stash, reset, merge and rebase, which change files without naming them.
 *
 * Two gates: the matcher in settings.json.template and the runtime gate in file-claims.ts must name the same
 * tools (guard: hook-matcher-runtime-consistency.test.ts). `SHELL_WRITERS` and `DIRECT_WRITERS` are the list.
 */
import { SHELL_TOOLS } from './shell-tools.js';

const DC = 'mcp__plugin_desktop-commander_desktop-commander__';

/** Tool name -> the tool_input fields that hold a path the tool writes. */
export const DIRECT_WRITERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['Edit', ['file_path']],
  ['Write', ['file_path']],
  ['NotebookEdit', ['notebook_path']],
  [`${DC}write_file`, ['path']],
  [`${DC}edit_block`, ['file_path']],
  [`${DC}move_file`, ['source', 'destination']],
]);

/** The shell tools (same list the other command guards use). */
export const SHELL_WRITERS: readonly string[] = [...SHELL_TOOLS.keys()];

/** Every tool name file-claims must be registered on. */
export const CLAIM_TOOLS: readonly string[] = [...DIRECT_WRITERS.keys(), ...SHELL_WRITERS];

/**
 * The paths a group A tool writes. `null`: not a group A tool. `[]`: a group A tool whose field is
 * missing or not a string (nothing to claim).
 */
export function directWritePaths(input: { tool_name?: string; tool?: string; tool_input?: unknown }): string[] | null {
  const tool = input.tool_name || input.tool;
  const fields = tool ? DIRECT_WRITERS.get(tool) : undefined;
  if (!tool || !fields) return null;
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object') return [];
  const out: string[] = [];
  for (const f of fields) {
    const v = (ti as Record<string, unknown>)[f];
    if (typeof v === 'string' && v) out.push(v);
  }
  return out;
}

/** A claim held by another session: the stored path and every spelling to look for (forward slashes). */
export interface HeldClaim {
  filePath: string;
  /** The session that holds it, for the message. Not read by the match. */
  holder?: string;
  forms: string[];
}

export type ShellVerdict =
  | { kind: 'none' }
  | { kind: 'mention'; filePath: string; holder?: string }
  | { kind: 'deny'; filePath: string; holder?: string };

// Whole-word command cues. A hyphen or word character on either side means a longer word ("cpu", "form").
const CUES =
  '(?:tee|set-content|add-content|out-file|mv|cp|rm|move-item|copy-item|remove-item|' +
  'sed\\s+(?:-[a-z]*i[a-z]*|--in-place)|git\\s+(?:checkout|restore|apply))';
const CUE_RE = new RegExp(`(?<![\\w-])${CUES}(?![\\w-])`, 'gi');

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A path must end at a non-path character: `src/a.ts` is not `src/a.tsx` or `src/a.ts.bak`. */
const END = '(?![\\w.\\-/])';
/** And start at one: `src/a.ts` is not `other/src/a.ts`. */
const START = '(?<![\\w.\\-/])';

/**
 * Classify shell text against the claims other sessions hold. The text is read as a whole: backslashes
 * are folded to slashes, and case is folded when the file system folds it (`fold`).
 */
export function classifyShellText(text: string, claims: readonly HeldClaim[], fold: boolean): ShellVerdict {
  if (!text || claims.length === 0) return { kind: 'none' };
  let t = text.replace(/\\/g, '/');
  if (fold) t = t.toLowerCase();
  let mention: HeldClaim | null = null;
  const cueIndexes: number[] = [];
  CUE_RE.lastIndex = 0;
  for (let m = CUE_RE.exec(t); m; m = CUE_RE.exec(t)) cueIndexes.push(m.index);
  const firstCue = cueIndexes.length ? Math.min(...cueIndexes) : -1;

  for (const claim of claims) {
    const forms = claim.forms.map((f) => f.replace(/\\/g, '/')).map((f) => (fold ? f.toLowerCase() : f)).filter(Boolean);
    if (forms.length === 0) continue;
    const alt = forms.map(escapeRe).join('|');
    // (a) a redirect directly before the path
    if (new RegExp(`>>?\\s*['"]?(?:\\./)?(?:${alt})${END}`).test(t)) return { kind: 'deny', filePath: claim.filePath, holder: claim.holder };
    // (b) a command cue, then the path later in the same text
    const at = new RegExp(`${START}(?:\\./)?(?:${alt})${END}`, 'g');
    let sawPath = false;
    for (let m = at.exec(t); m; m = at.exec(t)) {
      sawPath = true;
      if (firstCue >= 0 && m.index > firstCue) return { kind: 'deny', filePath: claim.filePath, holder: claim.holder };
    }
    if (sawPath && mention === null) mention = claim;
  }
  return mention === null ? { kind: 'none' } : { kind: 'mention', filePath: mention.filePath, holder: mention.holder };
}
