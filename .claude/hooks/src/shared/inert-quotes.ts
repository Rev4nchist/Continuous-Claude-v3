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

/** The [start, end) spans of the quoted strings in an inert segment, or none when the command is not plain under this tool's reading. */
function inertSpans(command: string, tool: Tool): Set<string> {
  const none = new Set<string>();
  if (RUNS_TEXT.test(command) || SPECIAL_STRING.test(command)) return none;
  const spans = quotedSpans(command, tool);
  // A backslash before an opening quote: bash reads \' as a plain quote, so a string the regex pairs may be shell syntax.
  if (spans.some(([s]) => s > 0 && command[s - 1] === '\\')) return none;
  // Every string, quote marks included, becomes spaces. What is left is the text outside the strings.
  const chars = command.split('');
  for (const [s, e] of spans) chars.fill(' ', s, e);
  const masked = chars.join('');
  if (OUTSIDE_RISK.test(masked)) return none;
  // The harmless redirects go first (same length): their & is no segment break, and what is left of > is a file write.
  const cut = masked.replace(HARMLESS_REDIRECT, (r) => ' '.repeat(r.length));
  const out = new Set<string>();
  let from = 0;
  const breaks = [...cut.matchAll(SEGMENT_BREAK)].map((m) => ({ at: m.index!, len: m[0].length }));
  for (const end of [...breaks, { at: cut.length, len: 0 }]) {
    const seg = cut.slice(from, end.at);
    if (seg.trim() !== '') {
      if (seg.includes('>')) return none;
      if (PLAIN_HEAD.test(seg)) { from = end.at + end.len; continue; }
      if (!INERT_HEAD.test(seg)) return none;
      for (const [s, e] of spans) if (s >= from && e <= end.at) out.add(`${s}:${e}`);
    }
    from = end.at + end.len;
  }
  return out;
}

/**
 * The command with the inside of each inert quoted string replaced by spaces. Same length, so an offset in the result is an offset in the command.
 * The quote marks stay, so the quote pairing of the rest of the text does not change.
 */
export function blankInertQuotes(command: string): string {
  // A document heredoc is the whole command, so there is no quoted string left to read.
  const doc = blankDocHeredocBody(command);
  if (doc !== command) return doc;
  const bash = inertSpans(command, 'Bash');
  const pwsh = inertSpans(command, 'PowerShell');
  let out = command;
  for (const id of bash) {
    if (!pwsh.has(id)) continue;
    const [s, e] = id.split(':').map(Number);
    out = out.slice(0, s + 1) + ' '.repeat(e - s - 2) + out.slice(e - 1);
  }
  return out;
}
