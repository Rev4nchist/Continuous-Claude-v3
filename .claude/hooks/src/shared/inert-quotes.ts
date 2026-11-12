/**
 * Quoted text that only a harmless command prints, sends or stores is not a command: `node lane.mjs add x --title "gh pr create for fix"`
 * names a create, it does not run one. The gates that read a command for `gh pr create`, `land-pr.ps1` or `gh pr merge` call blankInertQuotes
 * first, so those words in such a string no longer count.
 *
 * Fail closed. The whole command is left as it is unless ALL of these hold. The tests are regexes on text masked by the shared maskQuoted
 * rules. There is no shell lexer.
 *   1. The text has no sign that the quote pairing may be misread, or that text becomes a command:
 *      - a command substitution or a form that runs text: `$(`, a backtick, `<<` (here-doc), `@'` or `@"` (here-string)
 *      - an ANSI-C or locale string `$'` `$"`, a smart quote (PowerShell treats U+2018..U+201F as quote marks), a `#` comment
 *        outside a string (an apostrophe in a comment pairs with a later quote), a `\` before an opening quote
 *      - a brace or parenthesis outside a string (a function body, a subshell, a process substitution)
 *      - a quote mark left unpaired outside the strings
 *   2. EVERY segment (split on ; & | and line ends, outside quotes) opens with a word from INERT_HEAD (print, commit, send, store)
 *      or PLAIN_HEAD (cd, git add, git status: they run nothing from their arguments), and writes no file (no > except a harmless
 *      one). One other segment (a wrapper, eval, iex, a variable, Set-Alias, a function name, a pipe target, a script run later)
 *      keeps every string as it is. So no earlier segment can redefine an inert word and no later segment can run what it stored.
 *   3. Bash and PowerShell BOTH read the same string in the same way. They pair quotes differently around \" and a doubled quote,
 *      and one reading may show a real command where the other shows one string.
 * Only the strings in INERT_HEAD segments are blanked.
 */
import { quotedSpans } from './mask-quotes.js';
import { blankDocHeredocBody } from './doc-heredoc.js';

type Tool = 'Bash' | 'PowerShell';

// What each program does with a quoted argument: it prints it (echo, printf, Write-*), stores it (git commit, lane add/note/say), sends it
// (curl, ntn, gh comment) or hands it to a model as a prompt (claude). None of them runs it as a command.
// A file writer (Set-Content, tee, a redirect) is NOT here: the text may become a script that runs later.
const INERT_HEAD = new RegExp(
  String.raw`^\s*(?:echo|printf|Write-(?:Host|Output|Warning|Information)|git\s+commit|claude|ntn|curl|gh\s+(?:pr|issue)\s+comment`
  + String.raw`|node(?:\.exe)?\s+(?:\S*[\\/])?lane\.mjs\s+(?:add|note|say))(?=\s|$)`,
  'i',
);
// Segments that run nothing from their arguments. Their strings are not blanked, but they do not stop a neighbour from being inert.
const PLAIN_HEAD = /^\s*(?:cd|Set-Location|git\s+(?:add|status))(?=\s|$)/i;
const SEGMENT_BREAK = /[;&|\r\n]+/g;
// A redirect that writes no file: 2>&1, >&2, >/dev/null, 2>$null, >nul. The target must end at a space or a separator:
// `>nul\..\x.ps1` and `>/dev/null/../x` name a real file.
const HARMLESS_REDIRECT = /\d*>&\d+|&>\s*\/dev\/null(?=[\s;&|]|$)|\d*>>?\s*(?:\/dev\/null|\$null|nul)(?=[\s;&|]|$)/gi;

const RUNS_TEXT = /\$\(|`|<<|@['"]/;
// Also a line or page break other than \r \n (a shell may end a statement there; the segment split does not), and a NUL.
const SPECIAL_STRING = /\$['"]|[\u{2018}-\u{201F}\0\v\f\x85\u{2028}\u{2029}]/u;
const OUTSIDE_RISK = /[#(){}'"]/;

/**
 * A head counts only when it matches BOTH the masked segment and the raw segment. The mask turns every quoted string into spaces, so a quoted
 * word before the head (`"pwsh" "-File" "x" cat`), a quoted git option (`git "-c" "core.pager=x" log`) or a quote glued to the head (`cat"x"`)
 * would leave a bare head in the masked text. In the raw text the head is not first, or not a whole word, so it does not match.
 */
function headMatches(head: RegExp, masked: string, raw: string): boolean {
  return head.test(masked) && head.test(raw);
}

/** One non-blank segment of a plain command: its [from, end) offsets in the command, and its text with every quoted string blanked. */
interface PlainSegment { from: number; end: number; masked: string }

/**
 * The quoted spans and the non-blank segments of a command, or null when the command is not plain under this tool's reading
 * (condition 1 of the header, and no file write). The callers then judge the heads of the segments.
 */
function plainSegments(command: string, tool: Tool): { spans: [number, number][]; segs: PlainSegment[] } | null {
  if (RUNS_TEXT.test(command) || SPECIAL_STRING.test(command)) return null;
  const spans = quotedSpans(command, tool);
  // A backslash before an opening quote: bash reads \' as a plain quote, so a string the regex pairs may be shell syntax.
  if (spans.some(([s]) => s > 0 && command[s - 1] === '\\')) return null;
  // Every string, quote marks included, becomes spaces. What is left is the text outside the strings.
  const chars = command.split('');
  for (const [s, e] of spans) chars.fill(' ', s, e);
  const masked = chars.join('');
  if (OUTSIDE_RISK.test(masked)) return null;
  // The harmless redirects go first (same length): their & is no segment break, and what is left of > is a file write.
  const cut = masked.replace(HARMLESS_REDIRECT, (r) => ' '.repeat(r.length));
  const segs: PlainSegment[] = [];
  let from = 0;
  const breaks = [...cut.matchAll(SEGMENT_BREAK)].map((m) => ({ at: m.index!, len: m[0].length }));
  for (const end of [...breaks, { at: cut.length, len: 0 }]) {
    const seg = cut.slice(from, end.at);
    if (seg.trim() !== '') {
      if (seg.includes('>')) return null;
      segs.push({ from, end: end.at, masked: seg });
    }
    from = end.at + end.len;
  }
  return { spans, segs };
}

/** The [start, end) spans of the quoted strings in an inert segment, or none when the command is not plain under this tool's reading. */
function inertSpans(command: string, tool: Tool, openHead?: RegExp): Set<string> {
  const none = new Set<string>();
  const plain = plainSegments(command, tool);
  if (!plain) return none;
  const out = new Set<string>();
  for (const { from, end, masked } of plain.segs) {
    const raw = command.slice(from, end);
    if (headMatches(PLAIN_HEAD, masked, raw)) continue;
    // The one gated command (a PR open): its strings stay as they are. Every other segment must still be inert or plain.
    if (openHead !== undefined && headMatches(openHead, masked, raw)) continue;
    if (!headMatches(INERT_HEAD, masked, raw)) return none;
    for (const [s, e] of plain.spans) if (s >= from && e <= end) out.add(`${s}:${e}`);
  }
  return out;
}

// Programs that only print or read what they are given. None runs an argument as a command.
// rg is NOT here (--pre and --hostname-bin start a program). git show is not either (not asked for).
const TEXT_HEAD = /^\s*(?:echo|printf|Write-(?:Host|Output))(?=\s|$)/i;
const READ_HEAD = /^\s*(?:grep|cat|head|tail|Select-String|sls|Get-Content|gc|git\s+log)(?=\s|$)/i;
// git log --output=<file> writes a file. Any option that starts with --ou is refused (git also takes an abbreviation).
// Looked for in the segment with its quote marks and backslashes removed: a quoted "--output" is still an option.
const OPTION_TRAP = /(?:^|\s)--ou/i;
const DASH_LOOKALIKE = /[–—―]/;

/**
 * True when the command only prints or reads text and can run nothing: both quote readings find it plain (see plainSegments), and EVERY segment opens
 * with a text head, a read head or a plain head, written bare (no path, no VAR= prefix, no git global option, so no redefined or wrapped head).
 * Fail closed: a pipe or chain to any other word, a substitution, a here-doc, a function, a comment, a `>` or an unpaired quote returns false.
 * The caller must also know the tool: this reads the command as Bash or PowerShell text, and cmd.exe reads it differently.
 */
export function isTextOnlyCommand(command: string): boolean {
  // PowerShell reads U+2013, U+2014 and U+2015 as a dash, so `\u2013Pr 12` is a parameter that no ASCII test sees. Refuse the exemption.
  if (DASH_LOOKALIKE.test(command)) return false;
  for (const tool of ['Bash', 'PowerShell'] as const) {
    const plain = plainSegments(command, tool);
    if (!plain) return false;
    for (const { from, end, masked } of plain.segs) {
      const raw = command.slice(from, end);
      if (!(headMatches(PLAIN_HEAD, masked, raw) || headMatches(TEXT_HEAD, masked, raw) || headMatches(READ_HEAD, masked, raw))) return false;
      if (OPTION_TRAP.test(raw.replace(/["'\\]/g, ''))) return false;
    }
  }
  return true;
}

/**
 * The command with the inside of each inert quoted string replaced by spaces. Same length, so an offset in the result is an offset in the command.
 * The quote marks stay, so the quote pairing of the rest of the text does not change.
 */
export function blankInertQuotes(command: string, tool?: string): string {
  // Only the Bash and PowerShell readings of a quote are known. Desktop Commander may run the text in cmd.exe, where ' is a plain character and
  // & separates commands (`echo 'a & land-pr.ps1 -Pr 12 & rem '` runs the land). Any other named tool keeps every string as it is.
  if (tool !== undefined && tool !== 'Bash' && tool !== 'PowerShell') return command;
  // A document heredoc is the whole command, so there is no quoted string left to read. Only the Bash tool: PowerShell and cmd have no
  // heredoc, and a desktop-commander REPL may run each line on its own, so there the body lines are commands.
  if (tool === 'Bash') {
    const doc = blankDocHeredocBody(command);
    if (doc !== command) return doc;
  }
  return blankSpans(command, inertSpans(command, 'Bash'), inertSpans(command, 'PowerShell'));
}

/** Blank the strings that Bash and PowerShell BOTH read as inert. */
function blankSpans(command: string, bash: Set<string>, pwsh: Set<string>): string {
  let out = command;
  for (const id of bash) {
    if (!pwsh.has(id)) continue;
    const [s, e] = id.split(':').map(Number);
    out = out.slice(0, s + 1) + ' '.repeat(e - s - 2) + out.slice(e - 1);
  }
  return out;
}

/**
 * blankInertQuotes for a command that holds a gated open (openHead matches its segment). The strings of the open segment stay as they are.
 * The strings of the other segments are blanked when each of them is an inert or plain head. Used by the PR gate to read the body flags of the open
 * itself: `echo 'note --body here' ; gh pr create --body-file f` has one body file, f. Same fail closed rules as blankInertQuotes, and the same
 * rule for a tool other than Bash or PowerShell (cmd.exe may run the text, so every string stays). The command is returned as it is when any
 * segment is neither inert, plain nor the open.
 */
export function blankInertQuotesAround(command: string, tool: string | undefined, openHead: RegExp): string {
  if (tool !== undefined && tool !== 'Bash' && tool !== 'PowerShell') return command;
  return blankSpans(command, inertSpans(command, 'Bash', openHead), inertSpans(command, 'PowerShell', openHead));
}
