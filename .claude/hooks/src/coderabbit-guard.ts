#!/usr/bin/env node
/**
 * CodeRabbit CLI guard (PreToolUse: Bash|PowerShell|Task|Agent|Skill)
 *
 * Advisory CLI only: allow at most 2 `cr review --agent` runs per repo+branch; block billing,
 * API keys, code workspace commands, autofix skill, and skill installs. Read-only commands
 * (doctor, usage, auth login|status, --help, --version) are allowed and never count.
 *
 * The parser calls a segment a CodeRabbit CLI call when its LEADING executable is cr or coderabbit
 * (after env assignments, npx, sudo, xargs, cmd /c, pwsh -c, eval, iex, Start-Process, shell
 * keywords such as then and do, and path prefixes). A segment that only mentions the word (git
 * push of a cr-named branch, cat .coderabbit.yaml) is ignored. The call rule below adds the calls
 * the parser cannot read. The runners sudo, doas and xargs skip their own options with values
 * (`sudo -u root`, `xargs -n 1`); a folder option (`sudo -D`) marks the call as moved.
 *
 * Splitting is quote-aware: text inside '...', "...", heredoc bodies and PowerShell here-strings is
 * data, not commands, so a commit message or PR body that talks about CodeRabbit is not a call. A
 * command substitution inside double quotes ($( ) or backticks in Bash) is still code and is
 * scanned. An unclosed quote is a literal character. A heredoc stays inside the segment of the
 * command that receives it, so `bash <<EOF` is read as a script. A wrapper that takes a command
 * string (bash -c, eval, iex) is unwrapped and its inner string is split and classified again.
 *
 * Shell comments are removed before any scan, by the same parser reading that finds quotes (lexedFromReading): a
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
 * THE CALL RULE (round 3). A second raw scan (rawScan) finds every call the parser may miss, and the SAME rule gates the run count and the
 * answer-key check. A cr or coderabbit word (after baseName, so `coderabbit@latest` counts) followed by the word review is a call when:
 * - it is NOT in quotes: anywhere in the command, behind any program, also inside `$( )` and backticks (`echo cr review` is a call); or
 * - it IS in quotes and the segment hands that string to a program that runs it (Start-Process, wsl, watch, ssh, parallel, Start-Job,
 *   ForEach-Object, Invoke-Command); the shells and evals that invocationOf opens (`bash -c`, `bash -ec`, `eval`, `iex`, `cmd /c`,
 *   `pwsh -Command`) are not scanned here, their inner string is read again by this same rule. A wrapper the parser does not peel
 *   (`nice`, `env -i`, `timeout -k 5 60`, `winpty`, `stdbuf`, `find -exec`) is searched for an unquoted shell, eval, starter or string-runner
 *   word: from there a `-c` string that holds a call makes the quoted cr word a call (runsQuotedString). A shell with no -c gets a script
 *   path (`bash run.sh "cr review"`): data. PowerShell with no -c takes its first argument as a command: a call.
 * Any other quoted cr word is DATA for its program and is no call, uses no run slot and gets no answer-key check: `grep -n "cr review"`,
 * `find docs -exec grep -l "cr review" {} +`, `npx vitest -t "cr review"`, `xargs grep 'cr review'`, `bash -c "grep 'cr review' docs"`.
 * A parsed cr call stays a call even when its program word is quoted (`"cr" review`, `& "C:/x/cr.exe" review`). A call with no parsed cr
 * call behind it (`npm exec coderabbit review`, `winpty cr review`, `$(command -v cr) review`, `& (Get-Command cr) review`, `env -C x cr
 * review`) is UNPLACED: the check cannot say in which folder it runs. See the answer-key check.
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
 * Answer-key check (an ALLOW LIST, rounds 2 and 3): a counted review run (the Bash or PowerShell tool) is denied when its diff may hold an
 * answer-key path (scripts/github/lib/answer-paths.mjs, the frozen four globs). The check reads git, never the run-cap key.
 * A Task or Agent payload carries `prompt`, not `command`: a prompt is never checked for a review call (the autofix rule reads prompt and
 * description for its own purpose only). What the guard sees is the Bash or PowerShell call of the subagent itself. Only a Task or Agent
 * payload that has a tool_input.command (none known today) gets the same check, and it counts no run.
 *
 * Which repo: a folder is skipped only when git resolves its root, no remote is CCv3 AND HEAD has no scripts/eval/review-eval tree. A CCv3
 * mirror or a renamed fork is checked; a folder outside git, and a foreign repo (with or without a remote), are skipped. A git error denies.
 * A repo with no commit yet has no HEAD tree: the folder itself decides (a review-eval folder in it means checked).
 *
 * In a CCv3 checkout a counted review passes in ONE shape only: a single plain `cr review ...` or `coderabbit review ...` call, alone or
 * after ONE plain `cd <literal folder that exists>` joined by `&&` or `;`, with options from the CLI 0.9.0 help list, each with a
 * literal value, and a literal --base or --base-commit that resolves. The allow test (parseShape, per tool) is strict on the raw text: tokens
 * of [A-Za-z0-9._/:=-] (a cd target may start with ~, expanded through the home folder of the env), or such a token in simple quotes around
 * the whole token (a space is allowed inside quotes). Any other character ($ % backtick @ { } ( ) a pipe, a quote inside a token, a
 * comment, a newline) fails it. So does any wrapper, keyword, runner or second cd. Everything that is not that shape is denied with ONE
 * way-out text: run the review as its own plain command with --base <ref>. The text names the cause when it knows one.
 * The cd word: Bash has `cd` in lower case only (no `CD`, no `chdir`). PowerShell also takes `Set-Location` and `sl` in any case, with an
 * optional -Path or -LiteralPath, and a backslash in the cd target (a path character there). In Bash a backslash fails the shape (use /). A
 * cd target must be fixed: absolute, `.`, `..`, or start with `./`, `../` or `~`; a bare name could move through CDPATH. The `/c/x` form
 * is rewritten to C:\x for Bash only: PowerShell reads it as C:\c\x. With `;` the review runs even when the cd fails, so the start folder
 * (cwd) is checked as well as the cd target; with `&&` only the target is. A non-shape command that changes folder checks both.
 * Options that read more than the diff: every --base and --base-commit (X...HEAD and X..HEAD both), the main and fork/main ranges, the
 * working tree (staged, unstaged, untracked), every --dir, every -c or --config file (a folder or an answer-key file is denied) and
 * --remote (a literal owner/repo, and not the CCv3 repo). `--deep` is a flag only: a focus text after it is not part of the shape.
 * The SKIP_CODERABBIT_GUARD=1 prefix is cut before the shape test. A deny holds the count of matched paths, never a path. A log row of
 * this check holds no cwd and no command text, and every reason ENDS with the words answer-key (the log masker turns a later word into ***).
 * A missing refs/remotes/fork/main (or refs/heads/main) is named in the deny text.
 * SKIP_CODERABBIT_GUARD lifts the run cap, and the billing and block denies, as on main. It NEVER lifts the answer-key check.
 * Any error before or inside the check denies a command that holds a cr word followed by review (failClosed).
 *
 * Folders (rule R5): a review the check cannot place in a folder is denied with the way-out text in EVERY folder, a foreign repo or a folder
 * outside git too. That is: an UNPLACED call (the call rule above: no parsed cr call stands for it, as with `watch`, `find -exec`, `npm exec`,
 * `env -C x cr review`, `env --chdir`, `$(command -v cr)`), a parsed call that a wrapper option moves (`Start-Process -WorkingDirectory`, `sudo -D`),
 * a cd inside a wrapper string (`bash -ec 'cd <ccv3> && cr review'`), and a cd the folder step cannot follow (`$VAR`, `cd -`, a cd after the
 * review). A wrapper the parser opens and places in the session folder (`sudo -u root cr review`, `xargs -n 1 cr review`, `time cr review`,
 * `bash -c "cr review"`) passes in a foreign folder and counts its run. A review with an option the parser cannot read is denied in a foreign
 * folder too (`unaccounted`), as it may hide a --dir into CCv3. The way out is a plain cd first, then the plain call.
 *
 * Known limits of the answer-key check (open before registration):
 * - A shell tool other than Bash and PowerShell is not read. A program that takes a string and is neither a shell, eval, starter nor in
 *   STRING_RUNNERS is not read as a call when the cr word is quoted: `node -e "..."`, `python -c "..."`.
 * - A clone whose remote is not CCv3 and whose branch deleted scripts/eval/review-eval is skipped as a foreign repo (ccv3Root, HEAD tree test).
 * - A base that the CLI resolves as a remote-tracking ref (`origin/x`) is read through `rev-parse` by name; the CLI may resolve it another way.
 * - Submodules, and a symlink committed into the gold folder, are not followed.
 * - A script piped into a shell (`echo cr review | bash`) is not read.
 * - A run-cap deny and a block deny (billing flag, not the answer-key check) still log the command head and the cwd, as on main.
 * - VITEST in the session env turns the whole hook off (the main() gate at the end of this file).
 * - The hook has no registration yet, so no timeout is enforced. The registration card MUST set a hook timeout and test it: 60 s or more.
 * - Time: the git calls and file checks of one check share a 30 s budget (each git call 10 s at most; the budget is read before every
 *   git call, realpathSync and statSync). After an allow, repoBranchKey reads its (at most four) git calls under its own 10 s budget, the same
 *   gitRun deadline. The worst case is 40 s, under the 45 s the registration timeout must beat.
 *
 * Override: SKIP_CODERABBIT_GUARD=1 as a LEADING assignment (or `$env:SKIP_CODERABBIT_GUARD=1;` in
 * PowerShell). Each use writes an 'override' line to the guard decision log. It does not lift the answer-key check.
 *
 * Output contract: ALWAYS exit 0; blocks use permissionDecision deny via shared/output.ts.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { outputContinue, outputDeny } from './shared/output.js';
import { logGuardDecision } from './shared/guard-log.js';
import { parseCalls, BASH_KINDS_NOTE, BASH_KINDS_EXTRA, PWSH_KINDS, type Call, type ParseOpts, type ParseResult, type Word } from './shared/shell-ast.js';
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

/** True when `quote` closes somewhere after `from`, skipping escaped characters in double quotes. */
function hasClosing(s: string, from: number, quote: string, esc: string): boolean {
  for (let k = from; k < s.length; k++) {
    if (quote === '"' && s[k] === esc) k++;
    else if (s[k] === quote) return true;
  }
  return false;
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
  /** The parser's calls of this text (none from a payload). Absent on the plain facts of a text nobody read: a scan then counts, it never skips. */
  calls?: Call[];
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
  /** True when a wrapper option moves the program to another folder (`Start-Process -WorkingDirectory`, `sudo -D`). The check cannot place it. */
  moves?: boolean;
  /** True when the program word has no literal value (`$X review`, `$(echo cr) review`). `exe` is empty. Rule U1 reads it. Only invocationOf sets it. */
  unreadable?: boolean;
  /** True for a shell that reads its script from a stdin the call list cannot read (`bash < file`, `bash <&3`). Only invocationOf sets it. */
  stdinUnknown?: boolean;
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/;
/** Wrappers whose own options come before the command: skip `-x` tokens, then read the command. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'sudo', 'doas', 'xargs']);
/** Short options of a runner that take the NEXT token as their value (`sudo -u root`, `xargs -n 1`). Without this the value would read as the program. */
const RUNNER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-U', '-t', '-T', '-r', '-C', '-D', '-R']),
  doas: new Set(['-u', '-C']),
  xargs: new Set(['-n', '-L', '-P', '-s', '-d', '-E', '-a', '-I']),
};
const SHELLS = new Set(['pwsh', 'powershell', 'bash', 'sh', 'zsh']);
/** Shells whose single-letter options combine with -c (`bash -ec 'cmd'`, `sh -xc 'cmd'`). */
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh']);
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

/** The program name of a token: no path, no `@version` suffix (`coderabbit@latest`), no .exe/.cmd/.bat/.ps1. */
function baseName(tok: string): string {
  const norm = tok.replace(/\\/g, '/');
  return norm
    .slice(norm.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/^["'`]+/, '')
    .replace(/(?<=.)@.*$/, '')
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
}

function cleanToken(t: string): string {
  return t.replace(/^["'`]+|["'`)]+$/g, '');
}

// ---------------------------------------------------------------------------------------------
// Parser-based reader (coord-guard-shell-parser PR A, commit 2). Built BESIDE the hand readers above and below; each group of commit 2 moves a
// stage onto it and the hand reader of that stage is deleted. Plan: .claudedocs/e2e-coord-guard-shell-parser/44-commit2-plan.md.
// ---------------------------------------------------------------------------------------------

/** One reading of a command text: the parser's call list, or the reason it could not be read. */
export interface Reading {
  ok: boolean;
  /** True when the READER failed (wasm, the parser threw, no tree, the pwsh child) and not the text (a syntax error). */
  reader: boolean;
  msg?: string;
  /** Milliseconds the read took. The E3 deny line logs it. */
  ms: number;
  result?: ParseResult;
}

/** The node kinds of the parser and the walker that the guard reads (the judge's list, rule F5). */
const KNOWN_KINDS = new Set<string>([...BASH_KINDS_NOTE, ...BASH_KINDS_EXTRA, ...PWSH_KINDS]);

let readMemo = new Map<string, Promise<Reading>>();

/** Start of a decide: each text is parsed once per decide, however many stages read it (a PowerShell parse is a child process). */
export function resetReadings(): void {
  readMemo = new Map();
}

async function readUncached(text: string, ps: boolean, opts: ParseOpts): Promise<Reading> {
  // performance.now, not Date.now: the time-budget rows of the answer-key tests count Date.now calls.
  const t0 = performance.now();
  try {
    // noNested: this guard peels its own wrappers (sudo, npx, env, timeout) and reads a payload string itself, so each text is parsed once.
    const result = await parseCalls(text, ps ? 'pwsh' : 'bash', { noNested: true, ...opts });
    const ms = Math.round(performance.now() - t0);
    if (result.ok) {
      // Rule F5 of the judge: a node kind the walker does not list may hide a call, so the text is not read (E8).
      const unknown = result.kinds.filter((k) => !KNOWN_KINDS.has(k));
      if (unknown.length > 0) return { ok: false, reader: false, msg: `node kinds not on the list: ${unknown.join(', ')}`, ms };
      return { ok: true, reader: false, ms, result };
    }
    const first = result.errors[0];
    return { ok: false, reader: first?.reader === true, msg: first?.msg, ms };
  } catch (e) {
    return { ok: false, reader: true, msg: String(e), ms: Math.round(performance.now() - t0) };
  }
}

let readerSeam: ParseOpts = {};

/** Test seam: reader options (a failing provider, a short timeout) that every read of the guard uses until `setReaderSeam({})`. Rows E1 to E9 use it. */
export function setReaderSeam(opts: ParseOpts): void {
  readerSeam = opts;
  resetReadings();
  resetLexCache();
}

/** Read `text` with the shell parser. A read with test seams (`opts`, or the reader seam) is not memoised. Never throws. */
export function readCommand(text: string, ps: boolean, opts: ParseOpts = {}): Promise<Reading> {
  const eff = { ...readerSeam, ...opts };
  if (Object.keys(eff).length > 0) return readUncached(text, ps, eff);
  const key = `${ps ? 'p' : 'b'}:${text}`;
  let p = readMemo.get(key);
  if (!p) {
    p = readUncached(text, ps, opts);
    readMemo.set(key, p);
  }
  return p;
}

const wordText = (w: Word): string => w.lit ?? w.raw;
/** A word the shell read as a quoted string (`"..."`, `'...'`, `$"..."`, here-string). The walker does not set Word.quoted for a plain quoted word. */
export const isQuotedWord = (w: Word): boolean => /^(?:\$?["']|@["'])/.test(w.raw);
const POSIX_C_CLUSTER = /^-[a-z]*c[a-z]*$/i;
const PS_C_FLAG = /^-(?:c|command|lc)$/i;

/** The text of one quoted word, unquoted as the shell does. */
function quotedValue(w: Word): string {
  if (w.lit !== null) return w.lit;
  // The parser gives no literal for a double-quoted word that holds an escaped quote (`"bash -c \"cr review\""`). Unquote it as the shell does:
  // drop the outer quotes and the backslash of \" and \\ (the rule the old hand reader used).
  const m = /^\$?"((?:\\.|[^"\\])*)"$|^\$?'([^']*)'$/.exec(w.raw);
  return m ? (m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1') : (m[2] ?? '')) : w.raw;
}

/** The command string a wrapper receives, from the words after its -c flag: a quoted first word, else every word joined (the rest of the line). */
function payloadWords(after: Word[]): string {
  if (after.length === 0) return '';
  const first = after[0];
  if (!isQuotedWord(first)) return after.map(wordText).join(' ');
  return quotedValue(first);
}

/**
 * The command string of Bash `eval`: every argument, unquoted, joined with one space, as the shell does (`eval 'echo' ';' 'cr review'` runs
 * `echo ; cr review`). `bash -c` is not like this: its first word is the script and the rest are positional parameters (payloadWords).
 */
function evalPayload(after: Word[]): string {
  return after.map((w) => (isQuotedWord(w) ? quotedValue(w) : wordText(w))).join(' ');
}

function skipRunnerWords(exe: string, rest: Word[], moves: { on: boolean }): Word[] {
  const values = RUNNER_VALUE_FLAGS[exe];
  let ws = rest;
  for (;;) {
    const tok = ws[0]?.lit;
    if (tok === undefined || tok === null || !tok.startsWith('-') || tok === '-') return ws;
    if (tok === '--') return ws.slice(1);
    if (exe === 'sudo' && /^(?:-[DR]|--chdir|--chroot)/.test(tok)) moves.on = true;
    ws = values?.has(tok) ? ws.slice(2) : ws.slice(1);
  }
}

/** `Start-Process cr -ArgumentList review,--agent` and `Start-Process -FilePath cr ...`, over words. */
function starterFromWords(rest: Word[]): Invocation {
  const moves = rest.some((w) => /^-wo\w*$/i.test(w.lit ?? ''));
  const fp = rest.findIndex((w) => /^-filepath$/i.test(w.lit ?? ''));
  const split = (ws: Word[]): string[] => ws.flatMap((w) => wordText(w).split(/[\s,]+/)).map(cleanToken).filter(Boolean);
  // A -FilePath value may hold spaces (`"C:\Program Files\CodeRabbit\cr.exe"`): its word is read whole.
  if (fp >= 0 && rest[fp + 1]) return { exe: baseName(wordText(rest[fp + 1])), args: split(rest.filter((_, k) => k !== fp && k !== fp + 1)), moves };
  const toks = split(rest);
  const at = toks.findIndex((t) => !/^(?:-\S+|\/[a-z]+)$/i.test(t));
  if (at < 0 || !toks[at]) return { exe: 'start-process', args: toks, moves };
  return { exe: baseName(toks[at]), args: toks.filter((_, k) => k !== at), moves };
}

/**
 * The Invocation a parsed call stands for: the same peeling as the old hand reader (env words, runners, `timeout`, shell keywords, `cmd /c`,
 * `bash -c`, `eval`, `iex`, Start-Process), over the parser's words instead of a text split. A program word with no literal value (`$X`,
 * `$(echo cr)`) gives `unreadable: true` and an empty exe: rule U1 decides it. Null for a call with no words.
 */
export function invocationOf(call: Call): Invocation | null {
  const moves = { on: false };
  let ws = call.words;
  const done = (inv: Invocation): Invocation => (moves.on ? { ...inv, moves: true } : inv);
  for (let depth = 0; depth < 8; depth++) {
    if (ws.length === 0) return null;
    if (ws[0].lit === null) return done({ exe: '', args: ws.slice(1).map(wordText), unreadable: true });
    const exe = baseName(ws[0].lit);
    const rest = ws.slice(1);
    if (RUNNERS.has(exe)) {
      ws = skipRunnerWords(exe, rest, moves);
    } else if (exe === 'cmd') {
      let at = 0;
      while (at < rest.length && /^\/[a-z]$/i.test(rest[at].lit ?? '')) at++;
      return done({ exe, args: [], nested: payloadWords(rest.slice(at)) });
    } else if (SHELLS.has(exe)) {
      const at = rest.findIndex((w) => (POSIX_SHELLS.has(exe) ? POSIX_C_CLUSTER.test(w.lit ?? '') || /^-command$/i.test(w.lit ?? '') : PS_C_FLAG.test(w.lit ?? '')));
      if (at >= 0) return done({ exe, args: [], nested: payloadWords(rest.slice(at + 1)) });
      // The shell reads its script from stdin. A stdin the call list cannot read (`< file`, `<&3`, a heredoc with a substitution) is unknown, and
      // classifyCommand denies it when the text holds a review (never reads it as empty).
      if (call.stdin) return done({ exe, args: [], nested: call.stdin.lit ?? '', ...(call.stdin.lit === null ? { stdinUnknown: true } : {}) });
      return done({ exe, args: rest.map(wordText) });
    } else if (EVALS.has(exe)) {
      const after = /^-command$/i.test(rest[0]?.lit ?? '') ? rest.slice(1) : rest;
      return done({ exe, args: [], nested: exe === 'eval' ? evalPayload(after) : payloadWords(after) });
    } else if (STARTERS.has(exe)) {
      return done(starterFromWords(rest));
    } else if (PREFIXES.has(exe)) {
      ws = rest;
    } else if (exe === 'timeout') {
      let at = 0;
      while (at < rest.length && (rest[at].lit ?? '').startsWith('-')) at++;
      ws = rest.slice(at + 1);
    } else {
      return done({ exe, args: rest.map(wordText) });
    }
  }
  return null;
}

/**
 * Quote and escape spans INSIDE ONE parser word, as [from, to, kind) offsets in the word's raw text. The parser already decided where the word
 * starts and ends, so this scan reads no shell structure: it only finds the quotes and the escape characters of one word. It errs only toward
 * deny (seat ruling 15:58): any doubt (an unclosed quote, a dangling escape) returns null and the caller treats the whole word as unquoted, so
 * a cr word in it counts as a call. `fill` spans hold quoted or escaped text (data); `dq` is a double-quoted span (a `$( )` inside it is code).
 */
export function quoteSpans(raw: string, ps: boolean): Array<{ from: number; to: number; kind: 'fill' | 'dq' | 'esc' }> | null {
  const esc = ps ? '`' : '\\';
  const out: Array<{ from: number; to: number; kind: 'fill' | 'dq' | 'esc' }> = [];
  const n = raw.length;
  if (/^@['"]/.test(raw)) {
    // A PowerShell here-string: the body is data.
    const q = raw[1];
    const close = raw.lastIndexOf(`${q}@`);
    if (close <= 2) return null;
    out.push({ from: 2, to: close, kind: q === '"' ? 'dq' : 'fill' });
    return out;
  }
  let i = 0;
  while (i < n) {
    const c = raw[i];
    if (c === esc) {
      if (i + 1 >= n) return null;
      out.push({ from: i + 1, to: i + 2, kind: 'esc' });
      i += 2;
    } else if (c === "'") {
      let j = i + 1;
      for (;;) {
        j = raw.indexOf("'", j);
        if (j < 0) return null;
        // PowerShell doubles a quote inside single quotes.
        if (ps && raw[j + 1] === "'") j += 2;
        else break;
      }
      out.push({ from: i + 1, to: j, kind: 'fill' });
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && raw[j] !== '"') j += raw[j] === esc ? 2 : 1;
      if (j >= n) return null;
      out.push({ from: i + 1, to: j, kind: 'dq' });
      i = j + 1;
    } else i++;
  }
  return out;
}

/**
 * The facts the scans read (the hand lexer is gone), produced from the parser: the text with comments blanked, the text with data filled (quoted
 * text, escaped characters, heredoc and here-string bodies), the body offsets, the spans a substitution runs, and the substitutions that sit
 * inside double quotes. rawScan, rawBilling and the segment splitters read this shape unchanged. Every range comes from a parser node position
 * (ParseResult.quoted, substs, bodies, freeRanges); only an escaped character is found by the word-level scan (quoteSpans), which errs toward
 * deny. The offsets are those of `text` as given: no line continuation was joined (the parser reads them itself).
 */
export function lexedFromReading(text: string, res: ParseResult, ps: boolean): Lexed {
  const n = text.length;
  const t = text.split('');
  const m = text.split('');
  const bodies = new Set<number>();
  const dqSubs = new Set<number>();
  const execs: Array<[number, number]> = res.substs.map((s) => [s.from, s.to]);
  const heredocs = res.heredocs ?? [];
  const inExec = (k: number): boolean => execs.some(([a, b]) => a <= k && k < b);
  /** The substitutions that sit INSIDE the range [a, b): their code stays readable. A quoted range that sits inside a substitution is filled whole. */
  const innerExecs = (a: number, b: number): Array<[number, number]> => execs.filter(([x, y]) => a <= x && y <= b);
  const fill = (a: number, b: number): void => {
    const inner = innerExecs(a, b);
    for (let k = Math.max(0, a); k < Math.min(b, n); k++) if (!inner.some(([x, y]) => x <= k && k < y)) m[k] = FILL;
  };
  // Comments: a free range that is not a heredoc body.
  for (const [a, b] of res.freeRanges) {
    if (heredocs.some((h) => h.start === a && h.end === b)) continue;
    for (let k = Math.max(0, a); k < Math.min(b, n); k++) t[k] = m[k] = ' ';
  }
  // A quoted string inside a substitution that sits in a heredoc body (`cat <<EOF` then `$(date "+%H")`): the lexer this replaces left the whole
  // substitution readable, quotes included, and the scans were written against that. It is kept, so no verdict moves (it errs toward counting a call).
  const inBodySubst = (k: number): boolean => execs.some(([x, y]) => x <= k && k < y && res.bodies.some(([p, q]) => p <= x && y <= q));
  for (const [a, b] of res.quoted) {
    if (!inBodySubst(a)) fill(a, b);
  }
  for (const [a, b] of res.bodies) {
    // A Bash heredoc body starts on the line after its operator. That line break is not a command separator: the body stays in the segment of the
    // command that receives it (`bash <<EOF`). It is masked but, as before, it is no body character.
    if (!ps && a > 0 && text[a - 1] === '\n') m[a - 1] = FILL;
    const inner = innerExecs(a, b);
    for (let k = Math.max(0, a); k < Math.min(b, n); k++) {
      if (inner.some(([x, y]) => x <= k && k < y)) continue;
      m[k] = FILL;
      bodies.add(k);
    }
  }
  for (const s of res.substs) {
    if (!s.dq) continue;
    dqSubs.add(s.from);
    if (text[s.to - 1] === '`') dqSubs.add(s.to - 1);
  }
  // Escaped characters (`c\r`, `\;`): the word-level scan. A word it cannot read stays as it is, so the text stays visible to the scans.
  for (const c of res.calls) {
    for (const w of c.words) {
      for (const s of quoteSpans(w.raw, ps) ?? []) if (s.kind === 'esc') fill(w.start + s.from, w.start + s.to);
    }
    // A line continuation inside a call (`cr review \<nl>--agent`): the parser joined it, so the break is no separator. It is masked so the raw
    // segments stay whole and each call sits inside one segment. A break after a backslash inside a comment stays a separator: bash ends a comment at
    // its newline (D1, where the parser disagrees).
    const cont = ps ? '`' : '\\';
    for (let k = c.start; k < Math.min(c.end, n); k++) {
      const crlf = text[k] === '\r' && text[k + 1] === '\n';
      if (!crlf && !(text[k] === '\n' && text[k - 1] !== '\r')) continue;
      if (k === 0 || text[k - 1] !== cont) continue;
      if (res.freeRanges.some(([a, b]) => a <= k - 1 && k - 1 < b)) continue;
      m[k] = FILL;
      if (crlf) m[k + 1] = FILL;
    }
  }
  return { text: t.join(''), masked: m.join(''), dqSubs, bodies, execs, calls: res.calls.filter((c) => !c.viaPayload) };
}

// ---- the lexed facts every scan reads: from the parser, prepared once per decide ----

/**
 * A text can only lead to a non-ignore verdict when it holds a cr or coderabbit word or the word review (after quotes, backticks and backslashes are
 * removed, so `c\r` and `"cr"` count): Dave's "only trigger commands" rule (D2). Any other text is not parsed. Over-matches on purpose.
 */
// `coderabbit` matches inside a longer word on purpose: the skill-install rule reads `coderabbitai/skills`.
const TRIGGER_TEXT = /(?:^|[^A-Za-z0-9_])cr(?![A-Za-z0-9_])|coderabbit|review/i;
export const holdsTrigger = (text: string): boolean => TRIGGER_TEXT.test(text.replace(/["'`\\]/g, ''));

const lexCache = new Map<string, Lexed>();

/** Called at the start of a decide (with resetReadings): drops every prepared reading. */
export function resetLexCache(): void {
  lexCache.clear();
}

/**
 * Parse `joined` once and keep the facts the scans read (lexedFromReading). A text that holds no trigger word gets the plain facts (nothing masked):
 * no scan can find a call in it. A text the parser cannot read gets the same plain facts, nothing masked and no comment dropped: every word
 * then counts as unquoted code, which errs toward counting a call. classifyCommand denies such a text before it uses the facts (rows E1 to E8).
 */
export async function prepareLex(joined: string, ps: boolean): Promise<void> {
  const key = `${ps ? 'p' : 'b'}:${joined}`;
  if (lexCache.has(key)) return;
  if (!holdsTrigger(joined)) {
    lexCache.set(key, plainLexed(joined));
    return;
  }
  const r = await readCommand(joined, ps);
  lexCache.set(key, r.ok ? lexedFromReading(joined, r.result!, ps) : plainLexed(joined));
}

const plainLexed = (text: string): Lexed => ({ text, masked: text, dqSubs: new Set(), bodies: new Set(), execs: [] });

/** The prepared facts of `joined`. A text nobody prepared (a direct call of a scanner) gets the plain facts: no hand lexer reads it. */
function lexOf(joined: string, ps: boolean): Lexed {
  return lexCache.get(`${ps ? 'p' : 'b'}:${joined}`) ?? plainLexed(joined);
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
  /** Set on an `ignore` verdict when the reader failed on a text that holds no review call: the hook allows it and logs one `reader-error-allowed` line. */
  readerError?: string;
  /**
   * True when a review call is in the text but no parsed cr call stands for it (a wrapper the parser does not read: `watch`, `env -C`, `npm exec`,
   * `$(command -v cr)`), or the parsed call moves to another folder (`Start-Process -WorkingDirectory`). The check cannot place it in a folder.
   */
  unplaced?: boolean;
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
const CR_WORD = /(?:^|[\s"'`(\\/=,{])((?:cr|coderabbit)(?:\.(?:exe|cmd|bat|ps1))?)(?=$|[\s"'`)\\,}@])/gi;
const BILLING_WORD = /(?:^|[\s"'`(=,])--(?:use-credits|api-key)(?=$|[\s"'`)=,])/i;
const REVIEW_WORD = /\breview\b/i;
/**
 * Programs that receive a QUOTED string and run it, and that invocationOf does not open (it finds no `nested` string for them). A quoted
 * cr word is a call only for one of these or for a starter (Start-Process). Every other program gets a quoted cr word as data:
 * `find -exec grep -l "cr review"`, `npx vitest -t "cr review"`, `xargs grep 'cr review'`.
 */
const STRING_RUNNERS = new Set(['wsl', 'watch', 'ssh', 'parallel', 'foreach-object', '%', 'start-job', 'sajb', 'start-threadjob', 'invoke-command', 'icm']);

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
  const lexed = lexOf(text, ps);
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
 * True when a QUOTED cr word in this segment is a call: a starter (Start-Process) runs its argument string, and so do the STRING_RUNNERS. The
 * parser reads the program at the head of the segment (the first parser call whose span lies in [from, to), read by invocationOf). A wrapper it
 * does not peel (`nice`, `env -i`, `timeout -k 5 60`, `winpty`, `stdbuf`, `find -exec`) hides a shell, eval, starter or string runner further in:
 * every such UNQUOTED word of a call in the segment is read from there (invocationOf over the words from that word on). A shell with a `-c`
 * string is a call when that string holds one (this same rule, again); a shell with no -c gets a script path, so a quoted word is data
 * (`bash run.sh "cr review"`), except PowerShell, whose first argument is a command. A text nobody read has no calls: the quoted word counts.
 */
async function runsQuotedString(lexed: Lexed, from: number, to: number, ps: boolean): Promise<boolean> {
  if (!lexed.calls) return true;
  const inside = lexed.calls.filter((c) => c.words.length > 0 && c.start >= from && c.end <= to).sort((x, y) => x.start - y.start || y.end - x.end);
  const lead = inside[0];
  if (lead) {
    const head = lead.words[0].lit;
    if (head !== null && STARTERS.has(baseName(head))) return true;
    const inv = invocationOf(lead);
    if (inv?.nested !== undefined) return false; // the parser opened it: the inner string is classified again
    if (inv !== null && STRING_RUNNERS.has(inv.exe)) return true;
  }
  for (const call of inside) {
    for (let k = 0; k < call.words.length; k++) {
      const w = call.words[k];
      if (w.lit === null || isQuotedWord(w)) continue;
      const prog = baseName(w.lit);
      if (!(SHELLS.has(prog) || EVALS.has(prog) || STARTERS.has(prog) || prog === 'cmd' || STRING_RUNNERS.has(prog))) continue;
      const sub = invocationOf({ ...call, words: call.words.slice(k) });
      if (sub?.nested !== undefined) {
        if (await holdsReviewCall(sub.nested, ps)) return true;
      } else if (!POSIX_SHELLS.has(prog)) return true;
    }
  }
  return false;
}

/** The end of the command that holds offset `from`: the next `;`, `|`, `&`, `&&`, `||` or newline outside quotes. A `$( )` or backtick does not end it. */
function commandEnd(lexed: Lexed, from: number): number {
  const m = /\|\||&&|[;|&\n]/.exec(lexed.masked.slice(from));
  return m ? from + (m.index ?? 0) : lexed.text.length;
}

/**
 * THE call rule, shared by the answer-key check and the run count. A cr or coderabbit word is a call when it is followed by the word review
 * and:
 * - it is NOT in quotes (anywhere in the command, also inside `$( )` and backticks, after any wrapper or text program); or
 * - it IS in quotes and the segment hands that string to a program that runs it (runsQuotedString). The shells that invocationOf opens
 *   (`bash -c "..."`, `eval`, `cmd /c`, ...) are not scanned here: their inner string is read again with this same rule.
 * Otherwise a quoted cr word is data for its program (`grep -n "cr review"`) and is no call. A heredoc body is data unless a shell, eval or
 * wrapper receives it. The text after the cr word runs to the end of the command, so `$(command -v cr) review` is seen.
 *
 * WHY THIS RULE STAYS RAW (the backstop for two cases where the parser's call list hides a review; probe 45-g1-continuation-probe.txt):
 * - D1, a parser divergence: sh-syntax 0.8.1 joins a backslash-newline BEFORE it reads a comment, so `echo hi # note \<nl>cr review --agent` is one
 *   call `echo hi ...` in its list. Real bash ends the comment at its newline and runs `cr review` as a second command. Only this rule counts it.
 * - D2, an old-lexer divergence: PowerShell reads a backtick plus CRLF inside a word as two statements (the walker agrees); the old joinContinuations
 *   read it as one word. Rows "parser divergence D1" and "old lexer divergence" in coderabbit-guard-reader.test.ts pin both.
 */
export async function rawScan(lexed: Lexed, ps = false): Promise<RawScan> {
  const found: RawScan = { reviewSegments: [] };
  const text = lexed.text;
  const blanked = lexed.bodies.size === 0 ? text : text.split('').map((ch, k) => (lexed.bodies.has(k) ? ' ' : ch)).join('');
  // A `$( )` inside double quotes does not split, so a commit message built with a heredoc stays one git segment.
  for (const [a, b] of segmentRanges(lexed, ps, true)) {
    const seg = text.slice(a, b);
    if (!seg.trim()) continue;
    const reads = readsText(leadingProgram(seg));
    const scan = reads ? text : blanked;
    let quotedRuns: boolean | undefined;
    for (const m of seg.matchAll(CR_WORD)) {
      const at = a + (m.index ?? 0) + m[0].length - m[1].length;
      const quoted = lexed.masked[at] === FILL && !(reads && lexed.bodies.has(at));
      if (quoted) quotedRuns ??= await runsQuotedString(lexed, a, b, ps);
      if (quoted && !quotedRuns) continue;
      const end = Math.max(b, commandEnd(lexed, at + m[1].length));
      if (!REVIEW_WORD.test(scan.slice(at + m[1].length, end))) continue;
      found.reviewSegments.push({ start: a, end: b, raw: scan.slice(at, end).trim() });
      break;
    }
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

/** A cr or coderabbit word followed later by the word review, read after quotes, backticks and backslashes are removed (`c\r`, `"cr" "review`). */
export const reviewLike = (text: string): boolean => rawReview(text.replace(/["'`\\]/g, ''));

/** The cause of a failed reading, for the deny reason (rows E1 to E8). The text holds no path and no command text. */
function readerWhy(r: Reading, ps: boolean): string {
  const msg = r.msg ?? '';
  if (!r.reader) return /^node kinds not on the list/.test(msg) ? 'the command holds a construct the reader does not know' : 'the command did not parse';
  if (ps) {
    if (/timeout/i.test(msg)) return `the PowerShell reader timed out after ${r.ms} ms`;
    if (/bad json/i.test(msg)) return 'the PowerShell reader gave bad output';
    return 'the PowerShell reader failed';
  }
  if (/no tree/i.test(msg)) return 'the shell parser gave no tree';
  if (/ENOENT|wasm|WebAssembly|instantiate|Cannot find module|ERR_MODULE/i.test(msg)) return 'the shell parser did not load';
  return 'the shell parser failed';
}

/** One parse unit of a command: its span in the comment-free text, its trimmed text, and the Invocation it stands for. */
interface Unit { start: number; end: number; text: string; inv: Invocation | null; /** The parser call; absent only on the temporary hand-segment fallback. */ call?: Call }

/**
 * The parse units of a text, one per call the parser found (coord-guard-shell-parser PR A, group G1b). A call that sits inside the span of a
 * wrapper that takes a command string (`bash -c "...$(date)..."`) is left out: the wrapper's own string is classified again by classifyCommand,
 * so counting the inner call here too would count one review twice. A text the parser cannot read throws: no hand reader takes over, and the
 * callers fail closed (classifyCommand denies before it gets here; the hook's own catch denies a review).
 */
async function unitsOf(joined: string, lexed: Lexed, ps: boolean): Promise<Unit[]> {
  const reading = await readCommand(joined, ps);
  if (!reading.ok || !reading.result) throw new Error(`the command cannot be read: ${reading.msg ?? 'no reading'}`);
  const rows: Unit[] = [];
  for (const call of reading.result.calls) {
    if (call.viaPayload) continue;
    const inv = invocationOf(call);
    if (inv) rows.push({ start: call.start, end: call.end, text: lexed.text.slice(call.start, call.end).trim(), inv, call });
  }
  const wrappers = rows.filter((r) => r.inv?.nested !== undefined);
  return rows.filter((r) => !wrappers.some((w) => w !== r && w.start <= r.start && r.end <= w.end));
}

/** The units of a command text as written (the parser joins continuations itself; one parse per text). */
async function unitsOfText(command: string, ps: boolean): Promise<Unit[]> {
  const joined = command;
  await prepareLex(joined, ps);
  return unitsOf(joined, lexOf(joined, ps), ps);
}

/** Classify every command in `text`: a block wins, runs add up, wrapper strings are classified again. */
export async function classifyCommand(source: string, ps = false, depth = 0): Promise<SegmentClass> {  // Billing first, on the raw text as written and as the shell reads it (continuations joined). It
  // needs no lexing of comments or wrappers. Nested wrapper strings sit inside the outer text.
  // The parser reads the RAW text and joins continuations itself. The hand joiner is used for this billing check only, where an over-join can
  // only add a deny: as a pre-pass for the scans it hid a review (D2: backtick plus CRLF inside a word made `foo` and `cr` one word `foocr`).
  const joined = source;
  // Parse once; every scan below reads the facts of the parser (lexedFromReading), not a hand lexer.
  await prepareLex(joined, ps);
  if (rawBilling(source, ps) || rawBilling(joinContinuations(source, ps), ps)) {
    return { verdict: 'block', reason: BILLING_REASON };
  }
  // The reader must read the text (rows E1 to E8). A text that holds a cr word and review and cannot be read is denied; any other text is
  // allowed and logged once, so no unrelated command is locked out by a reader error.
  const gate = holdsTrigger(joined);
  if (gate) {
    const reading = await readCommand(joined, ps);
    if (!reading.ok) {
      const why = readerWhy(reading, ps);
      if (!reviewLike(joined)) return { verdict: 'ignore', readerError: why };
      // A text that does not parse is the user's to fix: the deny names the way-out (a plain command). A reader failure is not: it says cannot check.
      return { verdict: 'block', reason: !reading.reader && why === 'the command did not parse' ? wayOut(why) : cannotCheck(why) };
    }
  }
  // One reading gives the comment-free text and the quote mask, so both always agree.
  const lexed = lexOf(joined, ps);
  const text = lexed.text;
  // A wrapper string is scanned again, so a mix inside `bash -c "..."` counts per segment too.
  const raw = await rawScan(lexed, ps);
  let runs = 0;
  let allowed = false;
  // The raw scan and the parser split the text differently: a quoted `$( )` stays whole in the raw
  // scan and splits for the parser. Each parsed segment sits inside exactly one raw segment, found
  // by source offsets. A raw segment that names a review counts the parsed runs inside it, or one
  // hidden run if the parser found no CodeRabbit call there. It never counts twice.
  const plainCall = depth === 0 && isPlainCommand(source, joined, lexed, ps);
  const hidden = raw.reviewSegments.map((r) => ({ ...r, parsed: 0, covered: false, placed: false, invs: [] as Invocation[] }));
  const counted: Invocation[] = [];
  let unaccounted = false;
  let unplaced = false;
  for (const { start, end, text: seg, inv } of gate ? await unitsOf(joined, lexed, ps) : []) {
    const owner = hidden.find((h) => h.start <= start && end <= h.end);
    if (!inv) continue;
    // Rule U1 (seat 15:30, a-prime at 15:50): a program word with no literal value (`$X review`, `$(echo cr) review`, `c\r review`) denies when the
    // unit holds a cr or coderabbit word outside quotes, or when its first argument is the literal word review. `$L say "...CodeRabbit..."` is allowed.
    // A shell that reads an unreadable stdin, in a text that holds a cr word then review: the script may hold the review. Denied with the way-out.
    if (inv.stdinUnknown && reviewLike(joined)) return { verdict: 'block', reason: wayOut('the shell reads a script the check cannot see') };
    if (inv.unreadable && (inv.args[0] === 'review' || [...lexed.masked.slice(start, end).matchAll(CR_WORD)].length > 0)) {
      // The way-out text, as every other deny of an unplaced review (the user fixes it by writing the program word out).
      return { verdict: 'block', reason: wayOut('the program word is not readable') };
    }
    let c: SegmentClass;
    if (inv.nested === undefined) c = classifyInvocation(inv, plainCall && leadsWithCr(seg));
    else if (depth < MAX_NESTING) c = await classifyCommand(inv.nested, ps, depth + 1);
    else if (/\b(?:cr|coderabbit)\b/i.test(inv.nested)) c = { verdict: 'block', reason: 'CodeRabbit guard: wrapper nesting is too deep to check' };
    else c = { verdict: 'ignore' };
    if (c.verdict === 'block') return c;
    if (c.verdict === 'allow') allowed = true;
    // The parsed review calls this segment counts (a wrapper string brings its own), so the check can read their options.
    const calls = inv.nested === undefined ? ((c.runs ?? 0) > 0 ? [inv] : []) : (c.invocations ?? []);
    counted.push(...calls);
    if (c.unaccounted) unaccounted = true;
    // Placed: a parsed cr call stands for the review of this span (or the string it opened brought a placed call). A wrapper option that moves the folder is not placed.
    // A wrapper string (`sudo -D dir bash -c '...'`) inherits the move: the review inside runs in a folder the check does not see.
    const placed = inv.nested === undefined ? isCrExecutable(inv.exe) && !inv.moves : (c.runs ?? 0) > 0 && c.unplaced !== true && !inv.moves;
    if (c.unplaced || (inv.moves && (inv.nested !== undefined || isCrExecutable(inv.exe)) && (c.runs ?? 0) > 0)) unplaced = true;
    if (!owner) runs += c.runs ?? 0;
    else {
      owner.placed ||= placed;
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
    // A span with no parsed cr call (and no help call that explains its review word) is a call the check cannot place in a folder.
    if (!h.placed && !h.covered) unplaced = true;
    // An option in the raw text that the parsed calls do not give (a raw-only hit, or a wrapper the parser did not open) is unread.
    if (rawOptionCount(h.raw) > parsedOptionCount(h.invs)) unaccounted = true;
  }
  if (runs > 0) return { verdict: 'allow', countsRun: true, runs, invocations: counted, unaccounted, unplaced };
  return { verdict: allowed ? 'allow' : 'ignore', reviewHelp: hidden.some((h) => h.covered) };
}

/** Classify one command line (kept for callers that think in segments). */
export async function classifyShellSegment(segment: string, ps = false): Promise<SegmentClass> {
  return classifyCommand(segment, ps);
}

// ---------------------------------------------------------------------------------------------
// Run counter
// ---------------------------------------------------------------------------------------------

/** One git call of the run key, under the shared deadline (gitRun). A failure, a non-zero exit or a spent budget throws, as execFileSync did. */
function git(args: string[], cwd: string): string {
  const r = gitRun(cwd, args);
  if (!r.ok) throw new Error(`git ${args[0]} failed`);
  return r.stdout.trim();
}

/** The run key reads at most four git calls. They share ONE budget, so the whole hook stays under the worst case in the header. */
const KEY_BUDGET_MS = 10000;

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
  // A new deadline, as the answer-key check sets its own: the check and the key never run longer than 30 s + 10 s together.
  gitDeadline = Date.now() + KEY_BUDGET_MS;
  try {
    const root = git(['rev-parse', '--show-toplevel'], cwd);
    return `${repoId(root)}#${branchId(root)}`;
  } catch {
    return `cwd#${cwd}`;
  }
}

const CD_ARGS = String.raw`\s+(?:(?:-\w+|\/d)\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))`;
/**
 * The cd commands each shell really has. PowerShell: cd, chdir, pushd, Push-Location, Set-Location and sl, in any case. Bash: `cd` and `pushd`
 * in lower case only. `CD` and `chdir` are not Bash commands: they fail, and the review that follows runs in the folder it started in.
 */
const CD_SEGMENT_PS = new RegExp(`^(?:cd|chdir|pushd|push-location|set-location|sl)${CD_ARGS}`, 'i');
const CD_SEGMENT_BASH = new RegExp(`^(?:cd|pushd)${CD_ARGS}`);
const cdSegment = (segment: string, ps: boolean): RegExpExecArray | null => (ps ? CD_SEGMENT_PS : CD_SEGMENT_BASH).exec(segment);

/** The home folder of an env: the same order as the guard log. */
export function homeOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.USERPROFILE || env.HOME || homedir();
}

/**
 * `target` resolved from `dir`. A leading `~` goes through `home` (the shell expands it). Git Bash writes C:\x as /c/x; node would read that as a
 * path on the current drive. Only Bash does that: PowerShell reads /c/x as the folder \c\x on the current drive.
 */
function cdTarget(dir: string, target: string, home: string, ps: boolean): string {
  const expanded = home && /^~(?=[\\/]|$)/.test(target) ? join(home, target.slice(1)) : target;
  return resolve(dir, ps ? expanded : expanded.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:'));
}

/** The directory the command runs in: the payload cwd, moved by the last `cd <dir>` in the command. A leading `~` is expanded through `home`. */
export async function effectiveCwd(command: string, cwd: string, ps = false, home = ''): Promise<string> {
  let dir = cwd;
  for (const unit of await unitsOfText(command, ps)) {
    const { target } = cdTargetOf(unit, ps);
    if (target && target !== '-') dir = cdTarget(dir, target, home, ps);
  }
  return dir;
}

// ---------------------------------------------------------------------------------------------
// Answer-key check: no CLI review may start on a diff that holds an answer-key path
// ---------------------------------------------------------------------------------------------
//
// The check runs for every command that holds a review call. CCv3 is read from the git remotes and the HEAD tree of the directory the review
// runs in, never from the run-cap key (an env key or a `cwd#` fallback key is not evidence about the repo). The paths it reads are the union
// of: the commits against main and against fork/main, the working tree (staged, unstaged and untracked), and both ranges (X...HEAD and
// X..HEAD) of every base the CLI options name. A reason holds the COUNT of matched paths and never a path, and ENDS with the words
// answer-key. Any failure denies: the hook's outer catch allows, so this code has its own.

/** A remote URL of the CCv3 repo (either owner, either repo name, any host). Unanchored on purpose: an odd URL form over-matches and is checked. */
const CCV3_REMOTE = /(?:rev4nchist|parcadei)\/continuous-claude(?:-v3)?/i;
/** The two ranges pre-pr.mjs checks: local main and fork/main. `--no-renames`: a move out of gold/ names the old path too. */
const ANSWER_BASES = ['refs/heads/main', 'refs/remotes/fork/main'];
/** A HEAD that holds this tree is a CCv3 checkout, whatever its remotes say (a mirror, a renamed fork). */
const EVAL_TREE = 'scripts/eval/review-eval';
const ANSWER_GIT_TIMEOUT_MS = 10000;
/** One budget for all git calls of one check, so a stalled disk costs at most this long (the hook timeout must be longer). */
const ANSWER_BUDGET_MS = 30000;
let gitDeadline = 0;
// The log masker reads `key` followed by a word or a colon as a secret name: every reason ENDS with `answer-key`.
const DENY_PREFIX = 'CodeRabbit guard:';
const cannotCheck = (why: string): string => `${DENY_PREFIX} ${why}: no CLI review runs on a diff it cannot check for answer-key`;
/** The way-out text of every shape deny. */
export const WAY_OUT_TEXT = 'run the review as its own plain command with --base <ref>';
const WAY_OUT = `${DENY_PREFIX} ${WAY_OUT_TEXT}, so the check can read the diff for answer-key`;
/** The way-out text with the cause of the deny in brackets. The cause holds no path and never the word key. */
const wayOut = (cause?: string): string => (cause ? `${DENY_PREFIX} ${WAY_OUT_TEXT} (${cause}), so the check can read the diff for answer-key` : WAY_OUT);
const budgetOut = (): boolean => Date.now() >= gitDeadline;

interface GitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The env of every git call: LC_ALL=C (the check reads git's English text: `not a git repository`) and no GIT_DIR, GIT_WORK_TREE or
 * GIT_INDEX_FILE (they would point git at another repo than the folder).
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LC_ALL: 'C' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  return env;
}

function gitRun(cwd: string, args: string[]): GitResult {
  const left = gitDeadline - Date.now();
  if (left <= 0) return { ok: false, status: null, stdout: '', stderr: 'budget' };
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', timeout: Math.min(ANSWER_GIT_TIMEOUT_MS, left), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
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

/** A config file is sent to the service. Deny an answer-key file, a missing file, a folder, and a link that leads to any of them. The budget is read before each file call. */
function configDeny(cwd: string, files: string[]): string | null {
  for (const file of files) {
    const abs = resolve(cwd, file);
    let real: string;
    if (budgetOut()) return cannotCheck('the time budget ended');
    try {
      real = realpathSync(abs);
    } catch {
      return cannotCheck('a --config file cannot be read');
    }
    if (namesAnswerKey(abs) || namesAnswerKey(real)) return `${DENY_PREFIX} a --config file is sent to the service and it is answer-key`;
    if (budgetOut()) return cannotCheck('the time budget ended');
    try {
      if (statSync(real).isDirectory()) return WAY_OUT;
    } catch {
      return cannotCheck('a --config file cannot be read');
    }
  }
  return null;
}

/**
 * Whether `dir` may be a CCv3 checkout. Skip (not checked) only when git resolves the root, no remote is CCv3 AND HEAD holds no
 * scripts/eval/review-eval tree: a folder outside git or a foreign repo. A mirror or a renamed fork has the tree and is checked. Null: git
 * failed, an unborn HEAD or a broken config (deny).
 */
function ccv3Root(dir: string): { root: string } | { skip: true } | null {
  const top = gitRun(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return top.status === 128 && /not a git repository/i.test(top.stderr) ? { skip: true } : null;
  const root = top.stdout.trim();
  if (!root) return null;
  const remotes = gitRun(root, ['config', '--get-regexp', '^remote\\..*\\.url$']);
  if (remotes.status !== 1 && !remotes.ok) return null; // exit 1 is "no remote at all"
  const urls = remotes.status === 1 ? [] : remotes.stdout.split('\n').map((l) => l.trim().split(/\s+/).slice(1).join(' ')).filter(Boolean);
  if (urls.some((u) => CCV3_REMOTE.test(u))) return { root };
  const tree = gitRun(root, ['ls-tree', 'HEAD', '--', EVAL_TREE]);
  if (tree.ok) return tree.stdout.trim() ? { root } : { skip: true };
  // A git failure denies. An unborn HEAD (no commit yet) is not a failure: there is no HEAD tree, so the folder itself decides.
  const head = gitRun(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.status !== 1 || budgetOut()) return null;
  return existsSync(join(root, EVAL_TREE)) ? { root } : { skip: true };
}

/** The ranges the check reads in one CCv3 checkout, or a deny reason. Each base the CLI options name must resolve; each gets X...HEAD and X..HEAD. */
function rangesFor(root: string, opts: ReviewOptions): string[] | string {
  const ranges = ANSWER_BASES.map((b) => `${b}...HEAD`);
  for (const value of [...opts.bases, ...opts.baseCommits]) {
    if (value.startsWith('-') || !gitRun(root, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`]).ok) return WAY_OUT;
    // The two-dot range reads the base's own tree: a path unchanged since the merge base that the base branch deleted shows only there.
    ranges.push(`${value}...HEAD`, `${value}..HEAD`);
  }
  return ranges;
}

/** After a failed diff: the text that names the missing main ref (or says the budget ended), or undefined when both refs exist. */
function missingRef(root: string): string | undefined {
  if (budgetOut()) return 'the time budget ended';
  const missing = ANSWER_BASES.find((b) => !gitRun(root, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`]).ok);
  return missing ? `the ref ${missing} is missing` : undefined;
}

/** The deny reason for one CCv3 checkout, or null (no answer-key path in the diff). */
function rootDeny(root: string, opts: ReviewOptions): string | null {
  const ranges = rangesFor(root, opts);
  if (typeof ranges === 'string') return ranges;
  const union = new Set<string>();
  for (const range of ranges) {
    const paths = diffPaths(root, range);
    if (paths === null) return cannotCheck(missingRef(root) ?? 'git diff failed');
    for (const p of paths) union.add(p);
  }
  const tree = statusPaths(root);
  if (tree === null) return cannotCheck('git status failed');
  for (const p of tree) union.add(p);
  const check = answerKeyCheck({ root, paths: [...union] });
  if (check === null) return null;
  if ('closed' in check) return cannotCheck('the REVIEW.md skip list is not usable');
  return `${DENY_PREFIX} no CLI review may read the paths in the diff (${check.hits.length}) that are answer-key`;
}

/** The CCv3 checkouts among `dirs` (deduplicated roots), and a deny reason when git failed for any folder. A skipped folder adds nothing. */
function checkedRoots(dirs: string[]): { roots: string[]; error?: string } {
  const roots = new Set<string>();
  let error: string | undefined;
  for (const dir of dirs) {
    const found = ccv3Root(dir);
    if (found === null) error ??= cannotCheck('the git root or the remotes cannot be read');
    else if (!('skip' in found)) roots.add(found.root);
  }
  return { roots: [...roots], error };
}

// ---- the folder the review runs in ----

/** The cd words of the shell the command runs in (see CD_SEGMENT_PS). A string inside a wrapper may run in either shell: it uses the wider list. */
const CD_WORD_PS = /^(?:cd|chdir|pushd|popd|push-location|pop-location|set-location|sl)(?=\s|$)/i;
const CD_WORD_BASH = /^(?:cd|pushd|popd)(?=\s|$)/;

const CD_NAME_PS = /^(?:cd|chdir|pushd|popd|push-location|pop-location|set-location|sl)$/i;
const CD_NAME_BASH = /^(?:cd|pushd|popd)$/;
const CD_POP_NAME = /^(?:popd|pop-location)$/i;

/** True when the unit runs a cd command of the shell it runs in (`wide`: the PowerShell list, for a string inside a wrapper that may run in either shell). */
function cdWordOf(unit: Unit, ps: boolean, wide = false): boolean {
  if (!unit.call) return (wide || ps ? CD_WORD_PS : CD_WORD_BASH).test(unit.text);
  const name = unit.call.words[0]?.lit;
  return name != null && (wide || ps ? CD_NAME_PS : CD_NAME_BASH).test(name);
}

/**
 * The cd target of a unit: its text (undefined: no cd, a popd, or a cd with no target), and whether it is a bare Bash word that holds a backslash
 * (`cd C:\x` goes to `C:x`). The words come from the parser, so a quoted target is unquoted by the parser. A leading option (`-L`, `-Path`, `/d`)
 * is skipped only when a word follows it, as the old reader did.
 */
function cdTargetOf(unit: Unit, ps: boolean): { target?: string; bareBackslash: boolean } {
  if (!unit.call) {
    const m = cdSegment(unit.text, ps);
    return { target: m?.[1] ?? m?.[2] ?? m?.[3], bareBackslash: !ps && m?.[3] !== undefined && m[3].includes('\\') };
  }
  const ws = unit.call.words;
  const name = ws[0]?.lit;
  if (name == null || !(ps ? CD_NAME_PS : CD_NAME_BASH).test(name) || CD_POP_NAME.test(name)) return { bareBackslash: false };
  let i = 1;
  while (i < ws.length - 1 && /^(?:-\w+|\/d)$/.test(ws[i].lit ?? '')) i++;
  const w = ws[i];
  if (!w) return { bareBackslash: false };
  return { target: w.lit ?? w.raw, bareBackslash: !ps && !isQuotedWord(w) && w.raw.includes('\\') };
}

async function nestedHasCd(text: string, ps: boolean, depth: number): Promise<boolean> {
  if (depth > MAX_NESTING) return true;
  for (const unit of await unitsOfText(text, ps)) {
    if (cdWordOf(unit, ps, true)) return true;
    const inv = unit.inv;
    if (inv?.nested !== undefined && (await nestedHasCd(inv.nested, ps, depth + 1))) return true;
  }
  return false;
}

/**
 * A deny reason when the folder a review runs in cannot be read from the command: a cd target that holds `$`, `%`, a backtick or a `~`
 * that is not a leading `~` or `~/` (resolve() reads them as plain text), a cd with no target, `cd -`, popd, a cd AFTER the review, a cd
 * inside a wrapper string (the way-out), or a folder that does not exist. effectiveCwd cannot follow these, so the check could read the
 * wrong repo. The budget is read before the statSync.
 */
async function folderDeny(command: string, ps: boolean, cwd: string): Promise<string | null> {
  let seenCr = false;
  for (const unit of await unitsOfText(command, ps)) {
    const text = unit.text;
    if (cdWordOf(unit, ps)) {
      const { target, bareBackslash } = cdTargetOf(unit, ps);
      if (!target || target === '-' || /[$%`]/.test(target) || (target.includes('~') && !/^~(?:[\\/][^~]*)?$/.test(target))) {
        return WAY_OUT;
      }
      // A bare backslash is an escape in Bash: `cd C:\x` goes to `C:x`. In quotes it is a plain character.
      if (bareBackslash) return wayOut('a backslash in a cd target is an escape in Bash: write the path with /');
      if (seenCr) return WAY_OUT;
    }
    if ([...text.matchAll(CR_WORD)].length > 0) seenCr = true;
    const inv = unit.inv;
    if (inv?.nested !== undefined && (await nestedHasCd(inv.nested, ps, 0))) return WAY_OUT;
  }
  if (budgetOut()) return cannotCheck('the time budget ended');
  try {
    if (!statSync(cwd).isDirectory()) return cannotCheck('the folder the review runs in is not a folder');
  } catch {
    return cannotCheck('the folder the review runs in does not exist');
  }
  return null;
}

// ---- the allowed shape ----

/** What the allow test reads: the options of one plain review, and the cd target when one comes first. */
interface Shape extends ReviewOptions {
  cd?: string;
  /** True when `;` joins the cd and the review: the review runs even when the cd fails, so the start folder counts too. */
  semi?: boolean;
}

const SHAPE_FLAGS = new Set(['--agent', '--fresh', '--show-prompts', '--use-credits', '--committed', '--uncommitted', '--include-untracked', '--usage', '--deep', '--help', '-h']);
const SHAPE_VALUE_OPTIONS = ['--base', '--base-commit', '--dir', '--remote', '--source-branch', '--region'];
/** A literal token. `~` is read by the caller: only a cd target may lead with it. A backslash is a path character in PowerShell only. */
const BARE_TOKEN = /^[A-Za-z0-9._/:=~-]+/;
const BARE_TOKEN_PS = /^[A-Za-z0-9._/:=~\\-]+/;
const QUOTED_BODY = /^[A-Za-z0-9._/:= -]*$/;
const QUOTED_BODY_PS = /^[A-Za-z0-9._/:= \\-]*$/;
const REMOTE_LITERAL = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** A cd target that no CDPATH can move: absolute (`/x`, `C:/x`, `C:\x`), `.`, `..`, `./x`, `../x` or `~`. A bare name could be found through CDPATH. */
const FIXED_TARGET = /^(?:\/|[A-Za-z]:[\\/]|\.{1,2}(?:[\\/]|$)|~)/;

type ShapeToken = { v: string; quoted: boolean } | { sep: '&&' | ';' };

/** Tokens of a command that holds only literal words, `&&` and `;`. Null at the first other character, an open quote, or a quote inside a token. */
function shapeTokens(text: string, ps: boolean): ShapeToken[] | null {
  const out: ShapeToken[] = [];
  const n = text.length;
  const bare = ps ? BARE_TOKEN_PS : BARE_TOKEN;
  const quotedBody = ps ? QUOTED_BODY_PS : QUOTED_BODY;
  const ends = (k: number): boolean => k >= n || text[k] === ' ' || text[k] === '\t' || text[k] === ';' || text.startsWith('&&', k);
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t') i++;
    else if (c === ';') {
      out.push({ sep: ';' });
      i++;
    } else if (text.startsWith('&&', i)) {
      out.push({ sep: '&&' });
      i += 2;
    } else if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      const body = close < 0 ? '' : text.slice(i + 1, close);
      if (close < 0 || !quotedBody.test(body) || !ends(close + 1)) return null;
      out.push({ v: body, quoted: true });
      i = close + 1;
    } else {
      const m = bare.exec(text.slice(i));
      if (!m || !ends(i + m[0].length)) return null;
      out.push({ v: m[0], quoted: false });
      i += m[0].length;
    }
  }
  return out;
}

/** An option value: not empty, not another option, no `~` (the shell would expand it, this check does not). */
const literalValue = (t: { v: string } | undefined): t is { v: string } => t !== undefined && t.v !== '' && !t.v.startsWith('-') && !t.v.includes('~');

/**
 * The strict allow test on the RAW command: ONE plain review call, alone or after ONE plain `cd <literal>` joined by `&&` or `;`. Null for
 * anything else. The SKIP_CODERABBIT_GUARD=1 prefix is cut first (it lifts the run cap and the billing and block denies, never this check).
 * The cd word is `cd` in lower case for Bash (it has no `CD`). PowerShell also takes `Set-Location` and `sl` in any case, with an optional
 * `-Path` or `-LiteralPath`, and a backslash in the cd target (a path character there; in Bash it is an escape). The target must be fixed:
 * absolute, `.`, `..`, or start with `./`, `../` or `~`.
 */
export async function parseShape(command: string, ps = false, opts: ParseOpts = {}): Promise<Shape | null> {
  const raw = rawShape(command, ps);
  if (!raw) return null;
  // The raw allowlist is the only way to an allow. The parser must also read the same calls: one review, or one cd and one review, with the very
  // words the allowlist saw. A text the parser cannot read, or reads differently, is no shape (the way-out deny).
  const override = OVERRIDE.exec(command);
  const reading = await readCommand((override ? command.slice(override[0].length) : command).trim(), ps, opts);
  const calls = reading.result?.calls ?? [];
  if (!reading.ok || calls.length !== raw.groups.length) return null;
  const agrees = calls.every((call, k) => call.words.length === raw.groups[k].length && call.words.every((w, j) => w.lit !== null && w.lit === raw.groups[k][j]));
  return agrees ? raw.shape : null;
}

/** The allowlist half of parseShape: the shape and the literal words of each call (the cd call first, when there is one). */
function rawShape(command: string, ps: boolean): { shape: Shape; groups: string[][] } | null {
  const override = OVERRIDE.exec(command);
  const toks = shapeTokens((override ? command.slice(override[0].length) : command).trim(), ps);
  if (!toks || toks.length === 0) return null;
  const groups: Array<Array<{ v: string; quoted: boolean }>> = [[]];
  let semi = false;
  for (const t of toks) {
    if ('sep' in t) {
      semi = t.sep === ';';
      groups.push([]);
    } else groups[groups.length - 1].push(t);
  }
  if (groups.length > 2) return null;
  const shape: Shape = { bases: [], baseCommits: [], dirs: [], configs: [], remotes: [], bad: false };
  if (groups.length === 2) {
    const [word, ...args] = groups[0];
    // PowerShell: `-Path` or `-LiteralPath` may come between the cd word and its target.
    if (ps && args.length === 2 && !args[0].quoted && /^-(?:literal)?path$/i.test(args[0].v)) args.shift();
    const cdWord = ps ? /^(?:cd|set-location|sl)$/i : /^cd$/;
    if (!word || args.length !== 1 || word.quoted || !cdWord.test(word.v) || !FIXED_TARGET.test(args[0].v)) return null;
    shape.cd = args[0].v;
    shape.semi = semi;
  }
  const last = groups[groups.length - 1];
  // A backslash is a path character in the cd target only: every other token must stay free of it.
  if (last.some((t) => t.v.includes('\\'))) return null;
  const [program, sub, ...rest] = last;
  if (!program || !sub || program.quoted || sub.quoted || !isCrExecutable(program.v) || sub.v !== 'review') return null;
  const slot: Record<string, string[]> = { '--base': shape.bases, '--base-commit': shape.baseCommits, '--dir': shape.dirs, '--remote': shape.remotes, '--config': shape.configs };
  for (const name of SHAPE_VALUE_OPTIONS) slot[name] ??= [];
  let i = 0;
  while (i < rest.length) {
    const t = rest[i++];
    if (t.quoted) return null;
    if (SHAPE_FLAGS.has(t.v)) continue;
    const eq = /^(--[a-z-]+)=(.*)$/.exec(t.v);
    const name = eq ? eq[1] : t.v === '-c' ? '--config' : t.v;
    if (!Object.hasOwn(slot, name)) return null;
    if (eq) {
      if (!literalValue({ v: eq[2] })) return null;
      slot[name].push(eq[2]);
    } else if (name === '--config') {
      // -c and --config take one or more files, up to the next option.
      let n = 0;
      while (literalValue(rest[i])) {
        shape.configs.push(rest[i++].v);
        n++;
      }
      if (n === 0) return null;
    } else {
      const value = rest[i++];
      if (!literalValue(value)) return null;
      slot[name].push(value.v);
    }
  }
  return shape.remotes.every((r) => REMOTE_LITERAL.test(r)) ? { shape, groups: groups.map((g) => g.map((t) => t.v)) } : null;
}

export interface AnswerKeyRun {
  command: string;
  ps: boolean;
  /** The folder of the payload (the session or subagent cwd). */
  startCwd: string;
  /** The folder the review runs in, as effectiveCwd reads it. */
  cwd: string;
  /** The home folder for a leading `~` in a cd target. */
  home: string;
  invocations: Invocation[];
  unaccounted: boolean;
  /** A review call that no parsed cr call stands for, or that a wrapper option moves to another folder (SegmentClass.unplaced). */
  unplaced?: boolean;
}

/** The cause of a failed shape test, for the way-out text, when the command starts with a cd that the shape cannot take. Undefined: no known cause. */
function shapeCause(command: string, ps: boolean): string | undefined {
  const head = command.replace(OVERRIDE, '').trim().split(/&&|;/)[0].trim();
  const word = /^(\S+)\s+(.*)$/.exec(head);
  if (!word) return undefined;
  if (!ps && /^cd$/i.test(word[1]) && word[1] !== 'cd') return 'Bash has no CD: write cd in lower case';
  if (!/^(?:cd|chdir|pushd|set-location|sl)$/i.test(word[1])) return undefined;
  if (!ps && word[2].includes('\\')) return 'a backslash in a cd target is an escape in Bash: write the path with /';
  const target = word[2].replace(/^(?:-\w+\s+)*/, '').replace(/^["']|["']$/g, '');
  if (!FIXED_TARGET.test(target)) return 'a cd target must be absolute or start with ./ ../ or ~';
  return undefined;
}

/**
 * A deny reason when a review run may read an answer-key path or the check cannot finish, else null. Own catch: the outer one allows.
 * Order: a call that cannot be placed in a folder (any folder); read the folder; read the options (the shape when the command is the allowed
 * shape, else what the parser gives); check --remote and the config files; decide which folders are CCv3 checkouts (the folder, the start
 * folder when a `;` or a cd made them differ, and every --dir); none: allow. Else only the allowed shape with a literal base passes, and its
 * diff is read.
 */
export async function answerKeyDeny(run: AnswerKeyRun): Promise<string | null> {
  try {
    gitDeadline = Date.now() + ANSWER_BUDGET_MS;
    const shape = await parseShape(run.command, run.ps);
    // A review that no parsed cr call stands for (env -C, watch, npm exec, $(command -v cr)) may run in a folder the check does not see: deny in every folder.
    if (!shape && run.unplaced) return wayOut(shapeCause(run.command, run.ps));
    const cwd = shape ? (shape.cd === undefined ? run.startCwd : cdTarget(run.startCwd, shape.cd, run.home, run.ps)) : run.cwd;
    const folder = await folderDeny(run.command, run.ps, cwd);
    if (folder) return folder;
    const opts = shape ?? readReviewOptions(run.invocations);
    // With `;` the review runs even when the cd fails, so the start folder is checked too. With && it does not. A non-shape command checks both.
    const startToo = shape ? shape.semi === true : cwd !== run.startCwd;
    const folders = [cwd, ...(startToo ? [run.startCwd] : []), ...opts.dirs.map((d) => resolve(cwd, d))];
    // Not the allowed shape and a CCv3 checkout is involved: the way-out, whatever else is wrong with the command.
    const early = shape ? undefined : checkedRoots(folders);
    if (early && early.roots.length > 0) return wayOut(shapeCause(run.command, run.ps));
    if (opts.bad) return cannotCheck('a CLI option has no value');
    if (opts.remotes.some((r) => CCV3_REMOTE.test(r))) return `${DENY_PREFIX} --remote names the CCv3 repo and the service reads its answer-key`;
    const config = configDeny(cwd, opts.configs);
    if (config) return config;
    const { roots, error } = early ?? checkedRoots(folders);
    if (error) return error;
    // An option in the command that the parser cannot read may be a --dir into CCv3: the way-out in every folder.
    if (roots.length === 0) return !shape && run.unaccounted ? wayOut() : null;
    if (opts.bases.length + opts.baseCommits.length === 0) return WAY_OUT;
    for (const root of roots) {
      const reason = rootDeny(root, opts);
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

export async function classifyDelegate(input: PreToolUseInput): Promise<{ verdict: SegmentVerdict; reason?: string }> {
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
  classify?: (source: string, ps?: boolean) => SegmentClass | Promise<SegmentClass>;
  cwdOf?: (command: string, cwd: string, ps?: boolean) => string | Promise<string>;
}

/** A cr or coderabbit word followed later by the word review: the raw rule of rawScan, with no lexer. */
function rawReview(command: string): boolean {
  const first = [...command.matchAll(CR_WORD)][0];
  return !!first && REVIEW_WORD.test(command.slice((first.index ?? 0) + first[0].length));
}

/** True when the command holds a review call by the call rule (rawScan), or a parsed cr call that names review, also inside a wrapper string. */
async function holdsReviewCall(source: string, ps: boolean, depth = 0): Promise<boolean> {
  const joined = source;
  // A nested string is read by the parser here, before any scan reads its facts (an unread text would count a quoted cr word as code).
  await prepareLex(joined, ps);
  const lexed = lexOf(joined, ps);
  if ((await rawScan(lexed, ps)).reviewSegments.length > 0 || depth > MAX_NESTING) return true;
  for (const { inv } of holdsTrigger(joined) ? await unitsOf(joined, lexed, ps) : []) {
    if (!inv) continue;
    if (inv.nested !== undefined ? await holdsReviewCall(inv.nested, ps, depth + 1) : isCrExecutable(inv.exe) && inv.args.some((a) => a.toLowerCase() === 'review')) return true;
  }
  return false;
}

/**
 * The answer-key result for a command, or null. The ONE call rule decides: `verdict.runs` is what rawScan and the parser found, so a command that
 * only names the words (`grep -n "cr review"`) has no runs and is never checked. A deny uses no run slot.
 */
async function answerKeyResult(input: PreToolUseInput, command: string, ps: boolean, verdict: SegmentClass, seam: DecideSeam, env: NodeJS.ProcessEnv): Promise<DecideResult | null> {
  // A blocked review (the override lifted the block) has no parsed calls: any option in its raw text counts as unread.
  const blockedReview = (verdict.runs ?? 0) === 0 && verdict.verdict === 'block' && (await holdsReviewCall(command, ps));
  if ((verdict.runs ?? 0) === 0 && !blockedReview) return null;
  const startCwd = input.cwd || process.cwd();
  const home = homeOf(env);
  const cwd = await (seam.cwdOf ?? ((c: string, d: string, p?: boolean) => effectiveCwd(c, d, p, home)))(command, startCwd, ps);
  const unaccounted = verdict.unaccounted === true || (blockedReview && rawOptionCount(command) > 0);
  const reason = await answerKeyDeny({ command, ps, startCwd, cwd, home, invocations: verdict.invocations ?? [], unaccounted, unplaced: verdict.unplaced === true });
  return reason ? { allow: false, reason, answerKey: true } : null;
}

async function decideChecked(input: PreToolUseInput, env: NodeJS.ProcessEnv, seam: DecideSeam): Promise<DecideResult> {
  const tool = input.tool_name || '';
  const command = input.tool_input?.command || '';
  const ps = tool === 'PowerShell';
  const classify = seam.classify ?? classifyCommand;
  const runsCommand = BASH_TOOLS.has(tool) || (DELEGATE_TOOLS.has(tool) && tool !== 'Skill' && command !== '');

  // The override lifts the run cap and the billing and block denies, as on main. It never lifts the answer-key check: a review that may read an answer-key path is denied even with it.
  if (OVERRIDE.test(command)) {
    const denied = runsCommand ? await answerKeyResult(input, command, ps, await classify(command, ps), seam, env) : null;
    if (denied) return denied;
    // A command that names a review gets a row with no cwd and no command text: the check read the folder and the options.
    if (rawReview(command)) logGuardDecision('coderabbit-guard', { ...input, cwd: undefined }, 'override', 'SKIP_CODERABBIT_GUARD=1', { env });
    else logGuardDecision('coderabbit-guard', input, 'override', 'SKIP_CODERABBIT_GUARD=1', { command, env });
    return { allow: true };
  }

  if (tool === 'Skill') {
    const s = classifySkill(input);
    if (s.verdict === 'block') return { allow: false, reason: s.reason };
    return { allow: true };
  }

  if (DELEGATE_TOOLS.has(tool)) {
    const d = await classifyDelegate(input);
    if (d.verdict === 'block') return { allow: false, reason: d.reason };
    // A Task or Agent payload carries `prompt`, not `command`, and a prompt is never checked for a review call. Only a payload that has a tool_input.command
    // gets the same answer-key check as a Bash call (it counts no run). The command is classified here, not through `d`: a read-only
    // autofix prompt returns allow from classifyDelegate before it reads the command.
    return (command ? await answerKeyResult(input, command, false, await classify(command, false), seam, env) : null) ?? { allow: true };
  }

  if (!BASH_TOOLS.has(tool)) return { allow: true };

  const verdict = await classify(command, ps);
  if (verdict.verdict === 'block') return { allow: false, reason: verdict.reason };
  // The reader failed on a text with no review call: allowed, and counted in the guard log for the seat's weekly read (row E9).
  if (verdict.readerError) logGuardDecision('coderabbit-guard', input, 'warn', `reader-error-allowed: ${verdict.readerError}`, { command, env });
  const runs = verdict.runs ?? 0;
  if (runs === 0) return { allow: true };

  // The check decides from git, not from the cap key, and runs before the cap, so a deny uses no slot.
  const denied = await answerKeyResult(input, command, ps, verdict, seam, env);
  if (denied) return denied;
  const home = homeOf(env);
  const cwd = await (seam.cwdOf ?? ((c: string, d: string, p?: boolean) => effectiveCwd(c, d, p, home)))(command, input.cwd || process.cwd(), ps);
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

export async function decide(input: PreToolUseInput, env: NodeJS.ProcessEnv = process.env, seam: DecideSeam = {}): Promise<DecideResult> {
  try {
    // One decide, one set of parser readings: the memo of readCommand and the prepared facts start empty.
    resetReadings();
    resetLexCache();
    // await inside the try: a rejection must reach the catch, which fails closed
    return await decideChecked(input, env, seam);
  } catch {
    return failClosed(input);
  }
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

/** The deny line of the guard log. An answer-key deny logs no command text and no cwd: either can name a path or a folder. */
export function logDeny(input: PreToolUseInput, result: DecideResult, env: NodeJS.ProcessEnv = process.env): void {
  if (result.answerKey) logGuardDecision('coderabbit-guard', { ...input, cwd: undefined }, 'deny', result.reason || 'blocked', { env });
  else logGuardDecision('coderabbit-guard', input, 'deny', result.reason || 'blocked', { command: input.tool_input?.command, env });
}

async function main(): Promise<void> {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(readStdin());
  } catch {
    outputContinue();
    return;
  }

  const result = await decide(input);
  if (!result.allow) {
    logDeny(input, result);
    outputDeny(result.reason || 'CodeRabbit guard: blocked');
    return;
  }
  outputContinue();
}

if (!process.env.VITEST) {
  main().catch(() => outputContinue());
}
