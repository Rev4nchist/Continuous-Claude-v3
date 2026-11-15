/**
 * Data strings of a shell command (card coord-file-claims-text-false-match).
 *
 * `classifyShellText` (write-targets.ts) reads a command as one flat text. A held path inside the text that
 * `Add-Content log.md "see src/a.ts"` writes then counts as a write to src/a.ts. This module blanks such STRINGS
 * in a copy of the text, same length, so the cue and path search sees only what the command does.
 *
 * Seat ruling 2026-11-14: an ALLOW list, never a deny list. Text may only tighten the guard by default
 * (memory guard-shell-lexer-arms-race). A string is blanked only when ALL of these hold:
 *   1. The whole text is plain under BOTH quote readings (the Bash and the PowerShell reading of mask-quotes.ts pair
 *      the same spans). Any sign that the pairing may be misread, or that a string becomes a command, keeps the
 *      text as it is: `$(`, a backtick, `<<`, `$'`, `$"`, a smart quote or a control character, a `\` before an opening
 *      quote, a `#` comment, a brace or parenthesis outside a string, an unpaired quote (a here-string with no closer
 *      leaves one).
 *   2. The string sits in a segment (split on ; & | and line ends, outside strings) whose head is on DATA_HEAD: a
 *      command that prints, stores or sends its text and never runs it. EVERY segment of the text must be a data
 *      head or a plain head (cd, Set-Location, git add, git status). One other segment, a known runner (bash -c,
 *      pwsh -Command, node -e, iex, xargs sh -c), a head nobody has listed or an alias redefinition
 *      (`Set-Alias echo iex; echo "rm x"`), keeps every string of the text.
 *   3. The segment is not followed by a pipe. `echo "rm src/a.ts" | sh` hands its text to a shell.
 *   4. The string is not itself a path operand: `keep(content)` (the whole string, trimmed, is a held spelling).
 *      `Set-Content "src/a.ts"` and `> "src/a.ts"` keep the path.
 * A path outside every string is read exactly as before. A string that a data head writes to a file that is run later
 * (a script written with Set-Content and started next) is not seen: this guard is for accidents (seat ruling 2026-11-13).
 *
 * No lexer of its own: the quote readers are the ones the other guards use. The three regexes below repeat the
 * markers of inert-quotes.ts on purpose (importing them would change the dist of every hook that bundles that file).
 */
import { quotedSpans } from './mask-quotes.js';

/** Programs that print, store or send their quoted arguments and never run them. */
const DATA_HEAD = new RegExp(
  String.raw`^\s*(?:add-content|set-content|out-file|echo|write-host|write-output|printf|git\s+commit`
  + String.raw`|node(?:\.exe)?\s+(?:\S*[\\/])?lane\.mjs\s+(?:note|say))(?=\s|$)`,
  'i',
);
// Segments that run nothing from their arguments. They do not stop a neighbour from being a data segment.
const PLAIN_HEAD = /^\s*(?:cd|Set-Location|git\s+(?:add|status))(?=\s|$)/i;
// A backslash before a line end joins two lines in Bash: the segment split would then cut one command in two.
const RUNS_TEXT = /\$\(|`|<<|\$['"]|\\\r?\n/;
// Also a line or page break other than \r \n (a shell may end a statement there; the segment split does not), and a NUL.
const SPECIAL = /[\u{2018}-\u{201F}\0\v\f\x85\u{2028}\u{2029}]/u;
const OUTSIDE_RISK = /[#(){}'"]/;
const SEGMENT_BREAK = /[;&|\r\n]+/g;

export type KeepSpan = (content: string) => boolean;

type Span = [number, number];

/** The strings as spans when both readings pair them the same way, else null. */
function sharedSpans(text: string): Span[] | null {
  const bash = quotedSpans(text, 'Bash');
  const pwsh = quotedSpans(text, 'PowerShell');
  if (bash.length !== pwsh.length || bash.some(([s, e], i) => s !== pwsh[i][0] || e !== pwsh[i][1])) return null;
  // A backslash before an opening quote: bash reads \' as a plain quote, so a string the regex pairs may be shell syntax.
  if (bash.some(([s]) => s > 0 && text[s - 1] === '\\')) return null;
  return bash;
}

/** The text with every string turned into spaces (quote marks too). Offsets stay. */
function maskSpans(text: string, spans: Span[]): string {
  const chars = text.split('');
  for (const [s, e] of spans) chars.fill(' ', s, e);
  return chars.join('');
}

interface Segment { from: number; end: number; piped: boolean }

function segmentsOf(masked: string): Segment[] {
  const out: Segment[] = [];
  let from = 0;
  const breaks = [...masked.matchAll(SEGMENT_BREAK)].map((m) => ({ at: m.index!, sep: m[0] }));
  for (const b of [...breaks, { at: masked.length, sep: '' }]) {
    if (masked.slice(from, b.at).trim() !== '') out.push({ from, end: b.at, piped: b.sep.includes('|') });
    from = b.at + b.sep.length;
  }
  return out;
}

/** Backtick escapes that PowerShell reads as plain characters in a double-quoted string: `n `r `t `` `" `' `0. */
const PWSH_PLAIN_ESCAPE = /^`[nrt`"'0]$/;

/**
 * The text with each listed escape turned into two spaces (same length), when EVERY backtick of the text is a listed escape
 * inside a double-quoted string, as the PowerShell reading pairs the strings. Any other backtick (an unlisted escape,
 * one outside a double-quoted string, one in a single-quoted string) returns the text as it is, and the RUNS_TEXT sign
 * then keeps the whole command. Seat ruling 2026-11-15: an allow list, not a lexer.
 */
function plainPwshEscapes(text: string): string {
  if (!text.includes('`')) return text;
  const inDouble = quotedSpans(text, 'PowerShell').filter(([s]) => text[s] === '"');
  const chars = text.split('');
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`') continue;
    // Both characters of the pair must lie between the opening and the closing quote of one double-quoted string.
    const inside = inDouble.some(([s, e]) => i >= s + 1 && i + 1 <= e - 2);
    if (!inside || !PWSH_PLAIN_ESCAPE.test(text.slice(i, i + 2))) return text;
    chars[i] = ' ';
    chars[i + 1] = ' ';
    i++;
  }
  return chars.join('');
}

/**
 * The command with the inside of each data string replaced by spaces, or the command unchanged when it is not plain
 * (rule 1). Same length, so an offset in the result is an offset in the command. The quote marks stay.
 * `pwsh` is true for the PowerShell tool only: listed backtick escapes inside a double-quoted string are plain text there.
 */
export function blankDataStrings(text: string, keep: KeepSpan, pwsh = false): string {
  const original = text;
  // Card coord-file-guard-named-file: for the PowerShell tool only, a short list of backtick escapes inside a
  // double-quoted string is plain text. Anything else with a backtick keeps the text whole (the check below).
  if (pwsh) text = plainPwshEscapes(text);
  if (RUNS_TEXT.test(text) || SPECIAL.test(text)) return original;
  const spans = sharedSpans(text);
  if (!spans || spans.length === 0) return original;
  const masked = maskSpans(text, spans);
  if (OUTSIDE_RISK.test(masked)) return original;
  const segs = segmentsOf(masked);
  // Every segment must be a data head or a plain head. One other segment (Set-Alias echo iex, a function name, a
  // wrapper, a variable) could redefine a data word or run what an earlier segment stored, so no string is blanked.
  const headOf = (seg: Segment, re: RegExp): boolean =>
    re.test(masked.slice(seg.from, seg.end)) && re.test(text.slice(seg.from, seg.end));
  if (!segs.every((seg) => headOf(seg, DATA_HEAD) || headOf(seg, PLAIN_HEAD))) return original;
  let out = text;
  for (const seg of segs) {
    if (seg.piped || !headOf(seg, DATA_HEAD)) continue;
    for (const [s, e] of spans) {
      if (s < seg.from || e > seg.end || keep(text.slice(s + 1, e - 1))) continue;
      out = out.slice(0, s + 1) + ' '.repeat(e - s - 2) + out.slice(e - 1);
    }
  }
  return out;
}
