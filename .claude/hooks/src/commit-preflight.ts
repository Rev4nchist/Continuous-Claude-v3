#!/usr/bin/env node
/**
 * commit-preflight -- PreToolUse on Bash and PowerShell, acts only on `git commit`.
 *
 * In this repo "done" is a commit. This hook runs two checks at that moment.
 *
 * Check 1, the done-check. Is there proof that the change works? (A test run in the last 5
 * minutes that is not a ratchet, or a passing verify sidecar on this HEAD; see shared/done-proof.ts.)
 * No proof: advisory `additionalContext`. Advisory, never a block: retained transcripts show 21 of
 * 21 fail-then-done sequences were benign (ratchet baselines, expected-fail tests).
 *
 * Check 2, no feature work on main. A `feat` or `fix` commit on main or master gets
 * `permissionDecision: 'ask'`; unattended runs get the same text as advisory context. `chore`,
 * `docs` and the like stay silent. The message comes from `-m`, or from the first line of the
 * `-F <file>` message file (pr-and-commit-style.md tells the agent to commit with -F). A commit
 * with no message source (editor, -C), an unreadable file and stdin (`-F -`) stay silent. A `-m`
 * value that cannot be read statically (`"$msg"`, `"$(date)"`) is treated as feat/fix: on main
 * the hook asks rather than miss the rule.
 *
 * Every `git commit` of the command is checked, each in its own directory: `-C <path>`, and a
 * `cd <path>` before it. `--git-dir` and `--work-tree`, and a `cd` the hook cannot resolve
 * (`$VAR`, `~`, `-`), mean the repo is unknown: that call is skipped (fail open).
 *
 * Zero `git` spawns: the branch and HEAD come from reading files (shared/git-head.ts). Any error
 * means `{}` (fail open): a bug here must never block a commit.
 * One exception (cards prflow-push-blocks and coord-holdout-scan-warn): every commit makes ONE git read of the
 * index (stagedHoldoutCount). When the staged added lines hold a holdout id, a commit on a `re/` branch asks
 * ("the push will be refused") and a commit on any other branch gets a warning only, with a count only. It is
 * an early warning; the push check in decision-gate is the gate.
 *
 * Registered in settings.json on two matcher blocks (Bash, PowerShell), like
 * destructive-command-guard. The runtime gate below is the same two tools. The helpers live in
 * shared/ because a hook file runs main() at load; importing one hook from another would run both.
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { hasE2e, judge, latestSidecar, readTestRun } from './shared/done-proof.js';
import { VAL, gitCallRe, isGitToken, isSafeToken, safeCallRe } from './shared/git-call.js';
import { resolveHead } from './shared/git-head.js';
import { countIdsIn, loadHoldoutIds } from './shared/holdout-ids.js';
import { maskQuoted } from './shared/mask-quotes.js';
import { isUnattended } from './shared/unattended.js';
import { logGuardDecision } from './shared/guard-log.js';

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const PROTECTED_BRANCHES = new Set(['main', 'master']);
const FEAT_OR_FIX = /^(feat|fix)(\(|:|!)/;

export interface PreflightOptions {
  env?: NodeJS.ProcessEnv;
  /** Registry file; default ~/.claude/project-registry.json. */
  registryPath?: string;
  now?: number;
  /**
   * The early warning of the push scan (card prflow-push-blocks): how many holdout ids stand in the STAGED added lines of a commit on a `re/`
   * branch, or null when it cannot be read (fail open: this is feedback, the push check is the gate), or 'too-large' when the staged lines are
   * over STAGED_MAX_BYTES and were not read (the warning says so: card coord-decision-gate-round3-content-scan). Default: a git read of the index.
   */
  stagedHoldout?: (dir: string, mainRoot: string) => number | null | 'too-large';
}

/** Staged added lines above this size are not read: the warning says so, and the push check reads them (it has its own bound). */
const STAGED_MAX_BYTES = 1_500_000;

/** Default for PreflightOptions.stagedHoldout: one git read of the index. A count only; never an id. Fail open (null). */
export function stagedHoldoutCount(dir: string, mainRoot: string): number | null | 'too-large' {
  try {
    const r = spawnSync('git', ['diff', '--cached', '--unified=0', '--no-color', '--no-renames'], { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: STAGED_MAX_BYTES * 2, timeout: 5000 });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS' || (typeof r.stdout === 'string' && Buffer.byteLength(r.stdout, 'utf8') > STAGED_MAX_BYTES)) return 'too-large';
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    // Item 12 (card coord-decision-gate-round3-content-scan): every line that starts with + counts. An added line whose content starts with ++
    // shows as +++; the +++ file headers hold only a path, which may hold an id too.
    const added = r.stdout.split('\n').filter((l) => l.startsWith('+')).join('\n');
    return countIdsIn(added, loadHoldoutIds(mainRoot));
  } catch {
    return null;
  }
}

interface HookInput {
  tool_name?: string;
  tool?: string;
  tool_input?: { command?: unknown };
  session_id?: string;
  cwd?: string;
  permission_mode?: string;
}

export interface PreflightOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'ask';
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

// ---------------------------------------------------------------------------
// Finding the commit calls
// ---------------------------------------------------------------------------

// The regexes live in shared/git-call.ts (decision-gate finds `git push` with the same builder).
// Four contiguous groups cover the whole match: 1 the lead-in, 2 the executable token, 3 git's
// global options, 4 `commit`. Offsets in the masked view are offsets in the raw command.
const GIT_CALL = gitCallRe('commit');
const SAFE_CALL = safeCallRe('commit');

interface CommitCall {
  /** Where the call (with its lead-in) starts in the command. */
  index: number;
  /** Just after `commit`. */
  end: number;
  /** git's global options, raw (quoted values intact). */
  opts: string;
}

/** Every `git commit` and `git-safe.ps1 commit` at a command position, in command order. */
function findCommits(command: string, masked: string): CommitCall[] {
  const calls: CommitCall[] = [];
  for (const [re, valid] of [[GIT_CALL, isGitToken], [SAFE_CALL, isSafeToken]] as const) {
    for (const m of masked.matchAll(re)) {
      const tokenStart = m.index! + m[1].length;
      if (!valid(command.slice(tokenStart, tokenStart + m[2].length))) continue;
      const optsStart = tokenStart + m[2].length;
      calls.push({ index: m.index!, end: m.index! + m[0].length, opts: command.slice(optsStart, optsStart + m[3].length) });
    }
  }
  return calls.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// The directory of a call
// ---------------------------------------------------------------------------

const unquote = (s: string): string => s.replace(/^(["'])(.*)\1$/, '$2');

/** A Git Bash path (`/c/Users/x`) is a drive path (`C:/Users/x`) on Windows. */
const toNative = (p: string): string =>
  process.platform === 'win32' ? p.replace(/^\/([A-Za-z])(?=\/|$)/, (_m, d: string) => `${d.toUpperCase()}:`) : p;

const CD = new RegExp(String.raw`(?:^\s*|[;&|(\n{]\s*)(?:cd|pushd|Set-Location|sl)(?:\s+-(?:Path|LiteralPath))?\s+(${VAL})`, 'g');

/** A cd target the hook cannot resolve statically. */
const UNRESOLVABLE = /[$`%]|^~|^-$/;

function applyDir(dir: string, target: string): string | null {
  const p = unquote(target);
  if (!p || UNRESOLVABLE.test(p)) return null;
  const native = toNative(p);
  return isAbsolute(native) ? native : resolve(dir, native);
}

/**
 * The directory a commit runs in: cwd, then each `cd <path>` before the call, then each
 * `-C <path>` of the call. null when it cannot be known (`--git-dir`, `--work-tree`, an
 * unresolvable cd): the caller skips that call.
 */
function callDir(command: string, masked: string, call: CommitCall, cwd: string): string | null {
  if (/--(?:git-dir|work-tree)\b/.test(call.opts)) return null;
  let dir: string | null = cwd;
  for (const m of masked.slice(0, call.index).matchAll(CD)) {
    const at = m.index! + m[0].length - m[1].length;
    dir = applyDir(dir, command.slice(at, at + m[1].length));
    if (!dir) return null;
  }
  for (const m of call.opts.matchAll(/-C\s+("[^"]*"|'[^']*'|[^\s"']+)/g)) {
    dir = applyDir(dir, m[1]);
    if (!dir) return null;
  }
  return dir;
}

// ---------------------------------------------------------------------------
// The message of a call
// ---------------------------------------------------------------------------

function firstLine(s: string): string {
  return s.split(/\r?\n/)[0].trim();
}

/** The text of a quoted value up to its closing quote (a backslash escapes when `escapes`). */
function untilClosingQuote(s: string, q: string, escapes: boolean): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && escapes) { i++; continue; }
    if (s[i] === q) return s.slice(0, i);
  }
  return s;
}

function messageValueHead(value: string): string {
  const s = value.trimStart();
  const open = s.match(/^(@?)(\$?)(["'])/);
  if (!open) return s.split(/\s/)[0];
  const body = s.slice(open[0].length);
  const heredoc = body.match(/^\$\(\s*cat\s*<<-?\s*['"]?\w+['"]?\s*\r?\n/);
  if (heredoc) return firstLine(body.slice(heredoc[0].length));
  if (open[1]) return firstLine(body.replace(/^\s*\r?\n/, '')); // PowerShell here-string
  return firstLine(untilClosingQuote(body, open[3], open[3] === '"' || open[2] === '$'));
}

/** The first line of a message file, relative paths tried against each directory in turn. */
function fileHead(rawPath: string, dirs: string[]): string | null {
  const p = unquote(rawPath);
  if (!p || p === '-') return null;
  const native = toNative(p);
  const candidates = isAbsolute(native) ? [native] : dirs.map((d) => resolve(d, native));
  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trimStart();
      return text ? firstLine(text) : null;
    } catch {
      // not there: try the next directory
    }
  }
  return null;
}

// `-m`/`--message` (group 1) or `-F`/`--file` (group 2), alone or inside a short-flag cluster (`-am`).
const MSG_FLAG = /(?:^|\s)(?:(-[A-Za-z]*m|--message)(?:=|\s+|(?=["']))|(-[A-Za-z]*F|--file)(?:=|\s+))/;

/**
 * The first line of the message of one commit call, or null when it has no readable message.
 * Only the call's own segment is searched: a `-m` after `&&`, `;`, `|` or a newline belongs to a
 * later command (`&& git tag -m x`). Quoted text is masked for that search, so a `;` inside a
 * message does not end the segment.
 */
function messageHead(command: string, masked: string, call: CommitCall, dirs: string[]): string | null {
  const maskedRest = masked.slice(call.end);
  const cut = maskedRest.search(/&&|\|\||[;|\n]/);
  const scope = cut < 0 ? maskedRest : maskedRest.slice(0, cut);
  const flag = MSG_FLAG.exec(scope);
  if (!flag) return null;
  const value = command.slice(call.end + flag.index + flag[0].length);
  if (flag[1]) return messageValueHead(value);
  const file = value.match(/^("[^"]*"|'[^']*'|\S+)/);
  return file ? fileHead(file[1], dirs) : null;
}

/** A `$VAR` or `$(...)` message cannot be read: assume the worst on main. */
const isFeatOrFix = (head: string): boolean => FEAT_OR_FIX.test(head) || head.startsWith('$');

/**
 * The first line of the message of the first commit in `command` (see messageHead), or null.
 * `dir` is where a relative `-F` path is resolved; default: the process cwd. `-m` handles
 * `-m "x"`, `-am "x"`, `--message=x`, `$'x'`, a Bash `$(cat <<'EOF'` body and a PowerShell
 * here-string. A `$VAR` or `$(...)` value comes back starting with `$` (unresolved).
 */
export function commitMessageHead(command: string, dir: string = process.cwd()): string | null {
  const masked = maskQuoted(command);
  const call = findCommits(command, masked)[0];
  return call ? messageHead(command, masked, call, [dir]) : null;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

function mainBranchText(branch: string, dir: string): string {
  return (
    `On branch ${branch} in ${dir}. Rule: no feature work on main. ` +
    'Create a branch first: git switch -c <type>/<name>. Approve only for a sync or release commit.'
  );
}

/** Pure: the hook's decision for one payload. null = say nothing. */
export function preflight(input: HookInput | null | undefined, opts: PreflightOptions = {}): PreflightOutput | null {
  try {
    const tool = input?.tool_name || input?.tool || '';
    if (!COMMAND_TOOLS.has(tool)) return null;
    const command = input?.tool_input?.command;
    if (typeof command !== 'string') return null;
    const masked = maskQuoted(command, tool);
    const calls = findCommits(command, masked);
    if (calls.length === 0) return null;

    const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    let warn: string | null = null;
    let judged = false;
    let mainText: string | null = null;
    let holdoutText: string | null = null;
    let holdoutWarn: string | null = null;
    for (const call of calls) {
      const dir = callDir(command, masked, call, cwd);
      const head = dir ? resolveHead(dir) : null;
      if (!dir || !head) continue;
      if (!judged) {
        judged = true;
        const verdict = judge({
          run: readTestRun(input?.session_id),
          sidecar: latestSidecar(head.repoRoot),
          head: head.sha,
          hasE2e: hasE2e(head.repoRoot, head.mainRoot, opts.registryPath),
          now: opts.now ?? Date.now(),
        });
        warn = verdict.kind === 'proven' ? null : `commit-preflight: ${verdict.message}`;
      }
      // The staged added lines of every commit are read once (card coord-holdout-scan-warn, seat Q2: one reader of the staged diff).
      // On a re/ branch a hit asks, since the push will be refused. On any other branch it only warns (warn first), with a count only.
      // Each kind is scanned until its own text is set: a warning from one commit of the command must not hide a re/ ask of another,
      // and an ask must not hide a warning (CLI finding of 569660a7).
      const isRe = Boolean(head.branch?.startsWith('re/'));
      if (isRe ? !holdoutText : !holdoutWarn) {
        const n = (opts.stagedHoldout ?? stagedHoldoutCount)(dir, head.mainRoot);
        const ids = `${n} holdout id${n === 1 ? '' : 's'}`;
        if (n === 'too-large') holdoutWarn ??= `holdout-scan: the staged lines of this commit are over ${STAGED_MAX_BYTES} bytes and were not read. The push check reads them.`;
        else if (n !== null && n > 0 && isRe) holdoutText = `The staged lines of this commit on ${head.branch} hold ${ids}. The push will be refused. Remove them before you commit.`;
        else if (n !== null && n > 0 && !holdoutWarn) holdoutWarn = `holdout-scan: the staged lines of this commit hold ${ids}. Remove them before the commit leaves this machine (count only, warn mode).`;
      }
      if (mainText || !head.branch || !PROTECTED_BRANCHES.has(head.branch)) continue;
      const msg = messageHead(command, masked, call, [dir, cwd]);
      if (msg !== null && isFeatOrFix(msg)) mainText = mainBranchText(head.branch, head.repoRoot);
    }
    if (!judged) return null; // no repo could be read: fail open

    const askText = [mainText, holdoutText].filter(Boolean).join('\n');
    if (askText && !isUnattended(input ?? {}, opts.env ?? process.env)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: askText,
          ...(warn || holdoutWarn ? { additionalContext: [warn, holdoutWarn].filter(Boolean).join('\n') } : {}),
        },
      };
    }
    const context = [warn, askText, holdoutWarn].filter(Boolean).join('\n');
    if (!context) return null;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } };
  } catch {
    return null; // fail open
  }
}

function main(): void {
  let input: HookInput = {};
  try {
    const raw = readFileSync(0, 'utf8').trim();
    if (raw) input = JSON.parse(raw);
  } catch {
    console.log('{}');
    return;
  }
  const out = preflight(input);
  if (out?.hookSpecificOutput.permissionDecision === 'ask') {
    // A holdout row logs the rule name only: no command, no count, no id.
    if (/holdout id/.test(out.hookSpecificOutput.permissionDecisionReason ?? '')) logGuardDecision('commit-preflight', input, 'ask', 'holdout-staged', {});
    else logGuardDecision('commit-preflight', input, 'ask', 'commit-on-protected-branch', { command: String(input.tool_input?.command ?? '') });
  }
  console.log(JSON.stringify(out ?? {}));
}

// Auto-run only as a hook; VITEST imports the pure functions above.
if (!process.env.VITEST) {
  try {
    main();
  } catch {
    console.log('{}');
  }
}
