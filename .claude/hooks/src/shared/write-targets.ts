/**
 * Which file does a tool call write? Used by file-claims (card coord-file-claims-all-writers, gap 3, rule O3.1).
 *
 * Group A: the tool input names the path. Edit, Write, NotebookEdit and three Desktop Commander tools.
 * `directWritePaths` reads the field. No parsing.
 *
 * Group B: the tool input is shell text. There is NO lexer here (memory guard-shell-lexer-arms-race).
 * The match is a needle search built from a path that another live session HOLDS:
 *   (a) a redirect: ">" or ">>", optional spaces, an optional quote, then the path. The ">" must not follow
 *       "-" or "=" (so `->` and `=>` are no redirect). A ">" that is not directly before the path is no cue
 *       (`2>&1`, `> scratch.txt`, `2>/dev/null`).
 *   (b) a command cue as a whole word (tee, Set-Content, mv, git checkout ...) with the path LATER in the text.
 *       "/" and "." count as word characters, so `bin/rm`, `cp.mjs` and `tee.ts` are no cue.
 *       The text-wide cue is the seat's ruling 2026-11-13 11:21: a split on ";" or "&&" would miss
 *       `sed -i 's/a;b/c/' <held>`. So `rm -f out.log; cat <held>` DENIES. That is a known false deny.
 *       Exception: cp or Copy-Item with the held path as its FIRST operand only reads it: a mention.
 *   Anything else that holds the path is a mention. A mention never denies.
 * Not seen (Known limits): a path built at run time (variable, glob, `cd` then a bare name outside the cwd,
 * a script that writes the file, `node -e`), `perl -pi`, `prettier --write`, `git -C`, `../x`, `~/`, `$HOME`,
 * `/mnt/c/...`, and git stash, reset, merge and rebase, which change files without naming them.
 * Text above SIZE_CAP is not scanned (the call continues).
 *
 * Two gates: the matcher in settings.json.template and the runtime gate in file-claims.ts must name the same
 * tools (guard: hook-matcher-runtime-consistency.test.ts). `SHELL_WRITERS` and `DIRECT_WRITERS` are the list.
 */
import { SHELL_TOOLS } from './shell-tools.js';
import { blankDataStrings } from './data-spans.js';

const DC = 'mcp__plugin_desktop-commander_desktop-commander__';

/** Tool name -> the tool_input fields that hold a path the tool writes. move_file: destination FIRST (review F9). */
export const DIRECT_WRITERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['Edit', ['file_path']],
  ['Write', ['file_path']],
  ['NotebookEdit', ['notebook_path']],
  [`${DC}write_file`, ['path']],
  [`${DC}edit_block`, ['file_path']],
  [`${DC}move_file`, ['destination', 'source']],
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
  /** The claim's project key, for the warn-once key. Not read by the match. */
  project?: string;
  /** Spellings whose case is exact (folded only when the file system folds case). */
  forms: string[];
  /** Spellings that came from the LOWER-CASED project key: always matched in any case. */
  ciForms?: string[];
}

export type ShellVerdict =
  | { kind: 'none' }
  | { kind: 'mention'; filePath: string; holder?: string; project?: string }
  | { kind: 'deny'; filePath: string; holder?: string; project?: string; cue: string };

/** Above this the text is not scanned: a huge pasted script is not a write by name, and the scan stays cheap. */
export const SIZE_CAP = 64 * 1024;

interface CueDef { name: string; src: string; firstOperandReads?: boolean }

// "/" and "." are word characters for the boundary: `bin/rm`, `cp.mjs`, `tee.ts` are no cue.
const B_START = '(?<![\\w./-])';
const B_END = '(?![\\w./-])';
const CUE_DEFS: readonly CueDef[] = [
  { name: 'tee', src: 'tee' },
  { name: 'tee-object', src: 'tee-object' },
  { name: 'set-content', src: 'set-content' },
  { name: 'add-content', src: 'add-content' },
  { name: 'clear-content', src: 'clear-content' },
  { name: 'out-file', src: 'out-file' },
  { name: 'mv', src: 'mv' },
  { name: 'move', src: 'move' },
  { name: 'move-item', src: 'move-item' },
  { name: 'cp', src: 'cp', firstOperandReads: true },
  { name: 'copy', src: 'copy', firstOperandReads: true },
  { name: 'copy-item', src: 'copy-item', firstOperandReads: true },
  { name: 'rm', src: 'rm' },
  { name: 'del', src: 'del' },
  { name: 'erase', src: 'erase' },
  { name: 'ri', src: 'ri' },
  { name: 'remove-item', src: 'remove-item' },
  // Flags before -i are allowed (`sed -E -i`, `sed -e x -i`). [a-hj-z] leaves out "i". The script after -e or -f
  // may not start with "-" (?!-), so a bare "-e" token has ONE parse: a flag. Without that, "-e -e -e ..." split
  // in exponentially many ways (CR 11-13 major).
  { name: 'sed -i', src: 'sed\\s+(?:(?:-[ef]\\s+(?!-)\\S+|-[a-hj-z]+)\\s+)*(?:-[a-z]*i[a-z]*(?:\\.\\w+)?|--in-place(?:=\\S+)?)' },
  { name: 'git checkout', src: 'git\\s+checkout' },
  { name: 'git restore', src: 'git\\s+restore' },
  { name: 'git apply', src: 'git\\s+apply' },
  { name: 'safe-replace', src: 'node\\s+\\S*safe-replace\\.mjs' },
];
const CUE_RE = new RegExp(
  `${B_START}(?:${CUE_DEFS.map((d, i) => `(?<c${i}>${d.src})`).join('|')})${B_END}`,
  'gi',
);

interface CueHit { index: number; end: number; def: CueDef }

function cuesIn(t: string): CueHit[] {
  const hits: CueHit[] = [];
  CUE_RE.lastIndex = 0;
  for (let m = CUE_RE.exec(t); m; m = CUE_RE.exec(t)) {
    const g = m.groups ?? {};
    const i = CUE_DEFS.findIndex((_, k) => g[`c${k}`] !== undefined);
    hits.push({ index: m.index, end: m.index + m[0].length, def: CUE_DEFS[Math.max(i, 0)] });
    if (m[0].length === 0) CUE_RE.lastIndex++;
  }
  return hits;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A path must end at a non-path character: `src/a.ts` is not `src/a.tsx` or `src/a.ts.bak`. */
const PATH_END = '(?![\\w.\\-/])';
/** And start at one: `src/a.ts` is not `other/src/a.ts`. */
const PATH_START = '(?<![\\w.\\-/])';
/** Between a cp-style cue and its first operand: flags, spaces, an optional quote. */
const FIRST_OPERAND_GAP = /\s+(?:-\S+\s+)*['"]?/y;

/** The index where the first operand of a cue starts (after flags and a quote), or -1. */
function firstOperandAt(t: string, cueEnd: number): number {
  FIRST_OPERAND_GAP.lastIndex = cueEnd;
  const m = FIRST_OPERAND_GAP.exec(t);
  if (!m) return -1;
  // A named -Destination (or -Dest, -De) is the copy TARGET: its operand is no source (CR 11-13 major).
  if (/(?:^|\s)-de(?:s(?:t\w*)?)?(?=\s)/i.test(m[0])) return -1;
  return cueEnd + m[0].length;
}

/** One spelling for comparing a whole string with a held path: slashes, no outer space, no leading "./". */
const spellingOf = (s: string): string => s.replace(/\\/g, '/').trim().replace(/^\.\//, '');

/** True when the string, as a whole, is one spelling of a held file. A case-insensitive form matches in any case. */
function isHeldSpelling(content: string, claims: readonly HeldClaim[], fold: boolean): boolean {
  const s = spellingOf(content);
  if (!s) return false;
  const lower = s.toLowerCase();
  return claims.some((c) =>
    c.forms.some((f) => (fold ? spellingOf(f).toLowerCase() === lower : spellingOf(f) === s))
    || (c.ciForms ?? []).some((f) => spellingOf(f).toLowerCase() === lower));
}

/**
 * Classify shell text against the claims other sessions hold. The text is read as a whole: backslashes
 * are folded to slashes, and case is folded when the file system folds it (`fold`).
 */
export function classifyShellText(text: string, claims: readonly HeldClaim[], fold: boolean): ShellVerdict {
  if (!text || claims.length === 0 || text.length > SIZE_CAP) return { kind: 'none' };
  // A held path inside text that a data head prints or stores is no write (card coord-file-claims-text-false-match).
  // A string that IS a held path stays: it is the operand of the write.
  text = blankDataStrings(text, (s) => isHeldSpelling(s, claims, fold));
  let t = text.replace(/\\/g, '/');
  if (fold) t = t.toLowerCase();
  const tl = t.toLowerCase();
  const cues = cuesIn(t);
  let mention: HeldClaim | null = null;

  for (const claim of claims) {
    const exact = claim.forms.map((f) => f.replace(/\\/g, '/')).map((f) => (fold ? f.toLowerCase() : f)).filter(Boolean);
    const ci = (claim.ciForms ?? []).map((f) => f.replace(/\\/g, '/').toLowerCase()).filter(Boolean);
    for (const [hay, forms] of [[t, exact], [tl, ci]] as Array<[string, string[]]>) {
      if (forms.length === 0) continue;
      const alt = forms.map(escapeRe).join('|');
      // (a) a redirect directly before the path, not after - or =
      if (new RegExp(`(?<![-=])>>?\\s*['"]?(?:\\./)?(?:${alt})${PATH_END}`).test(hay)) {
        return { kind: 'deny', filePath: claim.filePath, holder: claim.holder, project: claim.project, cue: '>' };
      }
      // (b) a command cue, then the path later in the same text
      const at = new RegExp(`${PATH_START}(?:\\./)?(?:${alt})${PATH_END}`, 'g');
      let sawPath = false;
      for (let m = at.exec(hay); m; m = at.exec(hay)) {
        sawPath = true;
        const armed = cues.find((c) => c.index < m.index && !(c.def.firstOperandReads && firstOperandAt(t, c.end) === m.index));
        if (armed) {
          return { kind: 'deny', filePath: claim.filePath, holder: claim.holder, project: claim.project, cue: armed.def.name };
        }
      }
      if (sawPath && mention === null) mention = claim;
    }
  }
  return mention === null
    ? { kind: 'none' }
    : { kind: 'mention', filePath: mention.filePath, holder: mention.holder, project: mention.project };
}
