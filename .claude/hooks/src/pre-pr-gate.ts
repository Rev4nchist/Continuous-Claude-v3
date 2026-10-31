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
 * Posture: fail CLOSED for a matched PR-create shape: a missing, stale or unreadable stamp denies, and so does an internal
 * error while the stamp is checked (git timeout, git or spawn error, remotes that cannot be listed). The error is logged.
 * The PR body must be exactly one file (-F body=@<file>, --body-file <file>, or -F <file> for gh pr create). An inline body, stdin, --fill,
 * --input, and a second body source (a repeated flag, --body, -b, -f body=) cannot be hashed and are denied.
 * The checkout decides the target; only a CCv3 signal overrides it. A CCv3 signal anywhere in the raw text (a CCv3 -R / --repo / GH_REPO value,
 * the process env GH_REPO, a repos/<o>/<r>/ endpoint text, a PR URL) names CCv3, and that command must run in a CCv3 checkout.
 * The hook never names a foreign repo: a gated command from a CCv3 checkout is always gated, whatever -R it holds.
 * Any cd, Set-Location, sl, pushd or Push-Location target in the text (before or after the call, quoted or not) that is a CCv3 checkout gates too, as the cwd does.
 * Accepted residual: from a foreign checkout, a CCv3 -R hidden by shell syntax (v""3, -dR) is not seen. The hook guards against mistakes, not a hostile agent.
 * Everything else is allowed: another tool, a command that is not a PR create, a repo that is not CCv3, and input that
 * cannot be parsed (there is no command to judge).
 * Override: `SKIP_PRE_PR_GATE=1` as a LEADING assignment (`$env:SKIP_PRE_PR_GATE='1';` in PowerShell).
 * Dave only. The deny text does not mention it. Each use writes an `override` line to guard-decisions.jsonl.
 *
 * PR Checkpoint rules (PR B; spec .claudedocs/2026-10-28-pr-checkpoint-mod-spec.md section 3.2). The shapes are read by
 * shared/checkpoint-shapes.ts from raw text, with no shell lexer. Patterns, in the order they are judged, after the stamp rules:
 *   self-confirm     text that names pr-checkpoint with --confirm or --apply (any checkout). Only Dave's press in /pathway records a pathway.
 *   nonliteral-repo  a --repo or -R value with $, a backtick or %VAR% on a create, ready or label shape (any checkout).
 *   non-draft        a CCv3 PR create with no explicit draft-true token.
 *   ready            `gh pr ready` or markPullRequestReadyForReview on CCv3: always denied; a pathway never opens it. `--undo` in the same command segment is allowed.
 *   review-label     a review: label add on CCv3 (--add-label, a labels endpoint, gh pr create --label). Allowed only when pathway.json names HEAD and its label equals the one added.
 * Mode: `checkpoint.enforce` in <git toplevel of the cwd>/review-router.config.json. Only a boolean true enforces. Anything else is warn mode:
 * the command is allowed and one `warn` row goes to guard-decisions.jsonl. The stamp rules above are enforced in both modes.
 * Exception, fail closed: when that config is missing, unreadable or not valid JSON (a home directory, a non-CCv3 checkout, a CCv3 branch that
 * predates the file) the checkpoint rules enforce if ANY of these holds: the command text holds a CCv3 signal (namedRepo: -R / --repo / GH_REPO,
 * a repos/<o>/<r>/ endpoint, a PR URL); the command is a self-confirm (repo-free; pr-checkpoint is CCv3-only); or the command runs in a CCv3
 * checkout (the cwd, or a cd target in the text: the same test the ready, label and non-draft rules use).
 * A readable config keeps its own value (false = warn). Any other command is unchanged.
 * An internal error while judging any gated shape denies in both modes (verify-error). A git that cannot be found denies with its own
 * message (git-not-found: names the cause and the fix). A leading override logs `override`, not `warn`.
 * Accepted residual risks: GraphQL with the query text in a file (-F query=@file) shows no label or ready text;
 * `gh pr ready --undo` inside quotes is read as a ready (fail closed); a quoted -F "draft=true" is read as non-draft (fail closed);
 * a hand-written pathway.json (the Write tool) or an indirect script is accepted until the lock of spec section 3.6 (spike S2);
 * a confirmed label is tied to HEAD, not to a PR number, so `gh pr edit <other> --add-label <label>` passes while that pathway stands;
 * a subcommand built from a variable (`gh pr $sub 201`) is not read; and a non-literal-repo command (`-R $REPO`) with no CCv3 signal,
 * run from a non-CCv3 checkout with no usable config, is warn mode.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'path';
import { isPrOpenCommand, joinContinuations, normalizeGh } from './pr-opened-review-loop.js';
import { CCV3_REPO, isGated, namedRepo, shapesOf, type LabelShape, type Shapes } from './shared/checkpoint-shapes.js';
import { guardLogPath, logGuardDecision, logGuardError } from './shared/guard-log.js';

export { CCV3_REPO, namedRepo };
export const STAMP_REL = '.claude/cache/pre-pr/stamp.json';
/** The pathway record pr-checkpoint.mjs --confirm writes next to the stamp. */
export const PATHWAY_REL = '.claude/cache/pre-pr/pathway.json';
const CONFIG_REL = 'review-router.config.json';
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
const BODY_UNVERIFIABLE = 'the PR body is not a file, so it cannot be matched to the body pre-pr.mjs checked. Pass the body as a file: -F body=@<file> (gh api) or --body-file <file> (gh pr create). An inline body, a body from stdin, --fill and --fill-first are denied';

export interface GitResult { status: number; stdout: string }
export interface Deps {
  git: (cwd: string, args: string[]) => GitResult;
  readFile: (path: string) => string | null;
  now: () => number;
  env: NodeJS.ProcessEnv;
  logError?: (message: string) => void;
}
/**
 * `warn` on an allow: a PR B rule fired in warn mode. handle() logs it. `soft` on a deny: a PR B rule (not a stamp rule),
 * which warn mode turns into an allow.
 */
export type Decision =
  | { action: 'allow'; warn?: string }
  | { action: 'override' }
  | { action: 'deny'; reason: string; pattern: string; soft?: boolean };

interface HookInput { tool_name?: string; tool?: string; tool_input?: { command?: unknown }; cwd?: string; session_id?: string; agent_id?: string }

// ---------- raw-text readers (narrow on purpose) ----------

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

const CD_TARGET = /(?:^|[;&|\r\n]\s*)(?:cd|Set-Location|sl|pushd|Push-Location)\s+(?:-LiteralPath\s+|-Path\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
const resolveIn = (cwd: string, target: string): string => {
  const t = target.replace(/^["']|["']$/g, '');
  return isAbsolute(t) || /^[A-Za-z]:/.test(t) ? t : resolve(cwd, t);
};

/** The directory the first `cd <dir>` names, resolved against the hook cwd; else the cwd. */
function workDir(command: string, cwd: string): string {
  const m = new RegExp(CD_TARGET.source, 'i').exec(command);
  return m ? resolveIn(cwd, m[1]) : cwd;
}

/**
 * Every directory a cd, Set-Location, sl, pushd or Push-Location in the text names, plus the cwd. Read from the raw text and from the text with
 * its quotes deleted. No lexing: a target inside quoted text counts too, which can only gate more (fail closed).
 */
function candidateDirs(command: string, cwd: string): string[] {
  const texts = [command, command.replace(/["']/g, '')];
  const targets = texts.flatMap((t) => [...t.matchAll(CD_TARGET)].map((m) => resolveIn(cwd, m[1].replace(/["']+$/, ''))));
  return [...new Set([cwd, ...targets])];
}

/**
 * The file `-F body=@<file>` or `--body-file <file>` names, or null (no body file, inline body, or stdin).
 * A quoted path keeps its spaces: the whole quoted text is the file name. A stdin marker `-` is null, quoted or not.
 */
const FIELD_BODY = /(?:^|\s)(?:-F|--field)(?:=|\s*)(?:"body=@([^"]+)"|'body=@([^']+)'|body=@(?:"([^"]+)"|'([^']+)'|([^\s"']+)))/;
const BODY_FILE = /(?:^|\s)--body-file(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/;
/** `-F <file>` is the short form of --body-file for `gh pr create` only. For `gh api`, -F is a field flag. */
const SHORT_BODY_FILE = /(?:^|\s)-F\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/;
/** A second source of the body: --body, -b, -f / -F body=<text>. gh may take the last one, so the file would not be the body. */
const INLINE_BODY = /(?:^|\s)(?:--body(?![\w-])|-b)|(?:^|\s)(?:-f|--raw-field)(?:=|\s*)["']?body=|(?:^|\s)(?:-F|--field)(?:=|\s*)["']?body=(?!@)/;
/** `gh api --input <file>` posts that file as the request body, so the -F fields are not the body. */
const INPUT_FLAG = /(?:^|\s)--input(?![\w-])/;

/** Every body file the command names, in order. More than one means gh may use another than the first. */
function bodyFilesOf(command: string): string[] {
  const sources = [FIELD_BODY, BODY_FILE, ...(/\bgh\s+pr\s+create\b/i.test(command) ? [SHORT_BODY_FILE] : [])];
  return sources.flatMap((re) => [...command.matchAll(new RegExp(re.source, 'g'))].map((m) => m.slice(1).find((g) => g !== undefined) ?? ''));
}

export function bodyFileOf(command: string): string | null {
  const path = bodyFilesOf(command)[0];
  return path !== undefined && path !== '-' ? path : null;
}

/** The one body file the command posts, or null when the body cannot be tied to a single file (none, stdin, inline, --input, or several). */
function singleBodyFile(command: string): string | null {
  const files = bodyFilesOf(command);
  if (files.length !== 1 || INLINE_BODY.test(command) || INPUT_FLAG.test(command)) return null;
  return bodyFileOf(command);
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

/** True when a remote of the checkout is the CCv3 fork. Throws when git cannot list the remotes: the repo is then not known, and handle() denies. */
function isCcv3Checkout(deps: Deps, dir: string): boolean {
  const r = deps.git(dir, ['remote', '-v']);
  if (r.status !== 0) throw new Error(`git remote -v failed in ${dir} (exit ${r.status})`);
  return r.stdout.split(/\r?\n/).some((line) => {
    const url = line.split(/\s+/)[1];
    return url !== undefined && isCcv3Remote(url);
  });
}

/** isCcv3Checkout for a directory the text only mentions: a directory that git cannot read (it may not exist) is not a CCv3 checkout. */
function isCcv3Dir(deps: Deps, dir: string): boolean {
  try { return isCcv3Checkout(deps, dir); } catch { return false; }
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
    if (body.sha === null) return `the body file ${body.path} cannot be read, so it cannot be matched to the body pre-pr.mjs checked. Use an absolute path or a path relative to the working directory. The hook does not expand ~, $env: or /c/ paths`;
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

/** The shell that runs the command: the PowerShell tool runs pwsh; the Bash tool runs bash. */
const shellOf = (input: HookInput): 'bash' | 'pwsh' => ((input.tool_name || input.tool) === 'PowerShell' ? 'pwsh' : 'bash');

/** Per-decision memo of the facts several rules share, so a decision spawns each git call at most once. */
interface Ctx {
  /** The directory the command acts in (the first `cd` moves it). */
  dir: string;
  /** CCV3_REPO when the command holds a CCv3 signal, else null (the checkout decides). A non-literal value beside a CCv3 signal does not hide it. */
  named: string | null;
  top: (dir: string) => string | null;
  ccv3: () => boolean;
  enforcing: () => boolean;
}

const once = <T>(f: () => T): (() => T) => {
  let box: { v: T } | undefined;
  return () => (box ??= { v: f() }).v;
};

function makeCtx(input: HookInput, command: string, deps: Deps, shapes: Shapes): Ctx {
  const cwd = input.cwd || process.cwd();
  const dir = workDir(command, cwd);
  const named = namedRepo(command, deps.env);
  const tops = new Map<string, string | null>();
  const top = (d: string): string | null => {
    if (!tops.has(d)) {
      const r = deps.git(d, ['rev-parse', '--show-toplevel']);
      tops.set(d, r.status === 0 ? r.stdout.trim() : null);
    }
    return tops.get(d) ?? null;
  };
  const inCcv3 = once(() => named === CCV3_REPO || isCcv3Checkout(deps, dir) || candidateDirs(command, cwd).some((d) => d !== dir && isCcv3Dir(deps, d)));
  return {
    dir, named, top,
    ccv3: inCcv3,
    // No usable config in the cwd checkout: fail closed for a command that names CCv3, a self-confirm (repo-free, pr-checkpoint is CCv3-only)
    // and a command that runs in a CCv3 checkout. Any other command is warn mode. A readable config keeps its own value.
    enforcing: once(() => enforceIn(deps, top(cwd)) ?? (named === CCV3_REPO || shapes.self || inCcv3())),
  };
}

/** checkpoint.enforce of <toplevel>/review-router.config.json: true only for a boolean true. null when the file is missing, unreadable or not valid JSON. */
function enforceIn(deps: Deps, top: string | null): boolean | null {
  const text = top === null ? null : deps.readFile(join(top, CONFIG_REL));
  if (text === null) return null;
  try { return (JSON.parse(text) as { checkpoint?: { enforce?: unknown } } | null)?.checkpoint?.enforce === true; } catch { return null; }
}

/** Pure given its deps. Allow, override (a deny that the override let through; it is logged) or deny. */
export function decide(input: HookInput, deps: Deps): Decision {
  const raw = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  const command = normalizeGh(joinContinuations(raw, shellOf(input)));
  const shapes = shapesOf(command);
  if (!isGated(shapes)) return { action: 'allow' };
  const ctx = makeCtx(input, command, deps, shapes);
  const d = judge(command, deps, ctx, shapes);
  if (d.action !== 'deny') return d;
  if (hasOverride(command, deps.env)) return { action: 'override' };
  return d.soft && !ctx.enforcing() ? { action: 'allow', warn: d.pattern } : d;
}

function judge(command: string, deps: Deps, ctx: Ctx, shapes: Shapes): Decision {
  const stamp = shapes.create ? stampDeny(command, deps, ctx) : null;
  return stamp ?? checkpointDeny(deps, ctx, shapes) ?? { action: 'allow' };
}

/** The stamp rules of #193 and #197. Enforced in both modes. */
function stampDeny(command: string, deps: Deps, ctx: Ctx): Decision | null {
  const { dir, named } = ctx;
  if (!ctx.ccv3()) return null;
  const top = ctx.top(dir);
  if (top === null) return deny('no-checkout', `this command opens a PR in ${CCV3_REPO}, but ${dir} is not a git checkout, so no pre-PR stamp can be found`);
  // An explicit target skipped the checkout test above: the stamp of a foreign checkout must not open a CCv3 PR.
  if (named !== null && !isCcv3Checkout(deps, dir)) return deny('repo-identity', `this command names ${CCV3_REPO}, but ${dir} is not a CCv3 checkout, so its stamp does not count`);
  const bodyPath = singleBodyFile(command);
  if (bodyPath === null) return deny('body', BODY_UNVERIFIABLE);
  const branch = headBranchOf(command);
  const headRun = deps.git(top, ['rev-parse', branch ? `${branch}^{commit}` : 'HEAD']);
  if (headRun.status !== 0) return deny('head-unresolved', `cannot resolve the head ${branch ?? 'HEAD'} in ${top}`);
  const head = headRun.stdout.trim();
  const body = { path: bodyPath, sha: sha256Of(deps.readFile(resolve(dir, bodyPath))) };
  const problems = stampRoots(deps, dir, top, branch).map((r) => stampProblem(deps.readFile(join(r, STAMP_REL)), head, deps.now(), body));
  if (!problems.some((p) => p === null)) return deny('stamp', problems[0] ?? 'no stamp');
  const pushed = pushedProblem(deps, top, branch, head);
  return pushed ? deny('pushed-head', pushed) : null;
}

// ---------- the checkpoint rules (PR B) ----------

function soft(pattern: string, why: string): Decision {
  return { action: 'deny', pattern, soft: true, reason: `BLOCKED (pre-pr-gate): ${why}` };
}

const SELF_WHY = 'pr-checkpoint --confirm and --apply record and spend a review pathway. Only Dave\'s press in the /pathway mod does that. Do not run them from a shell. The read-only form (node scripts/github/pr-checkpoint.mjs --json) is allowed.';
const LITERAL_WHY = 'pass a literal OWNER/REPO to --repo or -R. A value with $, a backtick or %VAR% hides the target repo from this gate.';
const DRAFT_WHY = `open as draft; run /pathway. Open the PR with gh pr create --draft (gh api: -F draft=true). The /pathway mod picks the review pathway and marks the PR ready after Dave presses it.`;
const READY_WHY = 'gh pr ready is not run from a shell. Run /pathway: when Dave presses a pathway, the mod adds the review label and marks the PR ready. To return a PR to draft, use gh pr ready --undo.';
const LABEL_WHY = 'a review: label is set only by /pathway, for the pathway Dave confirmed for this head. Do not add one by hand, and do not use a command whose label text is hidden. Run /pathway.';

/** The first PR B rule the command breaks, or null. Rules past the repo-free ones apply to CCv3 only. */
function checkpointDeny(deps: Deps, ctx: Ctx, shapes: Shapes): Decision | null {
  if (shapes.self) return soft('self-confirm', SELF_WHY);
  if (shapes.nonLiteral) return soft('nonliteral-repo', LITERAL_WHY);
  if (!ctx.ccv3()) return null;
  if (shapes.nonDraft) return soft('non-draft', DRAFT_WHY);
  if (shapes.ready) return soft('ready', READY_WHY);
  if (shapes.label && !labelAllowed(shapes.label, deps, ctx)) return soft('review-label', LABEL_WHY);
  return null;
}

/** A review: label add is allowed only for the one label pathway.json (for HEAD) names. A blind add is never allowed. */
function labelAllowed(label: LabelShape, deps: Deps, ctx: Ctx): boolean {
  if (label.blind || label.labels.length !== 1) return false;
  return pathwayLabel(deps, ctx) === label.labels[0];
}

/** The lower-case label of pathway.json when it names HEAD (`git rev-parse HEAD` at the toplevel), else null. */
function pathwayLabel(deps: Deps, ctx: Ctx): string | null {
  const top = ctx.top(ctx.dir);
  const text = top === null ? null : deps.readFile(join(top, PATHWAY_REL));
  const head = top === null ? null : deps.git(top, ['rev-parse', 'HEAD']);
  if (text === null || head === null || head.status !== 0) return null;
  let p: { head?: unknown; label?: unknown } | null;
  try { p = JSON.parse(text) as typeof p; } catch { return null; }
  if (!p || typeof p.head !== 'string' || typeof p.label !== 'string') return null;
  return p.head.toLowerCase() === head.stdout.trim().toLowerCase() ? p.label.toLowerCase() : null;
}

const sha256Of = (text: string | null): string | null => (text === null ? null : createHash('sha256').update(text).digest('hex'));

// ---------- hook plumbing ----------

/** The whole hook: raw stdin text in, stdout text out. Never throws. */
export function handle(raw: string, deps: Deps): string {
  let input: HookInput = {};
  let command = '';
  let gated = false;
  let create = false;
  try {
    try {
      input = JSON.parse(raw.trim() || '{}') as HookInput;
    } catch (parseErr) {
      // Parse doubt: fail closed on the raw text. A payload whose text reads as a PR create is denied; any other
      // unreadable payload allows, because this hook sees every Bash and PowerShell call (deny-all would block them all).
      try { deps.logError?.(String((parseErr as Error)?.message ?? parseErr)); } catch { /* the log never blocks */ }
      if (!isPrOpenCommand(raw)) return '{}';
      logGuardDecision(HOOK, {}, 'deny', 'unreadable-input', { command: raw.slice(0, 500) });
      const why = `BLOCKED (pre-pr-gate): could not read the hook input, and its text looks like a PR create, so the pre-PR stamp could not be checked. Run the command again. If it keeps failing, ask Dave.\n\nThe stamp comes from: ${RUN}`;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
    }
    const tool = input.tool_name || input.tool || '';
    if (!COMMAND_TOOLS.has(tool)) return '{}';
    command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
    // Known before anything can throw: an error on a gated shape must not let the command through unchecked.
    create = isPrOpenCommand(command);
    gated = create || isGated(shapesOf(joinContinuations(command, shellOf(input))));
    const d = decide(input, deps);
    if (d.action === 'override') logGuardDecision(HOOK, input, 'override', 'SKIP_PRE_PR_GATE', { command });
    if (d.action === 'allow' && d.warn) logGuardDecision(HOOK, input, 'warn', d.warn, { command });
    if (d.action !== 'deny') return '{}';
    logGuardDecision(HOOK, input, 'deny', d.pattern, { command });
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } });
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    try { deps.logError?.(message); } catch { /* the log never blocks */ }
    // Unparsable input, another tool, or a command that is not a gated shape: nothing to guard, so allow.
    if (!gated) return '{}';
    // A gated command that could not be checked (git timeout, git error, unreadable stamp): the leading override allows it, else deny.
    // This holds in both modes: warn mode excuses a rule hit, not a gate that could not decide.
    if (hasOverride(joinContinuations(command, shellOf(input)), deps.env)) {
      logGuardDecision(HOOK, input, 'override', 'SKIP_PRE_PR_GATE', { command });
      return '{}';
    }
    if ((err as { code?: string } | null)?.code === GIT_NOT_FOUND) {
      // Name the cause and the fix. A generic "could not verify" text hides a missing git.
      logGuardDecision(HOOK, input, 'deny', 'git-not-found', { command });
      const why = `BLOCKED (pre-pr-gate): ${message.slice(0, 400)}\n\nThe gate needs git to check ${create ? 'the pre-PR stamp' : 'the PR checkpoint rules'}.`;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
    }
    logGuardDecision(HOOK, input, 'deny', 'verify-error', { command });
    const what = create ? 'the pre-PR stamp' : 'the PR checkpoint rules';
    const reason = `BLOCKED (pre-pr-gate): could not verify ${what} (${message.slice(0, 200)}). Run the command again. If it keeps failing, ask Dave.\n\nThe stamp comes from: ${RUN}`;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  }
}

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => { status: number | null; stdout?: string | null; error?: Error };

/** `code` of the error makeGit throws when no git program can be run. handle() reads it. */
export const GIT_NOT_FOUND = 'GIT_NOT_FOUND';

const GIT_FIX = 'Fix: install Git for Windows (https://git-scm.com/download/win) or add its cmd folder (for example C:\\Program Files\\Git\\cmd) to PATH, then run the command again.';

function gitNotFound(detail: string): Error {
  return Object.assign(new Error(`git not found on PATH: ${detail}. ${GIT_FIX}`), { code: GIT_NOT_FOUND });
}

/**
 * The absolute path of a git program, or null. Looks in PATH first, then in the standard install
 * places. The hook process can start with a PATH that has no git (the desktop app does this), so a
 * bare `git` fails there with ENOENT. `exists` and `platform` are parameters so a test does not
 * depend on this machine.
 */
export function resolveGit(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const win = platform === 'win32';
  const p = win ? win32 : posix;
  const exe = win ? 'git.exe' : 'git';
  const dirs = (env.PATH ?? env.Path ?? '').split(p.delimiter).map((d) => d.replace(/^"|"$/g, '')).filter(Boolean);
  const candidates = dirs.map((d) => p.join(d, exe));
  if (win) {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter((r): r is string => !!r);
    for (const root of roots) candidates.push(p.join(root, 'Git', 'cmd', exe), p.join(root, 'Git', 'bin', exe));
    if (env.LOCALAPPDATA) candidates.push(p.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', exe));
  } else {
    candidates.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git');
  }
  return candidates.find((c) => { try { return exists(c); } catch { return false; } }) ?? null;
}

/**
 * A git runner. A git exit code is a result. A timeout throws. A git that cannot be found throws an
 * error with code GIT_NOT_FOUND ("git not found on PATH: ... Fix: ..."). handle() turns any throw into a
 * deny for a gated command (and an allow for any other). The gate fails closed by design (PR D).
 * `gitPath` is resolved once, on the first call. A test passes a path, or null for "no git".
 */
export function makeGit(
  spawn: SpawnFn = spawnSync as unknown as SpawnFn,
  env: NodeJS.ProcessEnv = process.env,
  gitPath?: string | null,
): Deps['git'] {
  // PRE_PR_GATE_GIT_TIMEOUT_MS can only raise the limit: the end-to-end tests set it when the machine is busy.
  const asked = Number(env.PRE_PR_GATE_GIT_TIMEOUT_MS);
  const timeout = Number.isFinite(asked) && asked > GIT_TIMEOUT_MS ? asked : GIT_TIMEOUT_MS;
  let resolved: string | null | undefined = gitPath;
  return (cwd, args) => {
    if (resolved === undefined) resolved = resolveGit(env);
    if (resolved === null) throw gitNotFound('no git program in PATH or in the standard install folders');
    const r = spawn(resolved, args, { cwd, encoding: 'utf8', timeout, windowsHide: true });
    if (r.error) {
      if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') {
        // spawn also fails with ENOENT when the cwd is missing. Name the real cause.
        if (!existsSync(resolved)) throw gitNotFound(r.error.message);
        if (!existsSync(cwd)) throw new Error(`directory not found: ${cwd}`);
      }
      throw r.error;
    }
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
  main().catch((err) => { logGuardError(HOOK, err); console.log('{}'); });
}
