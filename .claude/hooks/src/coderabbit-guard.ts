#!/usr/bin/env node
/**
 * CodeRabbit CLI guard (PreToolUse: Bash|PowerShell|Task|Agent|Skill)
 *
 * Advisory CLI only: allow at most 2 `cr review --agent` runs per repo+branch; block billing,
 * API keys, code workspace commands, autofix skill, and skill installs. Read-only commands
 * (doctor, usage, auth login|status, --help, --version) are allowed and never count.
 *
 * A segment is a CodeRabbit CLI call only when its LEADING executable is cr or coderabbit
 * (after env assignments, npx, sudo, xargs, cmd /c, pwsh -c, eval, iex, Start-Process, shell
 * keywords such as then and do, and path prefixes). A segment that only mentions the word (git
 * push of a cr-named branch, cat .coderabbit.yaml) is ignored.
 *
 * Splitting is quote-aware: text inside '...', "...", heredoc bodies and PowerShell here-strings is
 * data, not commands, so a commit message or PR body that talks about CodeRabbit is not a call. A
 * command substitution inside double quotes ($( ) or backticks in Bash) is still code and is
 * scanned. An unclosed quote is a literal character. A heredoc stays inside the segment of the
 * command that receives it, so `bash <<EOF` is read as a script. A wrapper that takes a command
 * string (bash -c, eval, iex) is unwrapped and its inner string is split and classified again.
 *
 * Shell comments are removed before any scan, by the same lexer pass that finds quotes (lexShell): a
 * `#` that starts a word outside quotes runs to the end of the line, and PowerShell `<# ... #>` too. Comment text counts for
 * nothing for parsing and run counting, so `cr review --agent # --version` is a review and `cr doctor # before
 * review` is not. The raw billing check below is the one exception: it reads comments.
 * Help and version are info-only from the call's own options before a bare `--`, never from text
 * after `--`, from a quoted argument, or from a comment. They are free ONLY for a plain call: cr or
 * coderabbit leads its own top-level segment, and the whole command has no comment, line continuation,
 * heredoc, here-string, substitution, subshell, brace or backtick, and the segment holds no newline.
 * Any other call that names `review` counts one run even with --help or --version (when unsure, count).
 * A non-plain read-only call (`sudo cr doctor`) still counts 0 unless its text holds the word review.
 *
 * Line continuations are joined before anything else, as the shell does (joinContinuations): Bash
 * removes backslash-newline outside single quotes, PowerShell does the same for backtick-newline. The
 * joined text goes to the lexer and every later stage. A command that had a continuation is never plain.
 *
 * A raw billing check runs first, on the unstripped text, and does not depend on parsing or comment
 * stripping (rawBilling). If the command holds a cr or coderabbit word (.exe, .cmd, .bat, .ps1 shims
 * too) and --use-credits or the api-key flag in any quoting, the call is denied. The only exemption: every cr
 * word sits in the argument text of a segment that leads with git or gh (commit and PR text). A cr
 * word in a comment is never exempt, and text-only commands (grep, echo, cat, Set-Content) are denied
 * too. To write a test payload that names these flags, use the Write tool, not a shell command.
 *
 * A second raw scan reads only a segment whose leading program runs its text (a shell, eval, iex,
 * Start-Process, Start-Job, xargs, sudo, env, nohup, time, timeout, watch, find, ForEach-Object) or is
 * cr or coderabbit. If that raw text names cr and later review, and parsing found no call, it counts
 * one run. A segment that starts with grep, rg, echo, cat, git or gh only holds text and is not
 * counted. This scan over-reports inside an executing program on purpose, so a wrapper the parser
 * does not know cannot hide a call.
 *
 * Out of scope (adversarial evasion, not accidents): a variable or $( ) that holds the flag, aliases
 * and functions, git or gh aliases and `git -c alias.x=...`, a rebase exec step, a script file run
 * later, a quote-split flag (`--use-"credits"`), and encoded commands. The real billing control is
 * usage billing set to Off on the CodeRabbit account (AC1). This guard only stops accidents.
 *
 * Known limits (best effort, not a sandbox):
 * - The run key follows the last `cd` in the command, not the directory of each review. It only
 *   moves a count between branches; the cap can get stricter or shift and never unlocks paid use.
 * - A script piped into a shell (`echo cr review | bash`) is not read.
 * - A loop body is counted once. `for i in 1 2 3; do cr review --agent; done` uses one slot.
 * - The run counter is a read-modify-write without a lock. Two sessions on one branch that start
 *   at the same moment can both pass. A failed state write also allows the run and does not count it.
 *   Both fail open on purpose: the guard must never break a tool call.
 * - Runs are counted at PreToolUse time. The guard never sees the result, so failed and
 *   rate-limited runs still use a slot.
 *
 * Answer-key check: a counted review run (Bash, PowerShell, or a Task or Agent that carries the command) is denied when its diff may
 * hold an answer-key path (scripts/github/lib/answer-paths.mjs, the frozen four globs). The check reads git, never the run-cap key:
 * the commits against refs/heads/main and refs/remotes/fork/main, the working tree (staged, unstaged, untracked), and every base,
 * --dir, --config and --remote the command names. It runs unless the target is positively another repo (root resolved, remotes read,
 * every remote a host-form URL that is not CCv3); a repo with no remote, a local-path remote or a git error is checked or denied.
 * A deny holds the count of matched paths, never a path, and its log line holds no command text. The override lifts the run cap only.
 * Any error before or inside the check denies a command that holds a cr word followed by review (failClosed).
 *
 * Known limits of the answer-key check:
 * - Wrappers outside EXECUTING_PROGRAMS are not read: `node -e "..."`, `python -c "..."`. A shell tool other than Bash or PowerShell is not read.
 * - A review started with `Start-Process -WorkingDirectory`, `git -C`, `env -C` or `xargs -I` can run in a folder the check does not see.
 * - Time: the git calls of one check share a 30 s budget (each call 10 s at most). After an allow, repoBranchKey adds at most four 10 s
 *   git calls. The worst case is 70 s, so the hook registration must set a timeout above 70 s (use 90 s).
 *
 * Override: SKIP_CODERABBIT_GUARD=1 as a LEADING assignment (or `$env:SKIP_CODERABBIT_GUARD=1;` in
 * PowerShell). Each use writes an 'override' line to the guard decision log.
 *
 * Output contract: ALWAYS exit 0; blocks use permissionDecision deny via shared/output.ts.
 */
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { outputContinue, outputDeny } from './shared/output.js';
import { logGuardDecision } from './shared/guard-log.js';
// A side-effect-free lib (esbuild bundles it; it holds no isDirectRun). Typed by src/shared/answer-paths.d.ts.
import { ANSWER_KEY_GLOBS, answerKeyCheck, matchGlob, slashLower } from '../../../scripts/github/lib/answer-paths.mjs';

const BASH_TOOLS = new Set(['Bash', 'PowerShell']);
const DELEGATE_TOOLS = new Set(['Task', 'Agent', 'Skill']);

const STATE_BASENAME = 'coderabbit-guard-runs.json';
const MAX_RUNS = 2;
const OVERRIDE = /^\s*(?:SKIP_CODERABBIT_GUARD=1\s|\$env:SKIP_CODERABBIT_GUARD\s*=\s*1\s*[;\n])/;

export interface PreToolUseInput {
  session_id?: string;
  tool_name?: string;
  /** Working directory of the session. Subagents report their own. */
  cwd?: string;
  tool_input?: {
    command?: string;
    skill?: string;
    subagent_type?: string;
    prompt?: string;
    description?: string;
  };
}

export interface RunState {
  /** repo#branch -> count of allowed review runs (no command text stored). */
  counts: Record<string, number>;
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CCV3_CODERABBIT_GUARD_STATE || join(tmpdir(), STATE_BASENAME);
  return base;
}

export function readState(path: string): RunState {
  try {
    if (!existsSync(path)) return { counts: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunState>;
    return { counts: parsed?.counts && typeof parsed.counts === 'object' ? parsed.counts : {} };
  } catch {
    return { counts: {} };
  }
}

/** Write to a temp file in the same directory, then rename over the target. */
export function writeState(path: string, state: RunState): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, path);
  } catch {
    // best-effort counter
    try {
      unlinkSync(tmp);
    } catch {
      /* no temp file left */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Splitting a command line into the commands it runs
// ---------------------------------------------------------------------------------------------

/** Stands in for quoted text. It is never a separator. The original text is still read from the segment. */
const FILL = '\u0000';

interface Heredoc {
  delim: string;
  /** `<<-` strips leading tabs from the delimiter line. */
  strip: boolean;
  /** An unquoted delimiter lets the shell run $( ) and backticks in the body. */
  expand: boolean;
}

/** True when `quote` closes somewhere after `from`, skipping escaped characters in double quotes. */
function hasClosing(s: string, from: number, quote: string, esc: string): boolean {
  for (let k = from; k < s.length; k++) {
    if (quote === '"' && s[k] === esc) k++;
    else if (s[k] === quote) return true;
  }
  return false;
}

/** Index of the `)` that closes a `$(` whose body starts at `from`, or -1. */
function closingParen(s: string, from: number): number {
  let depth = 0;
  for (let k = from; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')' && depth-- === 0) return k;
  }
  return -1;
}

/** The result of one lexer pass over a command. All three texts have the length of the source. */
export interface Lexed {
  /** The source with every comment replaced by spaces. Newlines stay. Quoted text is intact. */
  text: string;
  /** `text` with data replaced by FILL: quoted text, heredoc bodies, here-strings. */
  masked: string;
  /** Indexes of separators opened or closed by a substitution inside double quotes. */
  dqSubs: Set<number>;
  /** Indexes of heredoc and here-string body characters. */
  bodies: Set<number>;
  /** Spans [start, end) the shell RUNS: `$( )` and backtick substitutions in every state, also in an expanded heredoc. */
  execs: Array<[number, number]>;
}

/** True when a `#` at `i` starts a word: the start of the text, or after whitespace, `;`, `|`, `&` or `(`. */
function startsWord(command: string, i: number): boolean {
  return i === 0 || /[\s;|&(]/.test(command[i - 1]);
}

/**
 * Join line continuations the way the shell does, BEFORE lexing: Bash removes every backslash-newline
 * (also backslash CRLF) outside single quotes, PowerShell does the same for backtick-newline. The
 * join is quote-aware: a single-quoted string keeps its pair, an escaped escape character (`\\`) is
 * not the start of a pair, and a comment ends at its own newline (the shell does not continue a
 * comment). After the join `foo\` + newline + `# x` is the one word `foo# x`, so the `#` is no
 * comment. Any doubt (an unclosed quote) leaves the text as it is: a pair that stays makes the lexer
 * read more text, never less.
 */
export function joinContinuations(command: string, ps = false): string {
  const esc = ps ? '`' : '\\';
  if (!command.includes(`${esc}\n`) && !command.includes(`${esc}\r\n`)) return command;
  const n = command.length;
  let out = '';
  let quote = '';
  let i = 0;
  while (i < n) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      out += c;
      i++;
    } else if (c === esc) {
      const pair = command.startsWith('\n', i + 1) ? 2 : command.startsWith('\r\n', i + 1) ? 3 : 0;
      if (pair) i += pair;
      else {
        out += command.slice(i, i + 2);
        i += 2;
      }
    } else if (quote === '"') {
      if (c === '"') quote = '';
      out += c;
      i++;
    } else if (c === '#' && startsWord(out, out.length)) {
      const eol = command.indexOf('\n', i);
      const stop = eol < 0 ? n : eol;
      out += command.slice(i, stop);
      i = stop;
    } else if (ps && c === '<' && command[i + 1] === '#') {
      const close = command.indexOf('#>', i + 2);
      const stop = close < 0 ? n : close + 2;
      out += command.slice(i, stop);
      i = stop;
    } else {
      if ((c === "'" && command.indexOf("'", i + 1) > 0) || (c === '"' && hasClosing(command, i + 1, '"', esc))) quote = c;
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * ONE left-to-right pass that tracks every state together: normal, single-quoted, double-quoted
 * (with escapes), `$( )` and backtick substitutions, heredoc bodies, PowerShell here-strings and
 * comments. Two separate passes cannot agree: an apostrophe in a comment would pair with a later
 * quote, and a quoted `#` would then look like a comment start.
 *
 * Comments: a `#` starts one only in normal state at the start of a word. It runs to the end of the
 * line and the newline stays. Quotes and `<<` inside it mean nothing. In PowerShell `<# ... #>` is a
 * block comment, again only in normal state. A `#` inside a word (`a#b`, `$#`, `url#anchor`) stays.
 * Comment text is data: a `--version` or the word `review` there must change nothing.
 *
 * Quoted text, heredoc bodies and here-strings become FILL in `masked`. Command substitutions inside
 * double quotes (and in an unquoted heredoc body) stay readable, because the shell runs them.
 */
export function lexShell(command: string, ps = false): Lexed {
  const n = command.length;
  const text = command.split('');
  const out = command.split('');
  const dqSubs = new Set<number>();
  const bodies = new Set<number>();
  const execs: Array<[number, number]> = [];
  /** Start of each open mode in `modes`, or -1 for a double-quoted string (it runs nothing itself). */
  const starts: number[] = [];
  const closeMode = (end: number): void => {
    const from = starts.pop() ?? -1;
    if (from >= 0) execs.push([from, end]);
  };
  const esc = ps ? '`' : '\\';
  const modes: Array<'dq' | 'sub' | 'bt' | 'dbt'> = [];
  const depths: number[] = [];
  const heredocs: Heredoc[] = [];
  let escEnd = -1;
  const fill = (from: number, to: number): void => {
    for (let k = Math.max(from, 0); k < Math.min(to, n); k++) out[k] = FILL;
  };
  /** Turn a comment into spaces in both outputs. */
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) text[k] = out[k] = ' ';
  };
  /** Mask a body but keep its command substitutions when the shell would run them. */
  const maskBody = (from: number, to: number, expand: boolean): void => {
    let k = from;
    while (k < to) {
      const sub = command.startsWith('$(', k) ? closingParen(command, k + 2) : -1;
      const bt = !ps && command[k] === '`' ? command.indexOf('`', k + 1) : -1;
      const end = sub >= 0 ? sub : bt;
      if (expand && end >= 0 && end < to) {
        execs.push([k, end + 1]);
        k = end + 1;
      } else {
        fill(k, k + 1);
        bodies.add(k);
        k++;
      }
    }
  };
  /** Mask every pending heredoc body, starting after the newline at `from - 1`. Returns the index of the last delimiter line's end. */
  const consumeHeredocs = (from: number): number => {
    let start = from;
    const pending = heredocs.splice(0);
    for (const [at, h] of pending.entries()) {
      let end = start;
      let eol = start;
      while (end < n) {
        eol = command.indexOf('\n', end);
        if (eol < 0) eol = n;
        const line = command.slice(end, eol).replace(/\r$/, '');
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        end = eol + 1;
      }
      const stop = Math.min(eol, n);
      maskBody(start, stop, h.expand);
      if (at < pending.length - 1) fill(stop, stop + 1);
      start = stop + 1;
    }
    return Math.min(start - 1, n);
  };

  let i = 0;
  while (i < n) {
    const c = command[i];
    const top = modes[modes.length - 1];
    if (top === 'dq') {
      if (c === esc) {
        fill(i, i + 2);
        i += 2;
      } else if (c === '"') {
        modes.pop();
        closeMode(i + 1);
        i++;
      } else if (c === '$' && command[i + 1] === '(') {
        dqSubs.add(i);
        modes.push('sub');
        starts.push(i);
        depths.push(0);
        i += 2;
      } else if (c === '`' && !ps) {
        dqSubs.add(i);
        modes.push('dbt');
        starts.push(i);
        i++;
      } else {
        fill(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === '#' && escEnd !== i && startsWord(command, i)) {
      let eol = command.indexOf('\n', i);
      if (eol < 0) eol = n;
      else if (command[eol - 1] === '\r') eol--;
      blank(i, eol);
      i = eol;
    } else if (ps && c === '<' && command[i + 1] === '#') {
      const close = command.indexOf('#>', i + 2);
      const stop = close < 0 ? n : close + 2;
      blank(i, stop);
      i = stop;
    } else if (c === esc) {
      fill(i + 1, i + 2);
      escEnd = i + 2;
      i += 2;
    } else if (c === "'") {
      const j = command.indexOf("'", i + 1);
      if (j > 0) {
        fill(i + 1, j);
        i = j + 1;
      } else i++;
    } else if (c === '"') {
      if (hasClosing(command, i + 1, '"', esc)) {
        modes.push('dq');
        starts.push(-1);
      }
      i++;
    } else if (c === '@' && (command[i + 1] === "'" || command[i + 1] === '"') && /^[ \t]*\r?\n/.test(command.slice(i + 2))) {
      const q = command[i + 1];
      const close = command.indexOf(`\n${q}@`, i + 2);
      if (close < 0) i++;
      else {
        maskBody(i + 2, close, q === '"');
        i = close + 3;
      }
    } else if (!ps && c === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w.-]*))/.exec(command.slice(i, i + 200));
      if (m) {
        heredocs.push({ delim: m[2] ?? m[3] ?? m[4], strip: m[1] === '-', expand: m[2] === undefined && m[3] === undefined && !m[0].includes('\\') });
        i += m[0].length;
      } else i++;
    } else if (c === '\n' && heredocs.length) {
      fill(i, i + 1);
      i = consumeHeredocs(i + 1);
    } else if (c === '$' && command[i + 1] === '(') {
      modes.push('sub');
      starts.push(i);
      depths.push(0);
      i += 2;
    } else if (c === '`' && !ps) {
      if (top === 'dbt') {
        dqSubs.add(i);
        modes.pop();
        closeMode(i + 1);
      } else if (top === 'bt') {
        modes.pop();
        closeMode(i + 1);
      } else {
        modes.push('bt');
        starts.push(i);
      }
      i++;
    } else if (top === 'sub' && (c === '(' || c === ')')) {
      if (c === '(') depths[depths.length - 1]++;
      else if (depths[depths.length - 1] === 0) {
        modes.pop();
        depths.pop();
        closeMode(i + 1);
      } else depths[depths.length - 1]--;
      i++;
    } else i++;
  }
  while (starts.length) closeMode(n);
  return { text: text.join(''), masked: out.join(''), dqSubs, bodies, execs };
}

/**
 * Start and end index of each command segment in `lexed.text`, untrimmed. With `wholeQuotes` a
 * `$( )` or backtick inside double quotes does not split.
 */
function segmentRanges(lexed: Lexed, ps: boolean, wholeQuotes = false): Array<[number, number]> {
  const sep = ps ? /\|\||&&|[;|&\n({}]|\$\(/g : /\|\||&&|[;|&\n({}]|\$\(|`/g;
  const ranges: Array<[number, number]> = [];
  let last = 0;
  for (const m of lexed.masked.matchAll(sep)) {
    if (wholeQuotes && lexed.dqSubs.has(m.index ?? -1)) continue;
    ranges.push([last, m.index ?? 0]);
    last = (m.index ?? 0) + m[0].length;
  }
  ranges.push([last, lexed.text.length]);
  return ranges;
}

/** The non-empty segments with their offsets [start, end) in the comment-free text and trimmed text. */
function segmentSpans(lexed: Lexed, ps: boolean): Array<{ start: number; end: number; text: string }> {
  return segmentRanges(lexed, ps)
    .map(([start, end]) => ({ start, end, text: lexed.text.slice(start, end).trim() }))
    .filter((s) => s.text);
}

/** Split on shell separators and braces. Quoted text and heredoc bodies stay inside their segment. Comments are dropped. */
export function segmentize(command: string, ps = false): string[] {
  return segmentSpans(lexShell(joinContinuations(command, ps), ps), ps).map((s) => s.text);
}

// ---------------------------------------------------------------------------------------------
// Finding the program a segment runs
// ---------------------------------------------------------------------------------------------

export interface Invocation {
  /** Lowercase base name of the executable: no path, no .exe/.cmd/.bat/.ps1. */
  exe: string;
  /** Argument tokens with surrounding quote characters removed. */
  args: string[];
  /** For a wrapper that takes a command string (bash -c, cmd /c, eval, iex): that string, unquoted. */
  nested?: string;
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/;
/** Wrappers whose own options come before the command: skip `-x` tokens, then read the command. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'sudo', 'doas', 'xargs']);
const SHELLS = new Set(['pwsh', 'powershell', 'bash', 'sh', 'zsh']);
const EVALS = new Set(['eval', 'iex', 'invoke-expression']);
const STARTERS = new Set(['start-process', 'saps', 'start']);
/** Words that precede a command and take no argument of their own. */
const PREFIXES = new Set([
  'env', 'command', 'exec', 'nohup', 'time', 'call',
  'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!',
]);

function splitFirst(s: string): { tok: string; rest: string } {
  const m = s.match(/^(?:"([^"]*)"|'([^']*)'|(\S+))\s*([\s\S]*)$/);
  if (!m) return { tok: '', rest: '' };
  return { tok: m[1] ?? m[2] ?? m[3] ?? '', rest: m[4] ?? '' };
}

function baseName(tok: string): string {
  const norm = tok.replace(/\\/g, '/');
  return norm
    .slice(norm.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
}

function cleanToken(t: string): string {
  return t.replace(/^["'`]+|["'`)]+$/g, '');
}

/** Split on whitespace outside quotes: `"# --version"` is one argument, not a flag. */
function tokenize(s: string): string[] {
  return (s.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map(cleanToken).filter(Boolean);
}

function stripLeadingQuote(s: string): string {
  return s.replace(/^\s*["']/, '');
}

/** The command string a wrapper receives: the first quoted string, or the rest of the line. */
function unquoteOuter(s: string): string {
  const t = s.trim();
  const m = t.match(/^"((?:\\.|[^"\\])*)"|^'([^']*)'/);
  return m ? (m[1] ?? m[2] ?? '') : stripLeadingQuote(t);
}

/** `Start-Process cr -ArgumentList review,--agent` and `Start-Process -FilePath cr ...`. */
function parseStarter(rest: string): Invocation {
  const toks = rest.split(/[\s,]+/).map(cleanToken).filter(Boolean);
  const fp = toks.findIndex((t) => /^-filepath$/i.test(t));
  const at = fp >= 0 ? fp + 1 : toks.findIndex((t) => !/^(?:-\S+|\/[a-z]+)$/i.test(t));
  if (at < 0 || !toks[at]) return { exe: 'start-process', args: toks };
  return { exe: baseName(toks[at]), args: toks.filter((_, k) => k !== at) };
}

/**
 * Find the program a segment runs. Skips env assignments, `&`, path prefixes and the wrappers
 * npx, sudo, xargs, env, command, time, timeout and shell keywords. A wrapper that takes a command
 * string (cmd /c, pwsh|bash -c, eval, iex) returns that string as `nested`. Returns null for an
 * empty segment.
 */
export function parseInvocation(segment: string): Invocation | null {
  let s = segment.trim();
  for (let depth = 0; depth < 8; depth++) {
    let prev: string;
    do {
      prev = s;
      s = s.replace(ENV_ASSIGN, '');
    } while (s !== prev);
    s = s.replace(/^&\s*/, '');
    const { tok, rest } = splitFirst(s);
    if (!tok) return null;
    const exe = baseName(tok);
    if (RUNNERS.has(exe)) {
      s = rest.replace(/^(?:-\S+\s+)+/, '');
    } else if (exe === 'cmd') {
      return { exe, args: [], nested: unquoteOuter(rest.replace(/^(?:\/[a-z]\s+)+/i, '')) };
    } else if (SHELLS.has(exe)) {
      const m = rest.match(/(?:^|\s)-(?:c|command|lc)\s+([\s\S]*)$/i);
      if (m) return { exe, args: [], nested: unquoteOuter(m[1]) };
      const doc = rest.match(/<<-?[ \t]*(?:'[^'\n]*'|"[^"\n]*"|\\?[\w.-]+)[ \t]*\r?\n([\s\S]*)$/);
      const here = rest.match(/<<<\s*([\s\S]*)$/);
      if (doc || here) return { exe, args: [], nested: doc ? doc[1] : unquoteOuter(here![1]) };
      return { exe, args: tokenize(rest) };
    } else if (EVALS.has(exe)) {
      return { exe, args: [], nested: unquoteOuter(rest.replace(/^-command\s+/i, '')) };
    } else if (STARTERS.has(exe)) {
      return parseStarter(rest);
    } else if (PREFIXES.has(exe)) {
      s = rest;
    } else if (exe === 'timeout') {
      s = rest.replace(/^(?:-\S+\s+)*\S+\s+/, '');
    } else {
      return { exe, args: tokenize(rest) };
    }
  }
  return null;
}

export function isCrExecutable(exe: string): boolean {
  return exe === 'cr' || exe === 'coderabbit';
}

export function hasForbiddenFlags(args: string[]): string | null {
  for (const a of args) {
    if (/^--use-credits(?:=|$)/i.test(a)) return '--use-credits';
    if (/^--api-key(?:=|$)/i.test(a)) return '--api-key';
  }
  return null;
}

export function isCodeWorkspace(args: string[]): boolean {
  const i = args.findIndex((a) => a.toLowerCase() === 'code');
  return i >= 0 && /^(?:new|push)$/i.test(args[i + 1] ?? '');
}

/** `npx skills add coderabbitai/...` or `coderabbit skills ...`. */
export function isSkillInstall(inv: Invocation): boolean {
  const first = inv.args[0]?.toLowerCase();
  if (/^skills(?:@\S+)?$/.test(inv.exe) && first === 'add') {
    return inv.args.some((a) => /coderabbit/i.test(a));
  }
  return isCrExecutable(inv.exe) && first === 'skills';
}

/** The arguments before a bare `--`. Whatever follows it is data for the program, never an option. */
function optionArgs(args: string[]): string[] {
  const end = args.indexOf('--');
  return end < 0 ? args : args.slice(0, end);
}

function isInfoRequest(args: string[]): boolean {
  return optionArgs(args).some((a) => /^(?:--help|-h|--version)$/i.test(a));
}

/** Read-only subcommands: doctor, usage, auth login, auth status. They never cost a run. */
export function isReadOnlySubcommand(args: string[]): boolean {
  const pos = args.filter((a) => !a.startsWith('-')).map((a) => a.toLowerCase());
  if (pos[0] === 'doctor' || pos[0] === 'usage') return true;
  return pos[0] === 'auth' && (pos[1] === 'login' || pos[1] === 'status');
}

export function isReviewAgent(args: string[]): boolean {
  return args.includes('review') && args.some((a) => a.toLowerCase() === '--agent');
}

export type SegmentVerdict = 'allow' | 'block' | 'ignore';

export interface SegmentClass {
  verdict: SegmentVerdict;
  reason?: string;
  /** True for a `cr review --agent` run: it uses one slot of the run cap. */
  countsRun?: boolean;
  /** How many `cr review --agent` runs the text holds (a wrapper string can hold several). */
  runs?: number;
  /** True for an allowed `--help` call that names `review` (`cr review --help`): it explains the raw review word and costs no run. */
  reviewHelp?: boolean;
  /** The parsed `cr review` calls that count a run: the answer-key check reads their options. */
  invocations?: Invocation[];
  /** True when the raw text of a review holds an option (--base, --dir, -c ...) that no parsed call gives. The check then denies. */
  unaccounted?: boolean;
}

const NOT_ALLOWED =
  'CodeRabbit guard: allowed are `cr review --agent` (<=2 runs per PR), cr doctor, cr usage, cr auth login|status, --help, --version';

function classifyInvocation(inv: Invocation, plain: boolean): SegmentClass {
  if (isSkillInstall(inv)) {
    return { verdict: 'block', reason: 'CodeRabbit guard: CodeRabbit skill installs are forbidden' };
  }
  if (!isCrExecutable(inv.exe)) return { verdict: 'ignore' };

  const forbidden = hasForbiddenFlags(inv.args);
  if (forbidden) return { verdict: 'block', reason: `CodeRabbit guard: ${forbidden} is forbidden` };
  if (isCodeWorkspace(inv.args)) {
    return { verdict: 'block', reason: 'CodeRabbit guard: code new/push is forbidden' };
  }
  if (isInfoRequest(inv.args)) {
    const names = optionArgs(inv.args).some((a) => a.toLowerCase() === 'review');
    // Only a plain call is info-only. Any other call that names review counts one run: when unsure, count.
    if (names && !plain) return { verdict: 'allow', countsRun: true, runs: 1 };
    return { verdict: 'allow', reviewHelp: names };
  }
  if (isReviewAgent(inv.args)) return { verdict: 'allow', countsRun: true, runs: 1 };
  if (isReadOnlySubcommand(inv.args)) return { verdict: 'allow' };
  return { verdict: 'block', reason: NOT_ALLOWED };
}

// ---------------------------------------------------------------------------------------------
// Raw check: billing flags and hidden reviews, independent of how wrappers are parsed
// ---------------------------------------------------------------------------------------------

/** A standalone cr or coderabbit word: after a space, quote, path separator or bracket; not `.coderabbit.yaml`. */
const CR_WORD = /(?:^|[\s"'`(\\/=,{])((?:cr|coderabbit)(?:\.(?:exe|cmd|bat|ps1))?)(?=$|[\s"'`)\\,}])/gi;
const BILLING_WORD = /(?:^|[\s"'`(=,])--(?:use-credits|api-key)(?=$|[\s"'`)=,])/i;
const REVIEW_WORD = /\breview\b/i;
/**
 * Programs that run the text they receive. The raw check reads only a segment that starts with one
 * of these (or with cr or coderabbit). A segment that starts with grep, rg, echo, cat, Set-Content,
 * Select-String and the like only holds text, so a mention of `cr review --use-credits` there is data.
 */
const EXECUTING_PROGRAMS = new Set([
  ...SHELLS, ...EVALS, ...STARTERS, ...RUNNERS, ...PREFIXES,
  'cmd', 'timeout', 'watch', 'find', 'parallel', 'nice', 'setsid', 'wsl',
  'foreach-object', '%', 'start-job', 'sajb', 'start-threadjob', 'invoke-command', 'icm',
]);

export const BILLING_REASON = 'CodeRabbit guard: billing flag with a CodeRabbit CLI call';

function leadingProgram(segment: string): string {
  let s = segment.trim();
  let prev: string;
  do {
    prev = s;
    s = s.replace(ENV_ASSIGN, '').replace(/^&\s*/, '');
  } while (s !== prev);
  return baseName(splitFirst(s).tok);
}

/** Programs whose arguments are commit or PR text: a cr word there is data, not a call. */
const TEXT_COMMANDS = new Set(['git', 'gh']);

/**
 * Fail-closed billing check on the RAW command: no comment stripping, no wrapper parsing. True when
 * the text holds a billing flag and a standalone cr or coderabbit word, unless EVERY cr word sits in
 * the argument text of a segment that leads with git or gh (commit and PR text) and is not executed.
 * A cr word inside a comment, a `$( )` or backtick substitution, or a shell payload is never exempt. The segments are the lexer's, with a `$( )`
 * inside double quotes kept whole, so a commit message built with a heredoc stays one git segment.
 */
export function rawBilling(text: string, ps = false): boolean {
  if (!BILLING_WORD.test(text)) return false;
  const lexed = lexShell(text, ps);
  const ranges = segmentRanges(lexed, ps, true);
  const fine = segmentRanges(lexed, ps);
  for (const m of text.matchAll(CR_WORD)) {
    const at = (m.index ?? 0) + m[0].length - m[1].length;
    const inComment = lexed.text[at] !== text[at];
    const owner = ranges.find(([a, b]) => a <= at && at < b);
    const git = owner !== undefined && TEXT_COMMANDS.has(leadingProgram(lexed.text.slice(owner[0], owner[1])));
    const exempt = !inComment && git && !isExecuted(lexed, fine, at);
    if (!exempt) return true;
  }
  return false;
}

/** Programs that run the text they read: a shell, eval, starter, runner or `cmd`. */
function readsText(program: string): boolean {
  return SHELLS.has(program) || EVALS.has(program) || STARTERS.has(program) || RUNNERS.has(program) || program === 'cmd';
}

/**
 * True when the shell RUNS the text at offset `at`. The text sits in a `$( )` or backtick
 * substitution (any state), or in the part of a finer segment led by a shell, eval or wrapper (a
 * `bash -c` payload or a heredoc such a program reads). A heredoc body inside a substitution is data
 * (`$(cat <<'EOF' ... EOF)`) unless such a program reads it. Single-quoted and plain double-quoted
 * text is data.
 */
function isExecuted(lexed: Lexed, fine: Array<[number, number]>, at: number): boolean {
  const seg = fine.find(([a, b]) => a <= at && at < b);
  if (seg !== undefined && readsText(leadingProgram(lexed.text.slice(seg[0], seg[1])))) return true;
  if (lexed.bodies.has(at)) return false;
  return lexed.execs.some(([a, b]) => a <= at && at < b);
}

export interface RawScan {
  /**
   * The segments with a cr or coderabbit word followed later by the word review. `start` and `end`
   * are the segment's offsets [start, end) in the scanned text. The raw scan keeps a `$( )` inside
   * double quotes in one segment, so it holds the parser's finer segments (see `segmentRanges`).
   */
  reviewSegments: Array<{ start: number; end: number; raw: string }>;
}

/**
 * Read the RAW text of each segment whose leading program runs its text (EXECUTING_PROGRAMS) or is
 * cr or coderabbit: quotes, backticks, `$( )`, -ArgumentList strings and `bash -c` payloads
 * included. It does not parse wrappers, so an unknown wrapper option cannot hide a call. It
 * over-reports inside an executing program (`sh -c "grep 'cr review'"`) on purpose.
 */
export function rawScan(lexed: Lexed, ps = false): RawScan {
  const found: RawScan = { reviewSegments: [] };
  const text = lexed.text;
  // A `$( )` inside double quotes does not split, so a commit message built with a heredoc stays one git segment.
  for (const [a, b] of segmentRanges(lexed, ps, true)) {
    const seg = text.slice(a, b).trim();
    if (!seg) continue;
    const program = leadingProgram(seg);
    if (!EXECUTING_PROGRAMS.has(program) && !isCrExecutable(program)) continue;
    // A heredoc body is data unless a shell, eval or wrapper receives it. `cat <<EOF` prose is not a call.
    const reads = readsText(program);
    const raw = reads ? seg : [...text.slice(a, b)].map((ch, k) => (lexed.bodies.has(a + k) ? ' ' : ch)).join('').trim();
    const first = [...raw.matchAll(CR_WORD)][0];
    if (!first) continue;
    if (REVIEW_WORD.test(raw.slice((first.index ?? 0) + first[0].length))) found.reviewSegments.push({ start: a, end: b, raw });
  }
  return found;
}

/** True when the segment's first token is cr or coderabbit itself: no env assignment, wrapper or keyword before it. */
function leadsWithCr(segment: string): boolean {
  return isCrExecutable(baseName(splitFirst(segment.trim()).tok)) && !segment.includes('\n');
}

/**
 * A "plain" command is the only one whose --help, -h or --version can make a review free. It has no
 * comment, no line continuation, no heredoc or here-string, and no substitution, subshell, brace or
 * backtick that could hide a call. The caller also checks that the call leads its own segment, holds
 * no newline and is not a wrapper payload. Any doubt means not plain, and a review then counts.
 */
function isPlainCommand(source: string, joined: string, lexed: Lexed, ps: boolean): boolean {
  // `source` is the ORIGINAL text: a command that had a continuation is never plain, even once joined.
  if (lexed.text !== joined) return false;
  if (lexed.bodies.size > 0) return false;
  if (ps ? /`\r?\n|@["']/.test(source) : /\\\r?\n|<</.test(source)) return false;
  return !/[(){}`]/.test(lexed.masked);
}

const MAX_NESTING = 4;

/** Classify every command in `text`: a block wins, runs add up, wrapper strings are classified again. */
export function classifyCommand(source: string, ps = false, depth = 0): SegmentClass {
  // Billing first, on the raw text as written and as the shell reads it (continuations joined). It
  // needs no lexing of comments or wrappers. Nested wrapper strings sit inside the outer text.
  const joined = joinContinuations(source, ps);
  if (rawBilling(joined, ps) || (joined !== source && rawBilling(source, ps))) {
    return { verdict: 'block', reason: BILLING_REASON };
  }
  // One lexer pass gives the comment-free text and the quote mask, so both always agree.
  const lexed = lexShell(joined, ps);
  const text = lexed.text;
  // A wrapper string is scanned again, so a mix inside `bash -c "..."` counts per segment too.
  const raw = rawScan(lexed, ps);
  let runs = 0;
  let allowed = false;
  // The raw scan and the parser split the text differently: a quoted `$( )` stays whole in the raw
  // scan and splits for the parser. Each parsed segment sits inside exactly one raw segment, found
  // by source offsets. A raw segment that names a review counts the parsed runs inside it, or one
  // hidden run if the parser found no CodeRabbit call there. It never counts twice.
  const plainCall = depth === 0 && isPlainCommand(source, joined, lexed, ps);
  const hidden = raw.reviewSegments.map((r) => ({ ...r, parsed: 0, covered: false, invs: [] as Invocation[] }));
  const counted: Invocation[] = [];
  let unaccounted = false;
  for (const { start, end, text: seg } of segmentSpans(lexed, ps)) {
    const owner = hidden.find((h) => h.start <= start && end <= h.end);
    const inv = parseInvocation(seg);
    if (!inv) continue;
    let c: SegmentClass;
    if (inv.nested === undefined) c = classifyInvocation(inv, plainCall && leadsWithCr(seg));
    else if (depth < MAX_NESTING) c = classifyCommand(inv.nested, ps, depth + 1);
    else if (/\b(?:cr|coderabbit)\b/i.test(inv.nested)) c = { verdict: 'block', reason: 'CodeRabbit guard: wrapper nesting is too deep to check' };
    else c = { verdict: 'ignore' };
    if (c.verdict === 'block') return c;
    if (c.verdict === 'allow') allowed = true;
    // The parsed review calls this segment counts (a wrapper string brings its own), so the check can read their options.
    const calls = inv.nested === undefined ? ((c.runs ?? 0) > 0 ? [inv] : []) : (c.invocations ?? []);
    counted.push(...calls);
    if (c.unaccounted) unaccounted = true;
    if (!owner) runs += c.runs ?? 0;
    else {
      owner.invs.push(...calls);
      owner.parsed += c.runs ?? 0;
      // Only a help call that fills the whole raw span explains its review word. A help call inside a
      // quoted substitution next to other text can hide a real review in the same span.
      owner.covered ||= c.reviewHelp === true && seg.trim() === text.slice(owner.start, owner.end).trim();
    }
  }
  // The raw scan saw a review in every `hidden` span, so each span counts max(parsed runs, 1). An
  // allowed call that does not name review (`cr --version`) never cancels it. Only `cr review --help`
  // explains the raw review word and lets the span count 0.
  for (const h of hidden) {
    runs += h.parsed > 0 ? h.parsed : h.covered ? 0 : 1;
    // An option in the raw text that the parsed calls do not give (a raw-only hit, or a wrapper the parser did not open) is unread.
    if (rawOptionCount(h.raw) > parsedOptionCount(h.invs)) unaccounted = true;
  }
  if (runs > 0) return { verdict: 'allow', countsRun: true, runs, invocations: counted, unaccounted };
  return { verdict: allowed ? 'allow' : 'ignore', reviewHelp: hidden.some((h) => h.covered) };
}

/** Classify one command line (kept for callers that think in segments). */
export function classifyShellSegment(segment: string, ps = false): SegmentClass {
  return classifyCommand(segment, ps);
}

// ---------------------------------------------------------------------------------------------
// Run counter
// ---------------------------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
}

/**
 * `host/owner/repo` (lowercase) for https, ssh://, scp-style and local remotes. Credentials, port,
 * a `.git` suffix and a trailing slash are dropped, so https and ssh of one repo share one key and
 * a secret never reaches the state file.
 */
export function normalizeRemote(url: string): string {
  const u = url.trim().replace(/\\/g, '/');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/]*@)?([^/:]+)(?::\d*)?\/(.+)$/i.exec(u);
  const scp = /^(?:[^/]*@)?([^/:@]{2,}):(?!\/\/)(.+)$/.exec(u);
  const m = scheme ?? scp;
  const rest = m ? `${m[1]}/${m[2]}` : u;
  return rest.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '').toLowerCase();
}

/** Repo identity from the first remote (any name), else the repo's top-level path. Never a URL with credentials. */
function repoId(root: string): string {
  try {
    const url = git(['config', '--get-regexp', '^remote\\..*\\.url$'], root).split('\n')[0]?.split(/\s+/)[1] ?? '';
    const id = normalizeRemote(url);
    if (id) return id;
  } catch {
    /* no remote */
  }
  return root;
}

/** The branch name, or `detached@<sha>` for a detached HEAD (every `git worktree add --detach` has one). */
function branchId(root: string): string {
  try {
    const branch = git(['symbolic-ref', '--short', '-q', 'HEAD'], root);
    if (branch) return branch;
  } catch {
    /* detached */
  }
  try {
    return `detached@${git(['rev-parse', '--short=12', 'HEAD'], root)}`;
  } catch {
    return 'detached';
  }
}

export function repoBranchKey(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CCV3_CODERABBIT_GUARD_KEY;
  if (fromEnv) return fromEnv;
  try {
    const root = git(['rev-parse', '--show-toplevel'], cwd);
    return `${repoId(root)}#${branchId(root)}`;
  } catch {
    return `cwd#${cwd}`;
  }
}

const CD_SEGMENT = /^(?:cd|chdir|pushd|push-location|set-location|sl)\s+(?:(?:-\w+|\/d)\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/i;

/** The directory the command runs in: the payload cwd, moved by the last `cd <dir>` in the command. */
export function effectiveCwd(command: string, cwd: string, ps = false): string {
  let dir = cwd;
  for (const seg of segmentize(command, ps)) {
    const m = CD_SEGMENT.exec(seg);
    const target = m?.[1] ?? m?.[2] ?? m?.[3];
    // Git Bash writes C:\x as /c/x; node would read that as a path on the current drive.
    if (target && target !== '-') dir = resolve(dir, target.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:'));
  }
  return dir;
}

// ---------------------------------------------------------------------------------------------
// Answer-key check: no CLI review may start on a diff that holds an answer-key path
// ---------------------------------------------------------------------------------------------
//
// The check runs for every counted review run. CCv3 is read from the git remotes of the directory the review runs in, never from the
// run-cap key (an env key or a `cwd#` fallback key is not evidence about the repo). The paths it reads are the union of: the commits
// against main and against fork/main, the working tree (staged, unstaged and untracked), and every base the CLI options name.
// A reason holds the COUNT of matched paths and never a path. Any failure denies: the hook's outer catch allows, so this code has its own.

/** A remote URL of the CCv3 repo (either owner, either repo name, any host). Unanchored on purpose: an odd URL form over-matches and is checked. */
const CCV3_REMOTE = /(?:rev4nchist|parcadei)\/continuous-claude(?:-v3)?/i;
/** The two ranges pre-pr.mjs checks: local main and fork/main. `--no-renames`: a move out of gold/ names the old path too. */
const ANSWER_BASES = ['refs/heads/main', 'refs/remotes/fork/main'];
const ANSWER_GIT_TIMEOUT_MS = 10000;
/** One budget for all git calls of one check, so a stalled disk costs at most this long (the hook timeout must be longer). */
const ANSWER_BUDGET_MS = 30000;
let gitDeadline = 0;
// The log masker reads `key` followed by a word or a colon as a secret name: keep `answer-key` at the end of a sentence.
const DENY_PREFIX = 'CodeRabbit guard:';
const cannotCheck = (why: string): string => `${DENY_PREFIX} ${why}: no CLI review runs on a diff it cannot check for answer-key`;

interface GitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

function gitRun(cwd: string, args: string[]): GitResult {
  const left = gitDeadline - Date.now();
  if (left <= 0) return { ok: false, status: null, stdout: '', stderr: 'budget' };
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: Math.min(ANSWER_GIT_TIMEOUT_MS, left), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  };
}

/** Every path of `range`, or null when git fails, times out or a ref is missing. A null list never means "no paths". */
function diffPaths(root: string, range: string): string[] | null {
  const r = gitRun(root, ['-c', 'core.quotepath=false', 'diff', '--name-only', '--no-renames', '-z', range, '--']);
  return r.ok ? r.stdout.split('\0').filter(Boolean) : null;
}

/**
 * Every path the working tree changes: staged, unstaged and untracked. `status --porcelain=v1 -z` writes `XY to`, and a rename or copy
 * (X or Y is R or C) adds the old path as the next field. Null on a git failure or a record it cannot read.
 */
function statusPaths(root: string): string[] | null {
  const r = gitRun(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!r.ok) return null;
  const fields = r.stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) continue;
    if (rec.length < 4 || rec[2] !== ' ') return null;
    out.push(rec.slice(3));
    if (/[RC]/.test(rec.slice(0, 2))) {
      const old = fields[++i];
      if (!old) return null;
      out.push(old);
    }
  }
  return out;
}

// ---- the CLI options (CLI 0.9.0 `cr review --help`) ----

/** The options that change what a review reads. `-c` also matches an attached value (`-cfile`). Same token boundary as CR_WORD. */
const REVIEW_OPTION = /(?:^|[\s"'`(=,{])(?:--base-commit|--base|--dir|--remote|--config|-c[^\s"'`)=,}]*)(?=$|[\s"'`)=,}])/gi;

function optionCount(text: string): number {
  return [...text.matchAll(REVIEW_OPTION)].length;
}

/** How many of those options a parsed call gives. */
export function parsedOptionCount(invs: Invocation[]): number {
  return invs.reduce((n, inv) => n + optionCount(` ${inv.args.join(' ')}`), 0);
}

/** How many of those options the raw text of a review segment holds after its first cr word (a wrapper's own `-c` comes before it). */
export function rawOptionCount(raw: string): number {
  const first = [...raw.matchAll(CR_WORD)][0];
  return first ? optionCount(` ${raw.slice((first.index ?? 0) + first[0].length)}`) : 0;
}

interface ReviewOptions {
  bases: string[];
  baseCommits: string[];
  dirs: string[];
  configs: string[];
  remotes: string[];
  /** An option with no usable value: the check cannot say what the review reads. */
  bad: boolean;
}

const VALUE_OPTIONS = new Set(['--base', '--base-commit', '--dir', '--remote']);

/** Read the options of the parsed review calls. Only the arguments before a bare `--` are options. */
export function readReviewOptions(invs: Invocation[]): ReviewOptions {
  const o: ReviewOptions = { bases: [], baseCommits: [], dirs: [], configs: [], remotes: [], bad: false };
  const slot: Record<string, string[]> = { '--base': o.bases, '--base-commit': o.baseCommits, '--dir': o.dirs, '--remote': o.remotes, '--config': o.configs };
  for (const inv of invs) {
    const a = optionArgs(inv.args);
    for (let i = 0; i < a.length; i++) {
      const tok = a[i].toLowerCase();
      const eq = /^(--base-commit|--base|--dir|--remote|--config)=(.*)$/.exec(tok);
      if (eq) {
        const value = a[i].slice(eq[1].length + 1);
        if (value) slot[eq[1]].push(value);
        else o.bad = true;
      } else if (VALUE_OPTIONS.has(tok)) {
        const value = a[i + 1];
        if (value === undefined || value.startsWith('-')) o.bad = true;
        else {
          slot[tok].push(value);
          i++;
        }
      } else if (tok === '-c' || tok === '--config') {
        let n = 0;
        while (a[i + 1] !== undefined && !a[i + 1].startsWith('-')) {
          o.configs.push(a[++i]);
          n++;
        }
        if (n === 0) o.bad = true;
      } else if (/^-c./.test(tok) && !tok.startsWith('--')) {
        o.configs.push(a[i].slice(2));
      }
    }
  }
  return o;
}

/** True when a path, or any tail of it that starts at a folder, matches one of the frozen answer-key globs. A folder name matches too. */
function namesAnswerKey(path: string): boolean {
  const segs = slashLower(path).split('/');
  for (let i = 0; i < segs.length; i++) {
    const tail = segs.slice(i).join('/');
    if (ANSWER_KEY_GLOBS.some((g) => matchGlob(slashLower(g), tail) || matchGlob(slashLower(g), `${tail}/_`))) return true;
  }
  return false;
}

/** A config file is sent to the service. Deny an answer-key file, a missing file, and a link that leads to either. */
function configDeny(cwd: string, files: string[]): string | null {
  for (const file of files) {
    const abs = resolve(cwd, file);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return cannotCheck('a --config file cannot be read');
    }
    if (namesAnswerKey(abs) || namesAnswerKey(real)) return `${DENY_PREFIX} a --config file is sent to the service and it is answer-key`;
  }
  return null;
}

/**
 * What a remote URL says about the repo. A host form (`scheme://host/...` or `user@host:path`) that is not CCv3 is positively another
 * repo. A local path (or file://) says nothing, so it is unknown and the check runs.
 */
function remoteKind(url: string): 'ccv3' | 'other' | 'unknown' {
  if (CCV3_REMOTE.test(url)) return 'ccv3';
  if (/^file:/i.test(url)) return 'unknown';
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+\//i.test(url)) return 'other';
  if (/^[^/\\:@\s]+@[^/\\:\s]+:/.test(url)) return 'other';
  return 'unknown';
}

/** Whether `dir` may be a CCv3 checkout (true unless it is positively another repo, or not a repo): false for a folder outside git, a repo with no remote, or another repo. Null: git failed (deny). */
function ccv3Root(dir: string): { root: string } | { skip: true } | null {
  const top = gitRun(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return top.status === 128 && /not a git repository/i.test(top.stderr) ? { skip: true } : null;
  const root = top.stdout.trim();
  if (!root) return null;
  const remotes = gitRun(root, ['config', '--get-regexp', '^remote\\..*\\.url$']);
  if (remotes.status === 1) return { root }; // exit 1: no remote at all, so nothing says it is another repo: check
  if (!remotes.ok) return null;
  const urls = remotes.stdout.split('\n').map((l) => l.trim().split(/\s+/).slice(1).join(' ')).filter(Boolean);
  // Positively not CCv3: the root resolved, the remotes read, there is at least one, and every one is another host-form repo.
  return urls.every((u) => remoteKind(u) === 'other') ? { skip: true } : { root };
}

/** The ranges the check reads in one CCv3 checkout, or a deny reason. Each base the CLI options name must resolve. */
function rangesFor(root: string, opts: ReviewOptions): string[] | string {
  const ranges = ANSWER_BASES.map((b) => `${b}...HEAD`);
  const named: Array<[string, boolean]> = [...opts.bases.map((v): [string, boolean] => [v, false]), ...opts.baseCommits.map((v): [string, boolean] => [v, true])];
  for (const [value, commit] of named) {
    if (value.startsWith('-') || !gitRun(root, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`]).ok) {
      return cannotCheck('a --base or --base-commit value does not resolve to a commit');
    }
    ranges.push(`${value}...HEAD`);
    // A commit on the current branch: the two-dot range reads that commit's own tree, so it never reads fewer paths.
    if (commit) ranges.push(`${value}..HEAD`);
  }
  return ranges;
}

/** The deny reason for one directory, or null (not a CCv3 checkout, or no answer-key path). */
function dirDeny(dir: string, opts: ReviewOptions): string | null {
  const found = ccv3Root(dir);
  if (found === null) return cannotCheck('the git root or the remotes cannot be read');
  if ('skip' in found) return null;
  const ranges = rangesFor(found.root, opts);
  if (typeof ranges === 'string') return ranges;
  const union = new Set<string>();
  for (const range of ranges) {
    const paths = diffPaths(found.root, range);
    if (paths === null) return cannotCheck('git diff failed');
    for (const p of paths) union.add(p);
  }
  const tree = statusPaths(found.root);
  if (tree === null) return cannotCheck('git status failed');
  for (const p of tree) union.add(p);
  const check = answerKeyCheck({ root: found.root, paths: [...union] });
  if (check === null) return null;
  if ('closed' in check) return cannotCheck('the REVIEW.md skip list is not usable');
  return `${DENY_PREFIX} no CLI review may read the paths in the diff (${check.hits.length}) that are answer-key`;
}

// ---- the folder the review runs in ----

const CD_WORD = /^(?:cd|chdir|pushd|popd|push-location|pop-location|set-location|sl)(?=\s|$)/i;

function nestedHasCd(text: string, ps: boolean, depth: number): boolean {
  if (depth > MAX_NESTING) return true;
  for (const seg of segmentize(text, ps)) {
    if (CD_WORD.test(seg.trim())) return true;
    const inv = parseInvocation(seg);
    if (inv?.nested !== undefined && nestedHasCd(inv.nested, ps, depth + 1)) return true;
  }
  return false;
}

/**
 * A deny reason when the folder a review runs in cannot be read from the command: a cd target that holds `~`, `$`, `%` or a backtick
 * (resolve() reads them as plain text), a cd with no target, `cd -`, popd, a cd AFTER the review, a cd inside a wrapper string, or a folder
 * that does not exist. effectiveCwd cannot follow these, so the check could read the wrong repo.
 */
function folderDeny(command: string, ps: boolean, cwd: string): string | null {
  let seenCr = false;
  for (const seg of segmentize(command, ps)) {
    const text = seg.trim();
    if (CD_WORD.test(text)) {
      const m = CD_SEGMENT.exec(text);
      const target = m?.[1] ?? m?.[2] ?? m?.[3];
      if (!target || target === '-' || /[~$%`]/.test(target)) return cannotCheck('a cd target cannot be read');
      if (seenCr) return cannotCheck('a cd comes after the review');
    }
    if ([...text.matchAll(CR_WORD)].length > 0) seenCr = true;
    const inv = parseInvocation(seg);
    if (inv?.nested !== undefined && nestedHasCd(inv.nested, ps, 0)) return cannotCheck('a cd sits inside a wrapper string');
  }
  try {
    if (!statSync(cwd).isDirectory()) return cannotCheck('the folder the review runs in is not a folder');
  } catch {
    return cannotCheck('the folder the review runs in does not exist');
  }
  return null;
}

export interface AnswerKeyRun {
  command: string;
  ps: boolean;
  /** The folder the review runs in (effectiveCwd). */
  cwd: string;
  invocations: Invocation[];
  unaccounted: boolean;
}

/**
 * A deny reason when a review run may read an answer-key path or the check cannot finish, else null. `invocations` are the parsed review
 * calls (their options); `unaccounted` is true when the raw text holds an option that no parsed call gives. Own catch: the outer one allows.
 */
export function answerKeyDeny(run: AnswerKeyRun): string | null {
  try {
    gitDeadline = Date.now() + ANSWER_BUDGET_MS;
    if (run.unaccounted) return cannotCheck('a CLI option in the command cannot be read');
    const folder = folderDeny(run.command, run.ps, run.cwd);
    if (folder) return folder;
    const opts = readReviewOptions(run.invocations);
    if (opts.bad) return cannotCheck('a CLI option has no value');
    if (opts.remotes.some((r) => CCV3_REMOTE.test(r))) {
      return `${DENY_PREFIX} --remote names the CCv3 repo, so the service reads it, answer-key included`;
    }
    const config = configDeny(run.cwd, opts.configs);
    if (config) return config;
    for (const dir of [run.cwd, ...opts.dirs.map((d) => resolve(run.cwd, d))]) {
      const reason = dirDeny(dir, opts);
      if (reason) return reason;
    }
    return null;
  } catch {
    return cannotCheck('the check failed with an error');
  }
}

/** ok is true when `runs` more runs still fit under the cap. */
export function checkRunCap(state: RunState, key: string, runs = 1): { ok: boolean; count: number } {
  const count = state.counts[key] ?? 0;
  return { ok: count + runs <= MAX_RUNS, count };
}

export function recordRun(state: RunState, key: string, runs = 1): RunState {
  const count = (state.counts[key] ?? 0) + runs;
  return { counts: { ...state.counts, [key]: count } };
}

export function isReadOnlyAutofixDelegate(input: PreToolUseInput): boolean {
  const text = [input.tool_input?.prompt, input.tool_input?.description].filter(Boolean).join('\n');
  if (!/autofix/i.test(text)) return false;
  if (!/read[- ]only/i.test(text)) return false;
  return true;
}

export function classifySkill(input: PreToolUseInput): { verdict: SegmentVerdict; reason?: string } {
  const skill = String(input.tool_input?.skill ?? '');
  if (!skill) return { verdict: 'ignore' };
  if (/^coderabbit:autofix$/i.test(skill) || skill.toLowerCase().includes('coderabbit:autofix')) {
    return { verdict: 'block', reason: 'CodeRabbit guard: coderabbit:autofix skill is forbidden' };
  }
  return { verdict: 'ignore' };
}

export function classifyDelegate(input: PreToolUseInput): { verdict: SegmentVerdict; reason?: string } {
  const skill = classifySkill(input);
  if (skill.verdict === 'block') return skill;
  if (isReadOnlyAutofixDelegate(input)) return { verdict: 'allow' };
  const cmd = input.tool_input?.command;
  if (cmd) return classifyCommand(cmd);
  return { verdict: 'ignore' };
}

export interface DecideResult {
  allow: boolean;
  reason?: string;
  increment?: boolean;
  /** True for a deny from the answer-key check: the log holds no command text for it. */
  answerKey?: boolean;
}

/** Test seam: the two steps that can throw before the answer-key check. */
export interface DecideSeam {
  classify?: (source: string, ps?: boolean) => SegmentClass;
  cwdOf?: (command: string, cwd: string, ps?: boolean) => string;
}

/** A cr or coderabbit word followed later by the word review: the raw rule of rawScan, with no lexer. */
function rawReview(command: string): boolean {
  const first = [...command.matchAll(CR_WORD)][0];
  return !!first && REVIEW_WORD.test(command.slice((first.index ?? 0) + first[0].length));
}

/** The answer-key result for a review run (the verdict counts at least one run), or null. A deny uses no run slot. */
function answerKeyResult(input: PreToolUseInput, command: string, ps: boolean, verdict: SegmentClass, seam: DecideSeam): DecideResult | null {
  // A blocked review (the override lifted the block) has no parsed calls: any option in its raw text counts as unread.
  const blockedReview = (verdict.runs ?? 0) === 0 && verdict.verdict === 'block' && rawReview(command);
  if ((verdict.runs ?? 0) === 0 && !blockedReview) return null;
  const cwd = (seam.cwdOf ?? effectiveCwd)(command, input.cwd || process.cwd(), ps);
  const unaccounted = verdict.unaccounted === true || (blockedReview && rawOptionCount(command) > 0);
  const reason = answerKeyDeny({ command, ps, cwd, invocations: verdict.invocations ?? [], unaccounted });
  return reason ? { allow: false, reason, answerKey: true } : null;
}

function decideChecked(input: PreToolUseInput, env: NodeJS.ProcessEnv, seam: DecideSeam): DecideResult {
  const tool = input.tool_name || '';
  const command = input.tool_input?.command || '';
  const ps = tool === 'PowerShell';
  const classify = seam.classify ?? classifyCommand;
  const runsCommand = BASH_TOOLS.has(tool) || (DELEGATE_TOOLS.has(tool) && tool !== 'Skill' && command !== '');

  // The override lifts the run cap only. A review that may read an answer-key path is denied even with it.
  if (OVERRIDE.test(command)) {
    const denied = runsCommand ? answerKeyResult(input, command, ps, classify(command, ps), seam) : null;
    if (denied) return denied;
    logGuardDecision('coderabbit-guard', input, 'override', 'SKIP_CODERABBIT_GUARD=1', { command, env });
    return { allow: true };
  }

  if (tool === 'Skill') {
    const s = classifySkill(input);
    if (s.verdict === 'block') return { allow: false, reason: s.reason };
    return { allow: true };
  }

  if (DELEGATE_TOOLS.has(tool)) {
    const d = classifyDelegate(input);
    if (d.verdict === 'block') return { allow: false, reason: d.reason };
    // A Task or Agent that carries a review command gets the same answer-key check as a Bash call. It counts no run.
    // The command is classified here, not through `d`: a read-only autofix prompt returns allow from classifyDelegate before it reads the command.
    return (command ? answerKeyResult(input, command, false, classify(command, false), seam) : null) ?? { allow: true };
  }

  if (!BASH_TOOLS.has(tool)) return { allow: true };

  const verdict = classify(command, ps);
  if (verdict.verdict === 'block') return { allow: false, reason: verdict.reason };
  const runs = verdict.runs ?? 0;
  if (runs === 0) return { allow: true };

  // The check decides from git, not from the cap key, and runs before the cap, so a deny uses no slot.
  const denied = answerKeyResult(input, command, ps, verdict, seam);
  if (denied) return denied;
  const cwd = (seam.cwdOf ?? effectiveCwd)(command, input.cwd || process.cwd(), ps);
  const key = repoBranchKey(cwd, env);
  const path = statePath(env);
  const state = readState(path);
  const cap = checkRunCap(state, key, runs);
  if (!cap.ok) {
    return {
      allow: false,
      reason: `CodeRabbit guard: run cap reached (${cap.count} of ${MAX_RUNS} cr review --agent runs used for ${key}; this command adds ${runs})`,
    };
  }
  writeState(path, recordRun(state, key, runs));
  return { allow: true, increment: true };
}

/**
 * An error before or inside the check must not turn a review into an allow (the hook's outer catch allows). A command that holds a cr or
 * coderabbit word and later the word review is denied; any other command, which has no review to check, is allowed.
 */
function failClosed(input: PreToolUseInput): DecideResult {
  const command = input.tool_input?.command || '';
  const reviewTool = BASH_TOOLS.has(input.tool_name || '') || (DELEGATE_TOOLS.has(input.tool_name || '') && input.tool_name !== 'Skill');
  if (reviewTool && command && rawReview(command)) {
    return { allow: false, reason: cannotCheck('the command could not be read'), answerKey: true };
  }
  return { allow: true };
}

export function decide(input: PreToolUseInput, env: NodeJS.ProcessEnv = process.env, seam: DecideSeam = {}): DecideResult {
  try {
    return decideChecked(input, env, seam);
  } catch {
    return failClosed(input);
  }
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

/** The deny line of the guard log. An answer-key deny logs no command text: the command can name a path or a folder. */
export function logDeny(input: PreToolUseInput, result: DecideResult, env: NodeJS.ProcessEnv = process.env): void {
  logGuardDecision('coderabbit-guard', input, 'deny', result.reason || 'blocked', result.answerKey ? { env } : { command: input.tool_input?.command, env });
}

function main(): void {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(readStdin());
  } catch {
    outputContinue();
    return;
  }

  const result = decide(input);
  if (!result.allow) {
    logDeny(input, result);
    outputDeny(result.reason || 'CodeRabbit guard: blocked');
    return;
  }
  outputContinue();
}

if (!process.env.VITEST) {
  try {
    main();
  } catch {
    outputContinue();
  }
}
