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
 * A raw check runs first and does not depend on that parsing. It reads only a segment whose leading
 * program runs its text (a shell, eval, iex, Start-Process, Start-Job, xargs, sudo, env, nohup, time,
 * timeout, watch, find, ForEach-Object) or is cr or coderabbit. If that raw text (quotes, backticks,
 * $( ), wrapper strings; .exe, .cmd, .bat and .ps1 shims) names cr or coderabbit with --use-credits or
 * --api-key, the call is denied. If it names cr and later review, and parsing found no call, it
 * counts one run. A segment that starts with grep, rg, echo, cat, Set-Content, Select-String, git or
 * gh only holds text and is not read. The raw check over-reports inside an executing program on
 * purpose, so a wrapper the parser does not know cannot hide a call.
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
 * Override: SKIP_CODERABBIT_GUARD=1 as a LEADING assignment (or `$env:SKIP_CODERABBIT_GUARD=1;` in
 * PowerShell). Each use writes an 'override' line to the guard decision log.
 *
 * Output contract: ALWAYS exit 0; blocks use permissionDecision deny via shared/output.ts.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { outputContinue, outputDeny } from './shared/output.js';
import { logGuardDecision } from './shared/guard-log.js';

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

/** What maskQuoted saw, by index: separators opened or closed by a substitution inside double quotes, and heredoc or here-string body characters. */
export interface MaskTrace {
  dqSubs: Set<number>;
  bodies: Set<number>;
}

/**
 * Same length as `command`, with data replaced by FILL: single-quoted and double-quoted text,
 * heredoc bodies and PowerShell here-strings. Command substitutions inside double quotes (and in
 * an unquoted heredoc body) stay readable, because the shell runs them.
 */
export function maskQuoted(command: string, ps = false, trace?: MaskTrace): string {
  const n = command.length;
  const out = command.split('');
  const esc = ps ? '`' : '\\';
  const modes: Array<'dq' | 'sub' | 'bt' | 'dbt'> = [];
  const depths: number[] = [];
  const heredocs: Heredoc[] = [];
  const fill = (from: number, to: number): void => {
    for (let k = Math.max(from, 0); k < Math.min(to, n); k++) out[k] = FILL;
  };
  /** Mask a body but keep its command substitutions when the shell would run them. */
  const maskBody = (from: number, to: number, expand: boolean): void => {
    let k = from;
    while (k < to) {
      const sub = command.startsWith('$(', k) ? closingParen(command, k + 2) : -1;
      const bt = !ps && command[k] === '`' ? command.indexOf('`', k + 1) : -1;
      const end = sub >= 0 ? sub : bt;
      if (expand && end >= 0 && end < to) k = end + 1;
      else {
        fill(k, k + 1);
        trace?.bodies.add(k);
        k++;
      }
    }
  };
  /** Mask every pending heredoc body, starting after the newline at `from - 1`. Returns the index of the last delimiter line's end. */
  const consumeHeredocs = (from: number): number => {
    let start = from;
    const bodies = heredocs.splice(0);
    for (const [at, h] of bodies.entries()) {
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
      if (at < bodies.length - 1) fill(stop, stop + 1);
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
        i++;
      } else if (c === '$' && command[i + 1] === '(') {
        trace?.dqSubs.add(i);
        modes.push('sub');
        depths.push(0);
        i += 2;
      } else if (c === '`' && !ps) {
        trace?.dqSubs.add(i);
        modes.push('dbt');
        i++;
      } else {
        fill(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === esc) {
      fill(i + 1, i + 2);
      i += 2;
    } else if (c === "'") {
      const j = command.indexOf("'", i + 1);
      if (j > 0) {
        fill(i + 1, j);
        i = j + 1;
      } else i++;
    } else if (c === '"') {
      if (hasClosing(command, i + 1, '"', esc)) modes.push('dq');
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
      depths.push(0);
      i += 2;
    } else if (c === '`' && !ps) {
      if (top === 'dbt') {
        trace?.dqSubs.add(i);
        modes.pop();
      } else if (top === 'bt') modes.pop();
      else modes.push('bt');
      i++;
    } else if (top === 'sub' && (c === '(' || c === ')')) {
      if (c === '(') depths[depths.length - 1]++;
      else if (depths[depths.length - 1] === 0) {
        modes.pop();
        depths.pop();
      } else depths[depths.length - 1]--;
      i++;
    } else i++;
  }
  return out.join('');
}

/** Start and end index of each command segment, untrimmed. A trace turns on `wholeQuotes` mode. */
function segmentRanges(command: string, ps: boolean, trace?: MaskTrace): Array<[number, number]> {
  const masked = maskQuoted(command, ps, trace);
  const sep = ps ? /\|\||&&|[;|&\n({}]|\$\(/g : /\|\||&&|[;|&\n({}]|\$\(|`/g;
  const ranges: Array<[number, number]> = [];
  let last = 0;
  for (const m of masked.matchAll(sep)) {
    if (trace?.dqSubs.has(m.index ?? -1)) continue;
    ranges.push([last, m.index ?? 0]);
    last = (m.index ?? 0) + m[0].length;
  }
  ranges.push([last, command.length]);
  return ranges;
}

/** Split on shell separators and braces. Quoted text and heredoc bodies stay inside their segment. */
export function segmentize(command: string, ps = false): string[] {
  return segmentRanges(command, ps)
    .map(([a, b]) => command.slice(a, b).trim())
    .filter(Boolean);
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

function tokenize(s: string): string[] {
  return s.split(/\s+/).map(cleanToken).filter(Boolean);
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

function isInfoRequest(args: string[]): boolean {
  return args.some((a) => /^(?:--help|-h|--version)$/i.test(a));
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
}

const NOT_ALLOWED =
  'CodeRabbit guard: allowed are `cr review --agent` (<=2 runs per PR), cr doctor, cr usage, cr auth login|status, --help, --version';

function classifyInvocation(inv: Invocation): SegmentClass {
  if (isSkillInstall(inv)) {
    return { verdict: 'block', reason: 'CodeRabbit guard: CodeRabbit skill installs are forbidden' };
  }
  if (!isCrExecutable(inv.exe)) return { verdict: 'ignore' };

  const forbidden = hasForbiddenFlags(inv.args);
  if (forbidden) return { verdict: 'block', reason: `CodeRabbit guard: ${forbidden} is forbidden` };
  if (isCodeWorkspace(inv.args)) {
    return { verdict: 'block', reason: 'CodeRabbit guard: code new/push is forbidden' };
  }
  if (isInfoRequest(inv.args)) return { verdict: 'allow' };
  if (isReviewAgent(inv.args)) return { verdict: 'allow', countsRun: true, runs: 1 };
  if (isReadOnlySubcommand(inv.args)) return { verdict: 'allow' };
  return { verdict: 'block', reason: NOT_ALLOWED };
}

// ---------------------------------------------------------------------------------------------
// Raw check: billing flags and hidden reviews, independent of how wrappers are parsed
// ---------------------------------------------------------------------------------------------

/** A standalone cr or coderabbit word: after a space, quote, path separator or bracket; not `.coderabbit.yaml`. */
const CR_WORD = /(?:^|[\s"'`(\\/=,{])(?:cr|coderabbit)(?:\.(?:exe|cmd|bat|ps1))?(?=$|[\s"'`)\\,}])/gi;
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

export interface RawScan {
  /** A cr or coderabbit word and a billing flag in one non-git, non-gh segment. */
  billing: boolean;
  /** The segments with a cr or coderabbit word followed later by the word review. `index` is the position in segmentize(). */
  reviewSegments: Array<{ index: number; raw: string }>;
}

/**
 * Read the RAW text of each segment whose leading program runs its text (EXECUTING_PROGRAMS) or is
 * cr or coderabbit: quotes, backticks, `$( )`, -ArgumentList strings and `bash -c` payloads
 * included. It does not parse wrappers, so an unknown wrapper option cannot hide a call. It
 * over-reports inside an executing program (`sh -c "grep 'cr review'"`) on purpose.
 */
export function rawScan(text: string, ps = false): RawScan {
  const found: RawScan = { billing: false, reviewSegments: [] };
  // A `$( )` inside double quotes does not split, so a commit message built with a heredoc stays one git segment.
  const trace: MaskTrace = { dqSubs: new Set(), bodies: new Set() };
  let index = -1;
  for (const [a, b] of segmentRanges(text, ps, trace)) {
    const seg = text.slice(a, b).trim();
    if (!seg) continue; // segmentize() drops empty segments, so the index skips them too
    index++;
    const program = leadingProgram(seg);
    if (!EXECUTING_PROGRAMS.has(program) && !isCrExecutable(program)) continue;
    // A heredoc body is data unless a shell, eval or wrapper receives it. `cat <<EOF` prose is not a call.
    const reads = SHELLS.has(program) || EVALS.has(program) || STARTERS.has(program) || RUNNERS.has(program) || program === 'cmd';
    const raw = reads ? seg : [...text.slice(a, b)].map((ch, k) => (trace.bodies.has(a + k) ? ' ' : ch)).join('').trim();
    const first = [...raw.matchAll(CR_WORD)][0];
    if (!first) continue;
    if (BILLING_WORD.test(raw)) found.billing = true;
    if (REVIEW_WORD.test(raw.slice((first.index ?? 0) + first[0].length))) found.reviewSegments.push({ index, raw });
  }
  return found;
}

const MAX_NESTING = 4;

/** Classify every command in `text`: a block wins, runs add up, wrapper strings are classified again. */
export function classifyCommand(text: string, ps = false, depth = 0): SegmentClass {
  // A wrapper string is scanned again, so a mix inside `bash -c "..."` counts per segment too.
  const raw = rawScan(text, ps);
  if (raw.billing) return { verdict: 'block', reason: BILLING_REASON };
  let runs = 0;
  let allowed = false;
  // Count per segment: the parsed runs if the parser found a CodeRabbit call there, else the raw
  // scan's one hidden run. A segment never counts twice, and a parsed run never hides a raw one.
  const hiddenAt = new Set(raw.reviewSegments.map((r) => r.index));
  for (const [index, seg] of segmentize(text, ps).entries()) {
    const inv = parseInvocation(seg);
    if (!inv) {
      if (hiddenAt.has(index)) runs++;
      continue;
    }
    let c: SegmentClass;
    if (inv.nested === undefined) c = classifyInvocation(inv);
    else if (depth < MAX_NESTING) c = classifyCommand(inv.nested, ps, depth + 1);
    else if (/\b(?:cr|coderabbit)\b/i.test(inv.nested)) c = { verdict: 'block', reason: 'CodeRabbit guard: wrapper nesting is too deep to check' };
    else c = { verdict: 'ignore' };
    if (c.verdict === 'block') return c;
    if (c.verdict === 'allow') allowed = true;
    // A segment that names cr and later review, where the parser found no CodeRabbit call (`--help` is a call it found): one run.
    runs += c.verdict === 'ignore' && hiddenAt.has(index) ? 1 : c.runs ?? 0;
  }
  if (runs > 0) return { verdict: 'allow', countsRun: true, runs };
  return { verdict: allowed ? 'allow' : 'ignore' };
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

const CD_SEGMENT = /^(?:cd|chdir|pushd|set-location|sl)\s+(?:(?:-\w+|\/d)\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/i;

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
}

export function decide(input: PreToolUseInput, env: NodeJS.ProcessEnv = process.env): DecideResult {
  const tool = input.tool_name || '';
  const command = input.tool_input?.command || '';

  if (OVERRIDE.test(command)) {
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
    return { allow: true };
  }

  if (!BASH_TOOLS.has(tool)) return { allow: true };

  const ps = tool === 'PowerShell';
  const verdict = classifyCommand(command, ps);
  if (verdict.verdict === 'block') return { allow: false, reason: verdict.reason };
  const runs = verdict.runs ?? 0;
  if (runs === 0) return { allow: true };

  const path = statePath(env);
  const state = readState(path);
  const key = repoBranchKey(effectiveCwd(command, input.cwd || process.cwd(), ps), env);
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

function readStdin(): string {
  return readFileSync(0, 'utf-8');
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
    logGuardDecision('coderabbit-guard', input, 'deny', result.reason || 'blocked', {
      command: input.tool_input?.command,
    });
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
