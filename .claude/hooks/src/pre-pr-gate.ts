#!/usr/bin/env node
/**
 * pre-pr-gate -- PreToolUse (matcher: Bash, PowerShell, Desktop Commander start_process and interact_with_process).
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
 * Any cd, Set-Location, sl, chdir, pushd or Push-Location target in the text (before or after the call, quoted or not) that is a CCv3 checkout gates the checkpoint rules too, as the cwd does.
 * The stamp rules judge every folder the open may run in (planRun). Only the cds BEFORE the open count. A cd after it never moves it.
 * With no cd, the folder is the payload cwd. With cds, the folder is the one after the last cd.
 * Up to the last cd that is not joined by `&&`, the folder after each earlier cd and the cwd count too.
 * A cd joined by `;`, `||` or a line end can fail (`cd B extra`, a missing folder). The shell then stays where it was.
 * A cd that follows a `||` or a pipe (`true || cd B && open`, `true | cd B && open`) may be skipped or run in a subshell: it is loose too, and the cwd counts.
 * A popd, Pop-Location, `cd -` or a bare cd before the open makes the folder unknown. It is denied (position-unknown) when it names CCv3 or the cwd or a
 * folder on the known cd path is a CCv3 checkout. Otherwise the known folders are still judged. Use one absolute cd (`cd <full path> && ...`).
 * The open is denied when any one of these folders denies. A folder that does not exist is dropped when the cwd is also a candidate.
 * Join the cd to the open with `&&` to name one folder.
 * A cd is read at a command position (CMD_POS, the same reading as decision-gate): after a separator, an opener (`{`, `(`, a backtick, `!`, then, else, do, if, while, until, elif, time, time -p),
 * a variable prefix (X=1, X+=1), a redirect prefix (`2>/dev/null cd B`), builtin, command or eval (with -p or --). A cd in `( ... )`, `$( ... )` or backticks is read, and it is loose (the cwd counts too),
 * also when a separator comes first inside the group (`(true && cd B) && open`, `x=$(true; cd B)`): a group still open before the cd makes it loose (insideSubshell). So is a cd after a word that is no command
 * position (`echo then cd B`, `echo { cd B`), inside a Start-Job, Start-ThreadJob, pwsh or -Parallel / -AsJob block (also -Pa, -Para, -As), in an Invoke-Command block with a word before the block
 * (`icm -cn srv {`, `Invoke-Command srv {`, `@p {`), or with a parameter or splat after it (-ComputerName, -cn, -Session, -AsJob, `@p`, also behind an `&&` inside the block). A closed `{ }` inside a job block does not end it.
 * A cd target the shell resolves and this hook cannot (a glob `u*`, `[u]a`, a PowerShell `(Join-Path ...)`, a relative target under CDPATH, a backtick substitution) fails closed: cannot expand, in any folder list.
 * A cd with only options (`cd -P`, `cd --`) is a position-unknown cd. A cd inside quotes is not seen.
 * Accepted over-deny: `(cd A) && open` is loose, so the cwd and A are both judged although the subshell cd did not last. Accepted over-deny: `! cd A && open` reads as a sure cd (bash runs the open only when the cd failed), so A is judged.
 * Accepted over-deny: a closing backtick that pairs with a later backtick (`` x=`cd B` && y=`pwd` && open ``) reads as a substitution in the target (cannot expand).
 * Accepted residual: PowerShell `Set-Location 'x' -WhatIf`, `-Pat` and other parameter forms before the folder, `iex`, `bash -c '...'`, a quoted command name (`"cd" A`), a variable command name (`c=cd; $c B`)
 * and the `$ExecutionContext.SessionState.Path.SetLocation(...)` API are not read. A script block held in a variable (`Start-Job $sb`) is not read.
 * Accepted residual: checkpoint-shapes reads `\"` in a PowerShell string as an escape, so a quoted folder ending in a backslash before `--draft` reads as a non-draft create (an over-deny, not a fail-open).
 * Accepted over-deny: a heredoc body line that is only `popd`, `cd -` or `cd` reads as a command (position-unknown). Reading heredocs needs a lexer.
 * Accepted residual: from a foreign checkout, a CCv3 -R hidden by shell syntax (v""3, -dR) is not seen. The hook guards against mistakes, not a hostile agent.
 * Accepted residual: text sent to an existing Desktop Commander shell is judged against the payload cwd, not that shell's cwd. So a PR create
 * with no -R, sent from a non-CCv3 session cwd into a shell already cd'd into a CCv3 checkout, is not gated.
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
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'path';
import { isPrOpenCommand, isPrOpenText, joinContinuations, normalizeGh } from './pr-opened-review-loop.js';
import { CCV3_REPO, isGated, namedRepo, shapesOf, type LabelShape, type Shapes } from './shared/checkpoint-shapes.js';
import { guardLogPath, logGuardDecision, logGuardError, maskSecrets, shouldWrite } from './shared/guard-log.js';
import { maskQuoted } from './shared/mask-quotes.js';
import { readShellCommand } from './shared/shell-tools.js';

export { CCV3_REPO, namedRepo };
export const STAMP_REL = '.claude/cache/pre-pr/stamp.json';
/** The pathway record pr-checkpoint.mjs --confirm writes next to the stamp. */
export const PATHWAY_REL = '.claude/cache/pre-pr/pathway.json';
const CONFIG_REL = 'review-router.config.json';
export const MAX_STAMP_AGE_MS = 24 * 3_600_000;
/** A stamp this far in the future is a clock error, not a fresh stamp. */
const FUTURE_SLACK_MS = 5 * 60_000;
/**
 * One git call may take this long. A decision for one folder makes up to 6 git calls (6 x 2 s = 12 s), inside the template timeout of 15 s.
 * A text with cds can name more folders (ctx.dirs). The stamp check stops at the first folder that denies.
 */
export const GIT_TIMEOUT_MS = 2000;
/**
 * The reasons a stamp may have skipped the CodeRabbit CLI review (pre-pr.mjs: cr_skip_reason). Allowed: "cli-missing" (cr is not installed); "cli-cap" (today's paid CLI spend reached the daily cap; no run was spent); "cap" only with cr_finished_runs >= 1; "rate-limited" only with a known retry time. "flag" (--skip-cr),
 * "no-changes" (the CLI saw an empty scope) and "earlier-step-failed" are not allowed. "docs-only" (every changed file is docs, so the CLI had
 * nothing to review) is allowed only when the stamp has cr_docs_only === true AND docs_verified === true. "rate-limited" is allowed only
 * with a known retry time in the stamp (cr_retry_minutes), which the gate log also shows.
 */
const ALLOWED_SKIP_REASONS = new Set(['cli-missing', 'cli-cap']);
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
/**
 * The tools that run a shell command. Desktop Commander start_process and interact_with_process run one too (the same
 * names and text fields as shared/shell-tools.ts, which commandOf reads). Two gates: settings.json.template must match each name.
 */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', `${DC}start_process`, `${DC}interact_with_process`]);
const HOOK = 'pre-pr-gate';
const RUN = 'node scripts/github/pre-pr.mjs --body <file>';
const BODY_UNVERIFIABLE = 'the PR body is not a file, so it cannot be matched to the body pre-pr.mjs checked. Pass the body as a file: -F body=@<file> (gh api) or --body-file <file> (gh pr create). An inline body, a body from stdin, --fill and --fill-first are denied';

export interface GitResult { status: number; stdout: string }
export interface Deps {
  git: (cwd: string, args: string[]) => GitResult;
  readFile: (path: string) => string | null;
  now: () => number;
  env: NodeJS.ProcessEnv;
  logError?: (message: string, ctx?: ErrorContext) => void;
}
/** What handle() knows about an error beyond its message: the error's `code` and the payload `cwd`. Both can be absent. */
export interface ErrorContext { code?: string; cwd?: string }
/**
 * `warn` on an allow: a PR B rule fired in warn mode. handle() logs it. `soft` on a deny: a PR B rule (not a stamp rule),
 * which warn mode turns into an allow.
 */
export type Decision =
  | { action: 'allow'; warn?: string }
  | { action: 'override' }
  | { action: 'deny'; reason: string; pattern: string; soft?: boolean };

interface HookInput { tool_name?: string; tool?: string; tool_input?: Record<string, unknown>; cwd?: string; session_id?: string; agent_id?: string }

/** The command text of a shell tool call (Bash and PowerShell: `command`; Desktop Commander: `command` or `input`). Empty for any other tool or an unreadable field: there is no command to judge. */
const commandOf = (input: HookInput): string => {
  const c = readShellCommand(input);
  return c.kind === 'command' ? c.text : '';
};
const isDesktopCommander = (input: HookInput): boolean => (input.tool_name || input.tool || '').startsWith(DC);

// ---------- raw-text readers (narrow on purpose) ----------

/** The head branch a PR-create command names (`--head`, `-H`, `-f head=`), without an `owner:` prefix. */
export function headBranchOf(command: string): string | null {
  // -H is a header for gh api and the head only for gh pr create.
  // A shell separator ends the word: `--head feat/x; cd B` names feat/x, not `feat/x;`.
  const m = /(?:^|\s)(?:-[fF]|--(?:raw-)?field)\s*["']?head=["']?([^\s"';&|]+)/.exec(command)
    ?? (/\bgh\s+pr\s+create\b/i.test(command) ? /(?:^|\s)(?:--head(?:\s+|=)|-H\s*)["']?([^\s"';&|]+)/.exec(command) : null);
  return m ? m[1].replace(/^[^:\s]+:/, '').replace(/["']+$/, '') : null;
}

/** True for a git remote URL that points at the CCv3 fork. Exact: no suffix, no other owner. */
export function isCcv3Remote(url: string): boolean {
  const m = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m !== null && m[1].toLowerCase() === CCV3_REPO;
}

// The gap after the command is spaces or tabs only: `cd` + newline is a bare cd (UNKNOWN_CD), and the next line is not its target.
// A command position, read in the quote-masked text. The same reading as decision-gate (PR #417: OPENER, CMD_POS), kept as this gate's own copy.
//   hard = a SURE position: the start, a separator (; & | or a line end), the end of a PowerShell block comment (#>), or the scriptblock of
//          Invoke-Command / icm (it runs in the current session), then any run of openers: `{`, `(`, a backtick, `!`, then, else, do, if, while, until, elif, time.
//   soft = `(`, `)` (a case pattern), a backtick, `{`, then, else or do with NO separator before it. `echo then cd B` and `Start-Job { cd B }` are not commands
//          that move the shell, so the cd is read but LOOSE (the cwd is judged too, see cdSteps).
// After the opener: variable prefixes (X=1), a PowerShell `$x =`, builtin, command or eval words, a module name (Microsoft.PowerShell.Management\) and one backslash (\cd).
const OPENER = String.raw`(?:\{\s*|[(\`!]\s*|(?:then|else|do|if|while|until|elif)\s+|time\s+(?:(?:-p|--)\s+)*)`;
const CMD_POS = String.raw`(?:(?<hard>(?:^|[;&|\r\n]\s*|#>\s*|\b(?:Invoke-Command|icm)\s+(?:-ScriptBlock\s+)?(?=\{))${OPENER}*)|(?<soft>(?:[)(\`]\s*|\{\s*|\b(?:then|else|do)\s+)${OPENER}*))`
  + String.raw`(?:(?:[A-Za-z_]\w*\+?=[^\s;&|]*|(?:\d*[<>]{1,2}&?|&>>?)[^\s;&|]+)[ \t]+)*(?:\$\w+[ \t]*=[ \t]*)?(?:(?:builtin|command|eval)\s+(?:(?:-p|--)\s+)*)*(?:[\w.]+\\)?\\?`;
const CD_NAMES = 'cd|Set-Location|sl|chdir|pushd|Push-Location';
// A bash option (cd -P A, cd -- A) or a PowerShell parameter (-Path A, -Path:A) may come before the target. The target is one word of plain characters, quoted
// parts and escapes (`P/"x"`, `P/x\ y`); it ends before a closing `)` or backtick of a subshell. A quoted part comes first, so a PowerShell folder may end in `\`.
const CD_TARGET = new RegExp(CMD_POS + String.raw`(?:${CD_NAMES})[ \t]+(?:(?:-[PLe@]+|--)[ \t]+)*(?:-(?:LiteralPath|Path|PSPath)(?:[ \t]+|:))?(?<t>(?:"[^"]*"|'[^']*'|\`[^\`]*\`|\\[^;&|\r\n]|[^\s;&|)\`"'\\])+)`, 'gi');
/**
 * popd, Pop-Location and a bare cd (with no target) go to a folder the text does not name. A cd with only options (cd -P, cd --, cd -P -) does too.
 * Found in the masked view, at a command position. `cd -` with nothing else is also read by cdSteps (NO_FOLDER), so the two readers cannot disagree.
 * It reads separators and command names only. decision-gate keeps its own copy of this reading (UNKNOWN_CD_SOURCE); the two read alike.
 */
const UNKNOWN_CD = new RegExp(CMD_POS + String.raw`(?:(?:popd|Pop-Location)(?=\s|[;&|\r\n]|$)|(?:${CD_NAMES})(?:[ \t]+(?:-[PLe@]+|--|[-+]))*[ \t]*(?=[;&|\r\n]|$))`, 'gi');
/** A cd target that is no folder: `cd -`, or an option with nothing after it (`cd -P`, `cd --`). The shell goes to a place the text does not name. */
const NO_FOLDER = /^(?:[-+]|-[PLe@]+|--)$/i;
// A job, a parallel block or a remote block runs its cd in another runspace, process or machine: the parent shell does not move. True when the text before a cd has an
// open `{` that follows such a word: Start-Job, Start-ThreadJob, pwsh, -Parallel and -AsJob (also their abbreviations -Pa, -Para ... and -As, -AsJ, -AsJo), or an
// Invoke-Command / icm with anything between the word and the block but -ScriptBlock (`icm -cn srv {`, `Invoke-Command srv {`, `Invoke-Command @p {`: the target comes before the block).
// Run it on the text with its closed `{ ... }` groups removed (withoutClosed), so `if (1) {}` or `@{}` inside the block, or a hashtable before it, does not end the block.
const JOB_BLOCK = /(?:\bStart-(?:Job|ThreadJob)\b|\bsajb\b|\b(?:pwsh|powershell)(?:\.exe)?\b|-(?:Pa(?:r(?:a(?:l(?:l(?:e(?:l)?)?)?)?)?)?|As(?:J(?:o(?:b)?)?)?)\b|\b(?:Invoke-Command|icm)\b(?!\s+(?:-ScriptBlock\s+)?\{))[^{};&|\r\n]*\{[^}]*$/i;
// Invoke-Command names its target AFTER the block too: `{ cd B } -ComputerName srv` (or -cn, -Comp, -CU, -VMGuid) or a splat `@p` runs the cd elsewhere. Aliases and prefixes cannot be
// listed safely, so ANY parameter or splat after a closing brace in the same statement counts. The cd may be followed by `&&` or a pipe before that brace (`{ cd B && $null } -cn srv`).
// A local-only parameter, or a later unrelated block, over-denies (fail closed).
const REMOTE_AFTER_BLOCK = /^[^;\r\n]*?\}[^;&|\r\n{]*?\s(?:-[A-Za-z]|@\w)/;

/** The text with every closed group the pattern finds removed, innermost first (`a { b { c } d } e` becomes `a  e`). A group left over is an open one. Regex only, no scan of characters. */
function withoutClosed(text: string, group: RegExp): string {
  let t = text;
  for (;;) {
    const next = t.replace(group, '');
    if (next === t) return t;
    t = next;
  }
}
const CLOSED_BRACES = /\{[^{}]*\}/g;
const CLOSED_PARENS = /\([^()]*\)|`[^`]*`/g;
/** True when the text before a cd leaves a `(`, `$(`, `<(` or backtick open: the cd is inside a subshell or a substitution, so it may not last (`(true && cd B) && open`). */
const insideSubshell = (before: string): boolean => /[(`]/.test(withoutClosed(before, CLOSED_PARENS));
/** Git Bash writes C:\x as /c/x. Node on Windows reads /c/x as \c\x, so turn the one-letter drive prefix back into C:. Other platforms keep the path. */
export const fromGitBashPath = (p: string, platform: string = process.platform): string =>
  platform === 'win32' ? p.replace(/^\/([A-Za-z])(?:\/|$)/, '$1:/') : p;

/**
 * A cd target (raw, quote marks still on) as the folder text the shell reads. Every quote mark goes (P/"x" is P/x); in bash a backslash before a space or a quote
 * is an escape, so the mark itself stays. PowerShell has no backslash escape: a quoted part is taken whole (a folder may end in `\`), and a quote inside the
 * other kind of quote is a letter of the name. Only Git Bash writes /c/x for C:\x. PowerShell reads /c/x from the current drive root, so it keeps the text as written.
 */
const unquote = (target: string, shell: 'bash' | 'pwsh'): string => {
  if (shell === 'pwsh') return target.replace(/"([^"]*)"|'([^']*)'/g, (_m, d: string | undefined, s: string | undefined) => d ?? s ?? '').trimEnd();
  return fromGitBashPath(target.replace(/\\([ "'])|["']/g, (_m, esc: string | undefined) => esc ?? ''));
};

const resolveIn = (cwd: string, target: string, shell: 'bash' | 'pwsh'): string => {
  const t = unquote(target, shell);
  return isAbsolute(t) || /^[A-Za-z]:/.test(t) ? t : resolve(cwd, t);
};

/**
 * True when a cd target holds text that the shell expands and this hook does not: `$var`, `$(..)`, `${..}`, `%VAR%`, a backtick,
 * a leading `~`, a glob (`*`, `?`, `[`) or a leading `(` or `@` (a PowerShell expression). Resolved as a path it names a folder that does not exist (`...\worktrees\x\$w`).
 */
export function hasUnexpandedPart(target: string): boolean {
  const t = target.replace(/^["']|["']$/g, '');
  // A glob (`u*`, `[u]a`, `u?`) and a PowerShell expression (`(Join-Path ...`, `@(...)`) name a folder the shell finds and this hook cannot: read as a path they are a folder that does not exist.
  return /[$`*?[]/.test(t) || /%[^%\s]+%/.test(t) || t.startsWith('~') || /^[(@]/.test(t);
}

/** `code` of the error a git call on an unexpandable cd target throws. handle() reads it. */
export const CD_UNEXPANDED = 'CD_UNEXPANDED';

/** `code` of the error makeGit throws when the folder of a git call does not exist. A cd to such a folder fails in the shell, which stays where it was. */
export const DIR_NOT_FOUND = 'DIR_NOT_FOUND';

// ---------- the folders a PR open may run in ----------

/** One cd, Set-Location, sl, pushd or Push-Location before the open: its raw target, and whether `&&` joins it to what follows. */
interface CdStep {
  target: string;
  andOnly: boolean;
  /** `cd -` or `cd +`: a folder the text does not name. It is no step of the known path. */
  unknown?: boolean;
}

/** What the text says about where the gated command runs. */
interface RunPlan {
  /** Every folder the gated command may run in. The folder after all cds comes last. */
  dirs: string[];
  /** The folder after every cd succeeded. */
  final: string;
  /** The cwd, then the folder after each known cd, in order. A && chain collapses dirs to the last one; the position rule judges all of these. */
  states: string[];
  /** Folders (with the cd target text) that hold an unexpanded variable, or follow a cd that does. */
  unexpanded: Map<string, string>;
  /** A popd, Pop-Location, `cd -` or a bare cd comes before the gated command: the folder is not named by the text (see positionDeny). */
  unknown: boolean;
}

/**
 * Where the last gated command segment starts (a PR open, a ready, a label add), or null when no segment shows one (the open is split
 * by a newline, or quoted). Segments are cut at ; & | and line ends in the text with its quoted strings blanked, so a quoted `;` does not cut.
 */
function gatedStart(masked: string, raw: string): number | null {
  let found: number | null = null;
  let from = 0;
  const cut = (to: number): void => {
    const seg = raw.slice(from, to);
    if (seg.trim() !== '' && (isPrOpenText(seg) || isGated(shapesOf(seg)))) found = from;
  };
  for (const m of masked.matchAll(/[;&|\r\n]+/g)) { cut(m.index!); from = m.index! + m[0].length; }
  cut(masked.length);
  return found;
}

/** The cds that come before `end`, in order. A cd is found in the masked view, so a quoted `; cd x` is not one; the target is read from the raw text. */
function cdSteps(masked: string, raw: string, end: number, shell: 'bash' | 'pwsh'): CdStep[] {
  const pre = masked.slice(0, end);
  return [...pre.matchAll(new RegExp(CD_TARGET.source, 'gi'))].flatMap((m) => {
    const at = m.index! + m[0].length;
    const target = raw.slice(at - m.groups!.t.length, at);
    // `cd -` and `cd -P` go to a folder the text does not name, not to a folder called "-": flag it. planRun makes the position unknown.
    if (NO_FOLDER.test(target)) return [{ target, andOnly: false, unknown: true }];
    // Every separator between this cd and the open must be `&&`: a later `;`, `||` or line end lets the open run when this cd failed.
    // The & of a file-descriptor redirect (2>&1, &>file) is no separator: blank it first.
    const joiners = pre.slice(at).replace(FD_REDIRECT, ' ').match(/&&|\|\||[;&|\r\n]/g) ?? [];
    // The cd may be skipped, may not last, or may run elsewhere: then it is loose and the cwd is judged too. That holds for a | before it (||, a pipe, |&, with or
    // without a comment line between), a `(` or a backtick (a subshell), a soft position (`echo then cd B`), a cd inside a job block, and an Invoke-Command block with a parameter after it.
    const before = pre.slice(0, m.index!);
    const loose = m.groups!.soft !== undefined || /^\||[(`]/.test(m.groups!.hard ?? '') || endsInPipe(before) || insideSubshell(before)
      || JOB_BLOCK.test(withoutClosed(before, CLOSED_BRACES)) || REMOTE_AFTER_BLOCK.test(masked.slice(at));
    // In PowerShell a backtick right after the word is an escape inside it: the word goes on, the folder is not known. Keep the mark in the target so it is flagged.
    const word = shell === 'pwsh' && raw[at] === '`' ? raw.slice(at - m.groups!.t.length, at + 1) : target;
    return [{ target: word, andOnly: !loose && joiners.length > 0 && joiners.every((j) => j === '&&') }];
  });
}

/** 2>&1, >&2, <&3, 2>&-, &>file and &>>file: the & belongs to a redirect. */
const FD_REDIRECT = /\d*[<>]&\d*-?|&>>?/g;

/** True when the text ends in a pipe (|, || or |&), looking past blanks and comment lines. Text that only looks like a comment makes the cd loose: fail closed. */
function endsInPipe(before: string): boolean {
  let t = before.trimEnd();
  for (;;) {
    const c = t.replace(/(?:^|\s)#[^\r\n]*$/, '').trimEnd();
    if (c === t) break;
    t = c;
  }
  return t.endsWith('|') || t.endsWith('|&');
}

/**
 * Every folder a gated command may run in. Only the cds that come BEFORE the command count: a cd after it never moves it.
 * With no cd it is the payload cwd. With cds it is the folder after the last cd (all of them worked), plus, up to the last cd that is
 * not joined by `&&`, the folder after each earlier cd and the cwd: a cd joined by `;`, `||`, `|`, `&` or a line end may fail
 * (`cd B extra`, a missing folder) and the shell then stays where it was. A cd joined only by `&&` cannot fail into the open.
 * A text with no gated segment is judged in the cwd and the folder after every cd.
 */
function planRun(command: string, cwd: string, shell: 'bash' | 'pwsh', env: NodeJS.ProcessEnv = {}): RunPlan {
  // CDPATH makes bash look up a relative cd target (not ./x, ../x or an absolute one) in other folders: the folder is not the one the text names.
  const cdpath = shell === 'bash' && (/\bCDPATH\b/.test(command) || (env.CDPATH ?? '') !== '');
  const masked = maskQuoted(command, shell === 'pwsh' ? 'PowerShell' : 'Bash');
  const start = gatedStart(masked, command);
  const all = cdSteps(masked, command, start ?? command.length, shell);
  const steps = all.filter((s) => s.unknown !== true);
  const states = [cwd];
  const unexpanded = new Map<string, string>();
  let broken = false;
  for (const s of steps) {
    const t = unquote(s.target, shell);
    const absolute = isAbsolute(t) || /^[A-Za-z]:/.test(t);
    const viaCdpath = cdpath && !absolute && !/^\.{1,2}(?:[\\/]|$)/.test(t);
    broken = hasUnexpandedPart(s.target) || viaCdpath || (broken && !absolute);
    const dir = resolveIn(states[states.length - 1], s.target, shell);
    states.push(dir);
    if (broken) unexpanded.set(dir, t.slice(0, 120));
  }
  const lastLoose = start === null ? steps.length : steps.map((s) => s.andOnly).lastIndexOf(false) + 1;
  const final = states[states.length - 1];
  const unknown = all.some((s) => s.unknown === true) || masked.slice(0, start ?? command.length).match(UNKNOWN_CD) !== null;
  return { dirs: [...new Set([...(lastLoose > 0 ? states.slice(0, lastLoose + 1) : []), final])], final, states, unexpanded, unknown };
}

/**
 * Deps whose git refuses a folder that a `cd` target with an unexpanded variable names (any cd before the open, not only the first), or that
 * a relative cd after such a target reaches. The gate cannot know that folder, so it fails closed exactly as a missing directory did
 * (handle() denies a gated command), with a reason that names the cause. A fallback to the hook cwd would judge another checkout's stamp
 * and could turn that deny into an allow.
 */
function guardUnexpandedCd(deps: Deps, plan: RunPlan): Deps {
  if (plan.unexpanded.size === 0) return deps;
  return {
    ...deps,
    git: (d, args) => {
      const target = plan.unexpanded.get(d);
      if (target === undefined) return deps.git(d, args);
      throw Object.assign(new Error(`cannot expand the cd target ${target}`), { code: CD_UNEXPANDED, target });
    },
  };
}

/**
 * Every directory a cd, Set-Location, sl, pushd or Push-Location in the text names, plus the cwd. Read from the raw text and from the text with
 * its quotes deleted. No lexing: a target inside quoted text counts too, which can only gate more (fail closed).
 */
function candidateDirs(command: string, cwd: string, shell: 'bash' | 'pwsh'): string[] {
  const texts = [command, command.replace(/["']/g, '')];
  const targets = texts.flatMap((t) => [...t.matchAll(CD_TARGET)].map((m) => resolveIn(cwd, m.groups!.t, shell)));
  return [...new Set([cwd, ...targets])];
}

/**
 * The file `-F body=@<file>` or `--body-file <file>` names, or null (no body file, inline body, or stdin).
 * A quoted path keeps its spaces: the whole quoted text is the file name. A stdin marker `-` is null, quoted or not.
 */
const FIELD_BODY = /(?:^|\s)(?:-F|--field)(?:=|\s*)(?:"body=@([^"]+)"|'body=@([^']+)'|body=@(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+)))/;
const BODY_FILE = /(?:^|\s)--body-file(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/;
/** `-F <file>` is the short form of --body-file for `gh pr create` only. For `gh api`, -F is a field flag. */
const SHORT_BODY_FILE = /(?:^|\s)-F\s+(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/;
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
  try { return isCcv3Checkout(deps, dir); } catch (err) {
    // A folder the hook cannot expand is not "not a checkout": the gate does not know which folder it is.
    if ((err as { code?: string } | null)?.code === CD_UNEXPANDED) throw err;
    return false;
  }
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
  const o = s as { head?: unknown; at?: unknown; cr_skipped?: unknown; cr_skip_reason?: unknown; cr_retry_minutes?: unknown; cr_finished_runs?: unknown; cr_docs_only?: unknown; docs_verified?: unknown; body_sha256?: unknown } | null;
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
  const docsOnlyEarned = reason === 'docs-only' && o.cr_docs_only === true && o.docs_verified === true;
  if (o.cr_skipped === true && reason === 'docs-only' && !docsOnlyEarned) {
    return `the stamp skipped the CodeRabbit CLI review as docs-only, but it lacks cr_docs_only: true or docs_verified: true (cr_docs_only: ${String(o.cr_docs_only ?? 'none')}, docs_verified: ${String(o.docs_verified ?? 'none')}). A docs-only skip is allowed only when pre-pr.mjs confirmed every changed file is docs. Run pre-pr.mjs again`;
  }
  if (o.cr_skipped === true && !ALLOWED_SKIP_REASONS.has(reason) && !waitKnown && !capEarned && !docsOnlyEarned) {
    return `the stamp skipped the CodeRabbit CLI review (reason: ${o.cr_skip_reason || 'none'}). Only a finished-run cap, a missing CLI (cli-missing), the daily CLI spend cap (cli-cap), a docs-only branch (docs-only, with cr_docs_only and docs_verified true), or a rate limit with a known retry time allows a skip. A broken CLI (cli-error) costs nothing to retry. Run pre-pr.mjs again without --skip-cr`;
  }
  if (body) {
    if (body.sha === null) return `the body file ${body.path} cannot be read, so it cannot be matched to the body pre-pr.mjs checked. Use an absolute path or a path relative to the working directory. The hook does not expand ~ or $env: paths. A Git Bash /c/ path is turned into C:/ on Windows`;
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
  /** Every folder the command may run in (planRun): only the cds before it count. A rule denies when it denies in any one of them. */
  dirs: string[];
  /** The folder after every cd worked. It is the one folder whose git errors fail closed; the others only add denies. */
  final: string;
  /** The payload cwd. */
  cwd: string;
  /** The cwd, then the folder after each known cd (RunPlan.states). */
  states: string[];
  /** A popd, Pop-Location, `cd -` or a bare cd comes before the gated command (RunPlan.unknown). */
  unknown: boolean;
  /** The shell of the tool call: Git Bash paths (/c/x) are converted for bash only. */
  shell: 'bash' | 'pwsh';
  /** CCV3_REPO when the command holds a CCv3 signal, else null (the checkout decides). A non-literal value beside a CCv3 signal does not hide it. */
  named: string | null;
  top: (dir: string) => string | null;
  /** True when the folder is a CCv3 checkout. A git error in `final` throws (fail closed); in another folder it counts as "no". */
  isCcv3At: (dir: string) => boolean;
  ccv3: () => boolean;
  enforcing: () => boolean;
}

const once = <T>(f: () => T): (() => T) => {
  let box: { v: T } | undefined;
  return () => (box ??= { v: f() }).v;
};

function makeCtx(input: HookInput, command: string, deps: Deps, shapes: Shapes, plan: RunPlan): Ctx {
  const cwd = input.cwd || process.cwd();
  const shell = shellOf(input);
  const named = namedRepo(command, deps.env);
  const tops = new Map<string, string | null>();
  const top = (d: string): string | null => {
    if (!tops.has(d)) {
      const r = deps.git(d, ['rev-parse', '--show-toplevel']);
      tops.set(d, r.status === 0 ? r.stdout.trim() : null);
    }
    return tops.get(d) ?? null;
  };
  // A cd to a folder that does not exist fails and the shell stays where it was. So when the cwd is also a candidate, such a folder is no candidate.
  // With no cwd in the list (`cd nope && open`) it is kept, and its git error denies as before. Any other git error is thrown.
  const missing = (d: string): boolean => {
    try { top(d); return false; } catch (err) { if ((err as { code?: string } | null)?.code === DIR_NOT_FOUND) return true; throw err; }
  };
  const live = plan.dirs.includes(cwd) ? plan.dirs.filter((d) => d === cwd || !missing(d)) : plan.dirs;
  const dirs = live.length > 0 ? live : plan.dirs;
  const final = dirs.includes(plan.final) ? plan.final : cwd;
  const ccv3At = new Map<string, boolean>();
  const isCcv3At = (d: string): boolean => {
    if (!ccv3At.has(d)) ccv3At.set(d, d === final ? isCcv3Checkout(deps, d) : isCcv3Dir(deps, d));
    return ccv3At.get(d) ?? false;
  };
  const inCcv3 = once(() => named === CCV3_REPO || isCcv3At(final) || candidateDirs(command, cwd, shell).some((d) => d !== final && isCcv3Dir(deps, d)));
  return {
    dirs, final, cwd, states: plan.states, unknown: plan.unknown, shell, named, top, isCcv3At,
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

/**
 * Pure given its deps. Allow, override (a deny that the override let through; it is logged) or deny.
 * A Desktop Commander shell is chosen at run time, so its text is judged as Bash, then as PowerShell: the first non-allow wins.
 */
export function decide(input: HookInput, deps: Deps): Decision {
  if (!isDesktopCommander(input)) return decideAs(input, deps);
  const text = commandOf(input);
  const both = [decideAs({ ...input, tool_name: 'Bash' }, deps, text), decideAs({ ...input, tool_name: 'PowerShell' }, deps, text)];
  return both.find((d) => d.action === 'deny') ?? both.find((d) => d.action === 'override') ?? both.find((d) => d.action === 'allow' && d.warn) ?? both[0];
}

function decideAs(input: HookInput, deps: Deps, text?: string): Decision {
  const raw = text ?? commandOf(input);
  const command = normalizeGh(joinContinuations(raw, shellOf(input)));
  const shapes = shapesOf(command);
  if (!isGated(shapes)) return { action: 'allow' };
  const plan = planRun(command, input.cwd || process.cwd(), shellOf(input), deps.env);
  deps = guardUnexpandedCd(deps, plan);
  const ctx = makeCtx(input, command, deps, shapes, plan);
  const d = judge(command, deps, ctx, shapes);
  if (d.action !== 'deny') return d;
  if (hasOverride(command, deps.env)) return { action: 'override' };
  return d.soft && !ctx.enforcing() ? { action: 'allow', warn: d.pattern } : d;
}

function judge(command: string, deps: Deps, ctx: Ctx, shapes: Shapes): Decision {
  const where = positionDeny(ctx, shapes);
  // An open: the position deny is a stamp-rule deny (hard) and comes first, as its text tells the fix. It is null unless CCv3 may be the folder,
  // so every other deny still runs for a position that cannot be CCv3. Any other shape: its own soft rules first, then the position.
  if (shapes.create) return where ?? stampDeny(command, deps, ctx) ?? checkpointDeny(deps, ctx, shapes) ?? { action: 'allow' };
  return checkpointDeny(deps, ctx, shapes) ?? where ?? { action: 'allow' };
}

const POSITION_WHY = 'popd, Pop-Location, cd - or a bare cd moves the folder to a place this text does not name, so the checkout this command runs in cannot be known. Run the command with one absolute cd (cd <full path> && ...) and no popd.';

/**
 * A popd, Pop-Location, `cd -` or a bare cd comes before the gated command, so the folder is unknown. Denied when the command may run in a CCv3
 * checkout without a stamp: it names CCv3, or the cwd or a folder on the known cd path is a CCv3 checkout. Otherwise null, and the caller still judges
 * the known folders (a --repo, a self-confirm, a stamp in a known CCv3 folder). Same wording as decision-gate POSITION_WHY.
 */
function positionDeny(ctx: Ctx, shapes: Shapes): Decision | null {
  if (!ctx.unknown) return null;
  if (ctx.named !== CCV3_REPO && ![...new Set([ctx.cwd, ...ctx.states, ...ctx.dirs])].some((d) => ctx.isCcv3At(d))) return null;
  return shapes.create ? { action: 'deny', pattern: 'position-unknown', reason: `BLOCKED (pre-pr-gate): ${POSITION_WHY}` } : soft('position-unknown', POSITION_WHY);
}

/** The stamp rules of #193 and #197, judged in every folder the open may run in. Enforced in both modes. The first folder that denies wins. */
function stampDeny(command: string, deps: Deps, ctx: Ctx): Decision | null {
  for (const dir of ctx.dirs) {
    const d = stampDenyIn(command, deps, ctx, dir);
    if (d) return d;
  }
  return null;
}

/** The stamp rules for one folder. A folder that is not a CCv3 checkout (and no CCv3 signal names the repo) is no concern of the stamp. */
function stampDenyIn(command: string, deps: Deps, ctx: Ctx, dir: string): Decision | null {
  const { named, shell } = ctx;
  // When the open can run in more than one folder, say so: the fix is to join the cd to the open with &&.
  const rule = (pattern: string, why: string): Decision => deny(pattern, ctx.dirs.length > 1
    ? `${why}. The command can run in more than one folder. A cd joined by ; or || or a line end can fail. The shell then stays in its folder. This check is for ${dir}. Join the cd to the PR command with && to name one folder`
    : why);
  if (named !== CCV3_REPO && !ctx.isCcv3At(dir)) return null;
  const top = ctx.top(dir);
  if (top === null) return rule('no-checkout', `this command opens a PR in ${CCV3_REPO}, but ${dir} is not a git checkout, so no pre-PR stamp can be found`);
  // An explicit target skipped the checkout test above: the stamp of a foreign checkout must not open a CCv3 PR.
  if (named !== null && !ctx.isCcv3At(dir)) return rule('repo-identity', `this command names ${CCV3_REPO}, but ${dir} is not a CCv3 checkout, so its stamp does not count`);
  const bodyPath = singleBodyFile(command);
  if (bodyPath === null) return rule('body', BODY_UNVERIFIABLE);
  const branch = headBranchOf(command);
  const headRun = deps.git(top, ['rev-parse', branch ? `${branch}^{commit}` : 'HEAD']);
  if (headRun.status !== 0) return rule('head-unresolved', `cannot resolve the head ${branch ?? 'HEAD'} in ${top}`);
  const head = headRun.stdout.trim();
  const body = { path: bodyPath, sha: sha256Of(deps.readFile(resolve(dir, shell === 'bash' ? fromGitBashPath(bodyPath) : bodyPath))) };
  const problems = stampRoots(deps, dir, top, branch).map((r) => stampProblem(deps.readFile(join(r, STAMP_REL)), head, deps.now(), body));
  if (!problems.some((p) => p === null)) return rule('stamp', problems[0] ?? 'no stamp');
  const pushed = pushedProblem(deps, top, branch, head);
  return pushed ? rule('pushed-head', pushed) : null;
}

// ---------- the checkpoint rules (PR B) ----------

function soft(pattern: string, why: string): Decision {
  return { action: 'deny', pattern, soft: true, reason: `BLOCKED (pre-pr-gate): ${why}` };
}

const SELF_WHY = 'pr-checkpoint --confirm and --apply record and spend a review pathway. Only Dave\'s press in the /pathway mod does that. Do not run them from a shell. The read-only form (node scripts/github/pr-checkpoint.mjs --json) is allowed.';
const LITERAL_WHY = 'pass a literal OWNER/REPO to --repo or -R. A value with $, a backtick or %VAR% hides the target repo from this gate.';
const DRAFT_WHY = `open as draft; call pr_checkpoint {pr}. Open the PR with gh pr create --draft (gh api: -F draft=true). Then call pr_checkpoint {pr}: it asks Dave to pick the review pathway, and the PR is marked ready after his tap.`;
const READY_WHY = 'gh pr ready is not run from a shell. Call pr_checkpoint {pr}: it asks Dave to pick a pathway, and after his tap the mod adds the review label and marks the PR ready. To return a PR to draft, use gh pr ready --undo.';
const LABEL_WHY = 'a review: label is set only by the pathway Dave taps for this head. Do not add one by hand, and do not use a command whose label text is hidden. Call pr_checkpoint {pr}.';

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

/** A review: label add is allowed only for the one label pathway.json (for HEAD) names, in every folder the command may run in. A blind add is never allowed. */
function labelAllowed(label: LabelShape, deps: Deps, ctx: Ctx): boolean {
  if (label.blind || label.labels.length !== 1) return false;
  return ctx.dirs.every((dir) => pathwayLabel(deps, ctx, dir) === label.labels[0]);
}

/** The lower-case label of pathway.json when it names HEAD (`git rev-parse HEAD` at the toplevel of the folder), else null. */
function pathwayLabel(deps: Deps, ctx: Ctx, dir: string): string | null {
  const top = ctx.top(dir);
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

/** The `code` of an error (a string only) and the payload `cwd` (a string only). `input` can be any parsed JSON, so read it defensively. */
function errorContext(err: unknown, input: HookInput | null): ErrorContext {
  const code = (err as { code?: unknown } | null)?.code;
  const cwd = (input as { cwd?: unknown } | null)?.cwd;
  return { ...(typeof code === 'string' && code ? { code } : {}), ...(typeof cwd === 'string' && cwd ? { cwd } : {}) };
}

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
      try { deps.logError?.(String((parseErr as Error)?.message ?? parseErr), errorContext(parseErr, null)); } catch { /* the log never blocks */ }
      if (!isPrOpenCommand(raw)) return '{}';
      logGuardDecision(HOOK, {}, 'deny', 'unreadable-input', { command: raw.slice(0, 500) });
      const why = `BLOCKED (pre-pr-gate): could not read the hook input, and its text looks like a PR create, so the pre-PR stamp could not be checked. Run the command again. If it keeps failing, ask Dave.\n\nThe stamp comes from: ${RUN}`;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
    }
    const tool = input.tool_name || input.tool || '';
    if (!COMMAND_TOOLS.has(tool)) return '{}';
    command = commandOf(input);
    // Known before anything can throw: an error on a gated shape must not let the command through unchecked.
    create = isPrOpenCommand(command);
    gated = create || ['bash', 'pwsh'].some((s) => isGated(shapesOf(joinContinuations(command, isDesktopCommander(input) ? (s as 'bash' | 'pwsh') : shellOf(input)))));
    const d = decide(input, deps);
    if (d.action === 'override') logGuardDecision(HOOK, input, 'override', 'SKIP_PRE_PR_GATE', { command });
    if (d.action === 'allow' && d.warn) logGuardDecision(HOOK, input, 'warn', d.warn, { command });
    if (d.action !== 'deny') return '{}';
    logGuardDecision(HOOK, input, 'deny', d.pattern, { command });
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } });
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    const cdUnexpanded = (err as { code?: string } | null)?.code === CD_UNEXPANDED;
    // An unexpandable cd target is a known, user-fixable denial, not a fault: it gets no error row.
    if (!cdUnexpanded) { try { deps.logError?.(message, errorContext(err, input)); } catch { /* the log never blocks */ } }
    // Unparsable input, another tool, or a command that is not a gated shape: nothing to guard, so allow.
    if (!gated) return '{}';
    // A gated command that could not be checked (git timeout, git error, unreadable stamp): the leading override allows it, else deny.
    // This holds in both modes: warn mode excuses a rule hit, not a gate that could not decide.
    if (hasOverride(joinContinuations(command, shellOf(input)), deps.env)) {
      logGuardDecision(HOOK, input, 'override', 'SKIP_PRE_PR_GATE', { command });
      return '{}';
    }
    if (cdUnexpanded) {
      logGuardDecision(HOOK, input, 'deny', 'cd-unexpanded', { command });
      const why = `BLOCKED (pre-pr-gate): the hook cannot expand the cd target in this command (${String((err as { target?: unknown }).target ?? '').slice(0, 120)}). It does not expand $var, %VAR%, $(...), a backtick, ~, a glob (* ? [), a PowerShell expression or a relative target under CDPATH, so it cannot tell which checkout the command runs in.\n\nUse a literal path in the cd (for example C:/Users/x/repo), or run the cd in a separate call, then run the command again.\n\nThe stamp comes from: ${RUN}`;
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
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
/**
 * A git candidate counts only when it is a regular file that can run (execute bit on POSIX).
 * A directory or a non-executable file named git is skipped, so the lookup goes on to the next
 * PATH entry, as a bare spawn('git') would.
 */
export function runnableFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveGit(
  env: NodeJS.ProcessEnv = process.env,
  exists?: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): string | null {
  exists ??= (path: string) => runnableFile(path, platform);
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
        if (!existsSync(cwd)) throw Object.assign(new Error(`directory not found: ${cwd}`), { code: DIR_NOT_FOUND });
      }
      throw r.error;
    }
    return { status: r.status ?? 1, stdout: r.stdout ?? '' };
  };
}

/**
 * The error logger. It writes pre-pr-gate-errors.jsonl in the folder of the guard decision log, so
 * CCV3_GUARD_DECISIONS_LOG redirects it too. A row: ts, hook, error, code (only when the error has
 * one), cwd (the payload cwd, null when absent) and cwd_exists. cwd_exists is true when the directory
 * the gate ran in exists (the payload cwd, else the hook's own cwd). A false value explains an ENOENT
 * that is a missing cwd and not a missing git.
 */
export function makeErrorLogger(env: NodeJS.ProcessEnv = process.env): NonNullable<Deps['logError']> {
  return (message, ctx = {}) => {
    if (!shouldWrite(env)) return;
    const file = join(dirname(guardLogPath(env)), 'pre-pr-gate-errors.jsonl');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const cwd = ctx.cwd ?? null;
    let cwdExists = false;
    try { cwdExists = existsSync(cwd ?? process.cwd()); } catch { /* an unreadable path counts as missing */ }
    const row = { ts: new Date().toISOString(), hook: HOOK, error: maskSecrets(message).slice(0, 300), ...(ctx.code ? { code: ctx.code.slice(0, 40) } : {}), cwd: cwd === null ? null : cwd.slice(0, 300), cwd_exists: cwdExists };
    appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  };
}

function realDeps(): Deps {
  return {
    git: makeGit(),
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    now: () => Date.now(),
    env: process.env,
    logError: makeErrorLogger(process.env),
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
