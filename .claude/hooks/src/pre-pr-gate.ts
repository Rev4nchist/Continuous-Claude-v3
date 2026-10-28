#!/usr/bin/env node
/**
 * pre-pr-gate -- PreToolUse (matcher: Bash, PowerShell).
 *
 * Denies a PR-create command in Rev4nchist/Continuous-Claude-v3 unless `node scripts/github/pre-pr.mjs`
 * passed for the head being opened. That script writes `.claude/cache/pre-pr/stamp.json` { head, at, ... }.
 * Why: CodeRabbit allows 8 PR reviews per hour for the one Rev4nchist identity. Checks that run before the
 * PR opens save reviews (.claudedocs/2026-10-27-coderabbit-review-budget.md).
 *
 * Shapes: `gh pr create ...` and `gh api ... /pulls` with a POST (isPrOpenCommand, shared with
 * pr-opened-review-loop). The match is on the raw command text. There is no shell lexer on purpose:
 * hand lexers in guards never converge. Known false positive: a command that only quotes the text
 * `gh pr create` in this repo. Write commit messages with `commit -F <file>` to avoid it.
 *
 * Posture: fail CLOSED only for a matched shape in the CCv3 repo (a missing, stale or unreadable stamp
 * denies). Everything else is allowed. Any internal error is allowed and logged.
 * Override: `SKIP_PRE_PR_GATE=1` as a LEADING assignment (`$env:SKIP_PRE_PR_GATE='1';` in PowerShell).
 * Dave only. The deny text does not mention it. Each use writes an `override` line to guard-decisions.jsonl.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { isPrOpenCommand, joinContinuations } from './pr-opened-review-loop.js';
import { guardLogPath, logGuardDecision } from './shared/guard-log.js';

export const CCV3_REPO = 'rev4nchist/continuous-claude-v3';
export const STAMP_REL = '.claude/cache/pre-pr/stamp.json';
export const MAX_STAMP_AGE_MS = 24 * 3_600_000;
/** A stamp this far in the future is a clock error, not a fresh stamp. */
const FUTURE_SLACK_MS = 5 * 60_000;
/** One git call may take this long. A decision makes up to 6 git calls (6 x 2 s = 12 s), inside the template timeout of 15 s. */
export const GIT_TIMEOUT_MS = 2000;
/**
 * The reasons a stamp may have skipped the CodeRabbit CLI review (pre-pr.mjs: cr_skip_reason). Allowed: "cli-missing" (cr is not installed); "cap" only with cr_finished_runs >= 1; "rate-limited" only with a known retry time. "flag" (--skip-cr),
 * "no-changes" (the CLI saw an empty scope) and "earlier-step-failed" are not allowed. "rate-limited" is allowed only
 * with a known retry time in the stamp (cr_retry_minutes), which the gate log also shows.
 */
const ALLOWED_SKIP_REASONS = new Set(['cli-missing']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const HOOK = 'pre-pr-gate';
const RUN = 'node scripts/github/pre-pr.mjs --body <file>';

export interface GitResult { status: number; stdout: string }
export interface Deps {
  git: (cwd: string, args: string[]) => GitResult;
  readFile: (path: string) => string | null;
  now: () => number;
  env: NodeJS.ProcessEnv;
  logError?: (message: string) => void;
}
export type Decision = { action: 'allow' } | { action: 'override' } | { action: 'deny'; reason: string; pattern: string };

interface HookInput { tool_name?: string; tool?: string; tool_input?: { command?: unknown }; cwd?: string; session_id?: string; agent_id?: string }

// ---------- raw-text readers (narrow on purpose) ----------

/** `owner/repo` (lower case) named by `repos/<o>/<r>/pulls` or `-R` / `--repo`, else null. */
export function namedRepo(command: string): string | null {
  const api = /repos\/([\w.-]+\/[\w.-]+)\/pulls\b/i.exec(command);
  if (api) return api[1].toLowerCase();
  const flag = /(?:^|\s)(?:-R|--repo)(?:\s+|=)["']?([\w.-]+\/[\w.-]+)/.exec(command);
  return flag ? flag[1].toLowerCase() : null;
}

/** The head branch a PR-create command names (`--head`, `-H`, `-f head=`), without an `owner:` prefix. */
export function headBranchOf(command: string): string | null {
  // -H is a header for gh api and the head only for gh pr create.
  const m = /(?:^|\s)(?:-[fF]|--(?:raw-)?field)\s*["']?head=["']?([^\s"']+)/.exec(command)
    ?? (/\bgh\s+pr\s+create\b/i.test(command) ? /(?:^|\s)(?:--head(?:\s+|=)|-H\s*)["']?([^\s"']+)/.exec(command) : null);
  return m ? m[1].replace(/^[^:\s]+:/, '').replace(/["']+$/, '') : null;
}

/** True for a git remote URL that points at the CCv3 fork. Exact: no suffix, no other owner. */
export function isCcv3Remote(url: string): boolean {
  const m = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m !== null && m[1].toLowerCase() === CCV3_REPO;
}

/** The directory a leading `cd <dir>` names, resolved against the hook cwd; else the cwd. */
function workDir(command: string, cwd: string): string {
  const m = /(?:^|[;&|]\s*|&&\s*)(?:cd|Set-Location|sl)\s+(?:-LiteralPath\s+|-Path\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/i.exec(command);
  if (!m) return cwd;
  const target = m[1].replace(/^["']|["']$/g, '');
  return isAbsolute(target) || /^[A-Za-z]:/.test(target) ? target : resolve(cwd, target);
}

/** The file `-F body=@<file>` or `--body-file <file>` names, or null (no body file, inline body, or stdin). */
export function bodyFileOf(command: string): string | null {
  const m = /(?:^|\s)(?:-F|--field)\s*["']?body=@([^\s"']+)/.exec(command) ?? /(?:^|\s)--body-file(?:\s+|=)["']?([^\s"']+)/.exec(command);
  return m && m[1] !== '-' ? m[1] : null;
}

/** The override: a LEADING assignment only (sh form or the PowerShell `$env:` form), or the process env. */
export function hasOverride(command: string, env: NodeJS.ProcessEnv): boolean {
  return env.SKIP_PRE_PR_GATE === '1'
    || /^\s*SKIP_PRE_PR_GATE=1\s+/.test(command)
    || /^\s*\$env:SKIP_PRE_PR_GATE\s*=\s*['"]?1['"]?\s*;/i.test(command);
}

// ---------- decision ----------

function deny(pattern: string, why: string): Decision {
  return {
    action: 'deny',
    pattern,
    reason: `BLOCKED (pre-pr-gate): ${why}\n\nRun this from the repo root, then open the PR again:\n  ${RUN}\n\n<file> is the draft PR body with the Evidence block (pr-and-commit-style.md). The script runs the gates for the files you changed, checks the Evidence against the head, and runs one CodeRabbit CLI review. It writes a stamp for the head. See pr-review-loop.md "Before you open a PR". CodeRabbit allows 8 PR reviews per hour for one identity, so checks run before the PR opens.`,
  };
}

function isCcv3Checkout(deps: Deps, dir: string): boolean | null {
  const r = deps.git(dir, ['remote', '-v']);
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).some((line) => {
    const url = line.split(/\s+/)[1];
    return url !== undefined && isCcv3Remote(url);
  });
}

/** Checkouts that may hold the stamp: the command's own, then any worktree that has the named branch checked out. */
function stampRoots(deps: Deps, dir: string, root: string, branch: string | null): string[] {
  const roots = [root];
  if (!branch) return roots;
  const r = deps.git(dir, ['worktree', 'list', '--porcelain']);
  if (r.status !== 0) return roots;
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path && ref === branch && !roots.includes(path.trim())) roots.push(path.trim());
  }
  return roots;
}

interface BodyCheck { path: string; sha: string | null }

function stampProblem(raw: string | null, head: string, now: number, body: BodyCheck | null): string | null {
  if (raw === null) return 'no stamp. The pre-PR check has not passed in this checkout';
  let s: unknown;
  try { s = JSON.parse(raw); } catch { return 'the stamp is not valid JSON'; }
  const o = s as { head?: unknown; at?: unknown; cr_skipped?: unknown; cr_skip_reason?: unknown; cr_retry_minutes?: unknown; cr_finished_runs?: unknown; body_sha256?: unknown } | null;
  if (!o || typeof o !== 'object' || typeof o.head !== 'string' || o.head === '') return 'the stamp has no head';
  const at = typeof o.at === 'string' ? Date.parse(o.at) : NaN;
  if (!Number.isFinite(at)) return 'the stamp has no valid time';
  if (o.head.toLowerCase() !== head.toLowerCase()) return `the stamp is for commit ${o.head.slice(0, 7)}, the head being opened is ${head.slice(0, 7)}`;
  if (now - at > MAX_STAMP_AGE_MS) return 'the stamp is older than 24 hours';
  if (at - now > FUTURE_SLACK_MS) return 'the stamp time is in the future';
  const reason = String(o.cr_skip_reason);
  const waitKnown = reason === 'rate-limited' && typeof o.cr_retry_minutes === 'number' && o.cr_retry_minutes > 0;
  const capEarned = reason === 'cap' && typeof o.cr_finished_runs === 'number' && o.cr_finished_runs >= 1;
  if (o.cr_skipped === true && reason === 'cap' && !capEarned) {
    return `the stamp skipped the CodeRabbit CLI review for the run cap, but no CLI run on this branch has finished with a PASS (cr_finished_runs: ${String(o.cr_finished_runs ?? 'none')}). The cap counts runs that finished with a PASS. Fix the CLI and run pre-pr.mjs again`;
  }
  if (o.cr_skipped === true && !ALLOWED_SKIP_REASONS.has(reason) && !waitKnown && !capEarned) {
    return `the stamp skipped the CodeRabbit CLI review (reason: ${o.cr_skip_reason || 'none'}). Only a finished-run cap, a missing CLI (cli-missing), or a rate limit with a known retry time allows a skip. A broken CLI (cli-error) costs nothing to retry. Run pre-pr.mjs again without --skip-cr`;
  }
  if (body) {
    if (body.sha === null) return `the body file ${body.path} cannot be read, so it cannot be matched to the body pre-pr.mjs checked`;
    if (o.body_sha256 !== body.sha) return `the body file ${body.path} is not the body pre-pr.mjs checked (its hash differs from the stamp). Run pre-pr.mjs on this file`;
  }
  return null;
}

/** The pushed head: refs/remotes/fork/<branch>, when it exists, must be the stamped head (a PR opens at the pushed head). */
function pushedProblem(deps: Deps, root: string, branch: string | null, head: string): string | null {
  const name = branch ?? deps.git(root, ['branch', '--show-current']).stdout.trim();
  if (!name) return null;
  const r = deps.git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/fork/${name}^{commit}`]);
  if (r.status !== 0) return null;
  const pushed = r.stdout.trim();
  if (pushed.toLowerCase() === head.toLowerCase()) return null;
  return `the pushed head fork/${name} is ${pushed.slice(0, 7)}, not the stamped head ${head.slice(0, 7)}. Push the stamped commit, or run pre-pr.mjs again`;
}

/** Pure given its deps. Allow, override (a deny that the override let through; it is logged) or deny. */
export function decide(input: HookInput, deps: Deps): Decision {
  const raw = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  const command = joinContinuations(raw);
  const d = gate(input, command, deps);
  return d.action === 'deny' && hasOverride(command, deps.env) ? { action: 'override' } : d;
}

function gate(input: HookInput, command: string, deps: Deps): Decision {
  if (!isPrOpenCommand(command)) return { action: 'allow' };
  const dir = workDir(command, input.cwd || process.cwd());
  const named = namedRepo(command);
  const isCcv3 = named !== null ? named === CCV3_REPO : isCcv3Checkout(deps, dir);
  if (!isCcv3) return { action: 'allow' };
  const top = deps.git(dir, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return deny('no-checkout', `this command opens a PR in ${CCV3_REPO}, but ${dir} is not a git checkout, so no pre-PR stamp can be found`);
  const root = top.stdout.trim();
  const branch = headBranchOf(command);
  const headRun = deps.git(root, ['rev-parse', branch ? `${branch}^{commit}` : 'HEAD']);
  if (headRun.status !== 0) return deny('head-unresolved', `cannot resolve the head ${branch ?? 'HEAD'} in ${root}`);
  const head = headRun.stdout.trim();
  const bodyPath = bodyFileOf(command);
  const body = bodyPath ? { path: bodyPath, sha: sha256Of(deps.readFile(resolve(dir, bodyPath))) } : null;
  const problems = stampRoots(deps, dir, root, branch).map((r) => stampProblem(deps.readFile(join(r, STAMP_REL)), head, deps.now(), body));
  if (!problems.some((p) => p === null)) return deny('stamp', problems[0] ?? 'no stamp');
  const pushed = pushedProblem(deps, root, branch, head);
  return pushed ? deny('pushed-head', pushed) : { action: 'allow' };
}

const sha256Of = (text: string | null): string | null => (text === null ? null : createHash('sha256').update(text).digest('hex'));

// ---------- hook plumbing ----------

/** The whole hook: raw stdin text in, stdout text out. Never throws. */
export function handle(raw: string, deps: Deps): string {
  try {
    const input = JSON.parse(raw.trim() || '{}') as HookInput;
    const tool = input.tool_name || input.tool || '';
    if (!COMMAND_TOOLS.has(tool)) return '{}';
    const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
    const d = decide(input, deps);
    if (d.action === 'override') logGuardDecision(HOOK, input, 'override', 'SKIP_PRE_PR_GATE', { command });
    if (d.action !== 'deny') return '{}';
    logGuardDecision(HOOK, input, 'deny', d.pattern, { command });
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } });
  } catch (err) {
    try { deps.logError?.(String((err as Error)?.message ?? err)); } catch { /* the log never blocks */ }
    return '{}';
  }
}

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => { status: number | null; stdout?: string | null; error?: Error };

/** A git runner. A git exit code is a result. A timeout or a spawn error throws: the hook then fails open and logs. */
export function makeGit(spawn: SpawnFn = spawnSync as unknown as SpawnFn): Deps['git'] {
  return (cwd, args) => {
    const r = spawn('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout ?? '' };
  };
}

function realDeps(): Deps {
  return {
    git: makeGit(),
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    now: () => Date.now(),
    env: process.env,
    logError: (message) => {
      const file = join(dirname(guardLogPath(process.env)), 'pre-pr-gate-errors.jsonl');
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), hook: HOOK, error: message.slice(0, 300) })}\n`);
    },
  };
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  console.log(handle(Buffer.concat(chunks).toString('utf-8'), realDeps()));
}

// Auto-run only as a hook; VITEST imports the pure functions above.
if (!process.env.VITEST) {
  main().catch(() => { console.log('{}'); });
}
