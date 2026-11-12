#!/usr/bin/env node
/**
 * decision-gate -- PreToolUse. Pathway flow v2, design N3.
 *
 * Denies, in a CCv3 checkout, a command that needs Dave's tap (an AskUserQuestion answer, written by decision-ledger as a
 * DECISION in the store, scripts/github/lib/decisions.mjs) when that tap is not on record. The deny text names the question to ask.
 *   open-pr   a PR create (gh api .../pulls POST, gh pr create): needs "Open draft PR" for (branch, head of the branch).
 *   land      land-pr.ps1, gh pr merge, gh api .../merge: need "Land now" or "Land when READY" for the PR. A PreToolUse hook
 *             does not call GitHub for the PR head. So land-pr.ps1 (which pins the head itself, land-decision.mjs) passes on a PR-level
 *             tap, and a raw merge command passes only with sha= or --match-head-commit equal to the tapped head.
 *             A command with several lands or merges (&& ; | newline) is judged one segment at a time: each needs its own tap and sha.
 *   store     a write to the decision store: Write, Edit, NotebookEdit, the Desktop Commander writes (write_file, edit_block,
 *             move_file and write_pdf, by path or destination; a .. in the path is collapsed), and shell text that writes the
 *             store or runs its code (node -e ...). Shell text that uses a tap up (land-decision.mjs use) or loops
 *             pr-checkpoint.mjs --json --pr is denied too: the model must not burn taps from a shell. That text check is best
 *             effort (a loop built from variables is not seen). Only decision-ledger writes decisions. A plain read passes.
 *   push      git push (git, git.exe, git-safe.ps1, git-for.ps1; any -C, -c, --no-pager before the verb) to the fork from a CCv3 checkout,
 *             to a branch other than main: needs "Commit and push" or "Push only" (ship step) for that branch and for the TREE being pushed.
 *             "Commit and push" is bound to the index tree before the commit (ship-ask.mjs), so the check compares it with <src|HEAD>^{tree}
 *             at push time: the head moves when the commit is made, the tree does not. "Push only" is asked with nothing staged and is bound
 *             to HEAD^{tree}. It licenses a push that has no commit chained before it, never a commit and push in one command. A force or delete form (--force, -f, --force-with-lease, +refspec,
 *             --mirror, --all, --tags, --delete, -d, --prune, :dst) is denied even with a tap. A push to origin (upstream) is denied.
 *             A dry run, --help, `git stash push`, another remote and a non-CCv3 checkout pass. A push to main passes unless it is a force form.
 *             A command with several pushes is judged one push at a time, like land.
 * Where it runs. A push, a create, a land and a merge are each judged in EVERY folder on the cd path before them (dirsAfter): with no cd,
 * the payload cwd; else the folder after each prefix of the cd list. The cwd joins them when any cd before the shape is joined to it by
 * something other than && (`;`, `||`, `|`, `&`, a line end), or follows a `||` or a pipe: that cd can fail or be skipped (`cd B extra`,
 * `true || cd B`) and the shell stays in the cwd (looseJoin, as pre-pr-gate planRun). A cd may not run (||, a subshell, &, a pipe, a comment),
 * so one deny in any of those folders denies. A cd after the shape never counts. When popd, Pop-Location, `cd -` or a bare cd comes
 * before a push, a create or a merge, the folder is unknown: it is denied if the cwd or a folder on the known cd path is a CCv3 checkout, or the
 * command names CCv3 (create and merge only). A push with an absolute -C names its folder, so it is judged there. The land script reads no folder, so it is judged by its tap only.
 * A cd target the shell expands and this hook cannot (`$D/..`, `$(pwd)/..`, a backtick, `~`, a glob, a PowerShell expression) is an unexpanded folder: denied in any checkout (cd-unexpanded),
 * and so is a relative cd after it (`cd $D && cd ..`). The same holds for a -C value. GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR in the text, and a cd alias (alias go=cd, Set-Alias go Set-Location),
 * are denied in any checkout too (the folder is not named). A bash cd name spelled `c\d`, `c''d` or `''cd` is read as cd. A comment line with an open `(` or backtick opens no subshell.
 * A wrapper before git (env, nice, timeout, xargs, setsid, sudo, with their options) is still a push.
 * Accepted over-deny: an unquoted read of the name (`echo $GIT_DIR`, `unset GIT_DIR`), an alias for cd that is never used, a variable cd before an absolute one (`cd $D && cd /abs`: the prefix is judged).
 * A quoted GIT_DIR= in an argument (`git commit -m "GIT_DIR= fix"`, `echo "GIT_DIR=x"`) is text. Accepted residual: `[Environment]::SetEnvironmentVariable('GIT_DIR', ...)`.
 * Accepted residual: `"cd" A` (a quoted name with letters in it), `sh -c '...'`, GIT_DIR set in the shell session before the command, GH_REPO, CDPATH,
 * a wrapper not listed (`doas`, `chrt`, `flock`), text sent to an existing Desktop Commander shell.
 * NOT gated: anything else. Known gaps: a push inside a child process (land-pr.ps1, scheduled jobs), `bash -c '...'`, a variable or alias for git.
 *
 * Mode. `decisions.enforce` is a TOP-LEVEL block of review-router.config.json (not `checkpoint`). Only a literal true denies.
 * Anything else, a missing file included, is WARN mode: the command runs and the hook adds a context line (and a log row).
 * This is the opposite of pre-pr-gate, which fails closed on a missing config: this gate ships OFF.
 * The push gate has its own flag, `decisions.enforcePush`, read the same way (a literal true denies; absent warns). A deny has a scope,
 * push or other, and the flag of its scope decides it in all three places: decide(), the subagent deny and the handle() catch.
 * A command that mixes a push with a land is judged per scope: either flag that is on denies its own part.
 * The config is read from the payload cwd upward (no git), then from <home>/continuous-claude.
 *
 * Posture when enforcing: a gated shape that cannot be judged (git fails, no PR number in the text) is denied. Everything else passes.
 * Unreadable input (not JSON) has no visible shape: it passes, with one line on stderr. Blocking it would block all work.
 * A subagent (agent_id) never has a tap: its create, land and merge are denied, and so is a push to the fork of a CCv3 checkout (a push in
 * another repo, or to another remote, is not ours). -CleanupOnly never merges, so it passes.
 * There is NO override: no SKIP_* variable. Dave's tap is the only way. The hook guards against mistakes, not a hostile agent:
 * a command built from variables, an indirect script, or a store write from a language other than node is not seen.
 * Known best-effort gap: a Windows 8.3 short name of the store (DECISI~1.JSN) reaches the same file and is not seen.
 * A tool path is read with a ::$DATA or :stream suffix and trailing dots or spaces removed. The fields read are PATH_FIELDS.
 *
 * Two gates: the PreToolUse matcher in settings.json.template and COMMAND_TOOLS / WRITE_TOOLS below.
 * Guard: hook-matcher-runtime-consistency.test.ts.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, resolve } from 'path';
import { isPrOpenCommand, isPrOpenText, joinContinuations, normalizeGh, squashQuotes } from './pr-opened-review-loop.js';
import { CCV3_REPO, namedRepo } from './shared/checkpoint-shapes.js';
import { decisionKey, decisionRead, decisionRows, decisionsPath } from './shared/decisions-store.js';
import { CALL_START, GLOBAL_OPT, PATH_PREFIX, VAL, gitCallRe, isGitToken, isSafeToken, safeCallRe } from './shared/git-call.js';
import { logGuardDecision, logGuardError } from './shared/guard-log.js';
import { blankInertQuotes, isTextOnlyCommand } from './shared/inert-quotes.js';
import { maskQuoted } from './shared/mask-quotes.js';
import { routerFlag } from './shared/router-config.js';
import { readShellCommand, mayRunUnderCmd } from './shared/shell-tools.js';

const HOOK = 'decision-gate';
const DC = 'mcp__plugin_desktop-commander_desktop-commander__';
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', `${DC}start_process`, `${DC}interact_with_process`]);
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit', `${DC}write_file`, `${DC}edit_block`, `${DC}move_file`, `${DC}write_pdf`]);
/** The fields of a write tool that name a file. The Desktop Commander field names are not fixed by a schema we can read: read them all. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'destination', 'source', 'outputPath'];
const GIT_TIMEOUT_MS = 2000;

export interface Deps {
  git: (cwd: string, args: string[]) => { status: number; stdout: string };
  readFile: (path: string) => string | null;
  env: NodeJS.ProcessEnv;
  home: string;
}
/** Which flag decides a deny: `push` is decisions.enforcePush, `other` is decisions.enforce. */
export type Scope = 'push' | 'other';
export type Deny = { action: 'deny'; reason: string; pattern: string; scope: Scope };
export type Decision = { action: 'allow'; warn?: string; scope?: Scope } | Deny;
interface HookInput { tool_name?: string; tool?: string; tool_input?: Record<string, unknown>; cwd?: string; agent_id?: string; session_id?: string }

/** The label of a decision that lets the action run. Any other label (Keep open, Stop here, Show ..., a re-run) does not. */
export const isOpenPrLabel = (label: string): boolean => /^Open draft PR\b/.test(label);
export const isLandLabel = (label: string): boolean => /^Land (?:now|when READY)\b/.test(label);
export const isShipLabel = (label: string): boolean => /^Commit and push\b/.test(label);
/** The tap of ship-ask when nothing is staged. Anchored: "Push only now" is not this label. */
export const isPushOnlyLabel = (label: string): boolean => /^Push only(?: \(Recommended\))?$/.test(label);

// ---------- the question to ask, per deny ----------

const deny = (pattern: string, why: string, scope: Scope = 'other'): Deny => ({ action: 'deny', pattern, scope, reason: `BLOCKED (decision-gate): ${why}` });
const openPrWhy = (branch: string, head: string): string =>
  `no "open-pr" decision from Dave for ${branch} at ${head.slice(0, 7)}. Ask him first: run node scripts/github/ship-ask.mjs open-pr --branch ${branch} --json, pass its JSON to AskUserQuestion word for word, then open the PR only if he taps "Open draft PR".`;
const landWhy = (pr: string): string =>
  `no "land" decision from Dave for PR #${pr}. Ask him first: run node scripts/github/ship-ask.mjs land --pr ${pr} --json, pass its JSON to AskUserQuestion word for word. Only "Land now" or "Land when READY" lets a land run. If the PR already merged, run land-pr.ps1 -Pr ${pr} -CleanupOnly.`;
const pushWhy = (branch: string): string =>
  `no "ship" decision from Dave for the tree you push to ${branch}. Ask him first: run node scripts/github/ship-ask.mjs commit-and-push --branch ${branch} --json, pass its JSON to AskUserQuestion word for word, then push only after he taps "Commit and push" (files staged) or "Push only" (nothing staged). The tap is bound to one tree: the staged tree, or HEAD's tree for "Push only". A change after the tap (a merge, a new commit) needs a new tap. Run the ship as a bare commit && push: no redirect, no pipe, no trailing command. Report the result in a separate command.`;
const PUSH_UNSAFE_WHY = 'a force, delete, mirror, all-branch or tag push can rewrite or remove remote refs, so it stays blocked even with Dave\'s tap. Push without that option. If it is really needed, ask Dave to run it himself.';
const PUSH_ORIGIN_WHY = 'a push to origin is never allowed: origin is upstream (parcadei), not the fork. Push to the fork remote.';
const pushUnresolvedWhy = (what: string): string => `${what}, so its ship decision cannot be found. Name the remote and branch (git push fork <branch>) and run it from the repo.`;
const STORE_WHY = 'only decision-ledger writes the decision store, from Dave\'s tap in AskUserQuestion. Do not write it by hand. To record a decision, ask the question with AskUserQuestion.';
const SUBAGENT_WHY = 'a subagent cannot open a PR, land, merge or push: Dave\'s tap belongs to the main session. Ask the main session to do it.';
const NO_PR_WHY = 'the PR number cannot be read from this command, so its land decision cannot be found. Name the PR number in the command (land-pr.ps1 -Pr <n>, gh pr merge <n>).';

// ---------- the store, as text and as a path ----------

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
const STORE_PATH_RE = /ccv3-mods\/decisions\.json(?:\.|$)/;

// For shell TEXT the path is not at the end: arguments, quotes or a ; follow it. Any prefix ($HOME, ~, %USERPROFILE%, a drive) ends the same way.
// A name that goes on (decisions.jsonx, decisions.json-old) is another file. A dot is not a word char here: decisions.json.lock is the lock.
const STORE_TEXT_RE = /ccv3-mods\/+decisions\.json(?![\w-])/;

/** A Windows path spelling that reaches the same file: drop a ::$DATA or :stream suffix, then trailing dots and spaces (not a lone . or ..). */
function dropAliasSuffix(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1;
  const leaf = p.slice(cut).replace(/:.*$/s, '').replace(/([^. ])[. ]+$/, '$1');
  return p.slice(0, cut) + leaf;
}

/**
 * True when a file path is the decision store, its lock or a tmp file of it (the default path, or the CCV3_DECISIONS_FILE path).
 * Known best-effort gap: an 8.3 short name (DECISI~1.JSN) reaches the same file and is not seen.
 */
function isStorePath(p: string, deps: Deps, cwd: string): boolean {
  const full = norm(resolve(cwd, dropAliasSuffix(p))); // always resolve: it collapses a .. in an absolute path too
  const store = norm(decisionsPath(deps.env));
  return STORE_PATH_RE.test(full) || full === store || full.startsWith(`${store}.`);
}

// Only flags that take no value may sit before the store: -Destination, -t and --target-directory name the store as the DESTINATION, so they never match.
// cp, copy or Copy-Item, optional flags, then the store as the FIRST path, then a destination. Quoted paths with spaces do not match: they stay denied.
const escRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The read-copy shape for the default store path and for the CCV3_DECISIONS_FILE path of this run. */
function readCopyRe(deps: Deps): RegExp {
  const store = escRe(norm(decisionsPath(deps.env)));
  return new RegExp(`\\b(?:cp|copy|copy-item)\\s+(?:-(?:[frpavinu]{1,4}|-?(?:force|recurse|recursive|verbose|confirm|whatif))\\s+)*["']?(?:(?:[^\\s"';|&]*\\/)?ccv3-mods\\/+decisions\\.json|${store})["']?(?=\\s+[^\\s;|&])`, 'gi');
}
const STORE_CODE_RE = /[\\/]lib[\\/]decisions\.mjs/i;
const STORE_FN_RE = /\b(?:decisionRecord|offerWrite|decisionUse|missBump)\b/;
const WRITE_SIGNAL_RE = /(?<![\d&])>|\b(?:Set-Content|Add-Content|Out-File|Clear-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|tee|sed|mv|cp|rm|del|truncate|dd|ln)\b|\b(?:writeFile|appendFile|writeFileSync|rename)/i;
const CODE_SIGNAL_RE = /\bnode(?:\.exe)?\b[^|;&\n]*?(?:\s-e\b|\s--eval\b|\s-p\b|\s--print\b|--input-type)|\bimport\s*\(|\brequire\s*\(/i;

// Code (node -e) that names the store is a write unless it only reads: it calls a read API and holds nothing that can write, copy, open, run a program or load code.
// Anything else stays denied (fail closed). `=>` and `>` still count as a write signal above.
// require() may load only fs or the store file itself: any other module, a variable argument, string building, a template or bracket access on a string can reach a writer, so it stays denied.
const READ_ONLY_CODE_RE = /\b(?:readFileSync|readFile)\s*\(|\brequire\s*\(\s*["'][^"']*decisions\.json["']\s*\)/;
const CODE_CAN_WRITE_RE = new RegExp([
  'write|append|copy|rename|unlink|\\brm|truncate|open|link|mkdir|chmod|chown|utimes|stream|child_process|spawn|exec|eval|\\bFunction\\b|import\\s*\\(|\\bflags?\\b|O_[A-Z]',
  'process\\.binding|decisions\\.mjs|decisionRecord|offerWrite|decisionUse|missBump|fetch|https?:',
  '\\brequire\\s*\\(\\s*(?!["\'](?:(?:node:)?fs|[^"\']*decisions\\.json)["\']\\s*\\))',
  '["\'`]\\s*\\+|\\+\\s*["\'`]|\\$\\{|\\[\\s*["\'`]',
].join('|'), 'i');

// A tap is used up by land-decision.mjs use (land-pr.ps1 calls it after the merge), and a pr-checkpoint.mjs run may post a probe or offer.
// The model must not run the first from a shell, nor loop the second.
const USE_TAP_RE = /land-decision\.mjs["']?\s+["']?use\b/i;
const CHECKPOINT_RUN_RE = /pr-checkpoint\.mjs\b(?=[^\n]*--json)(?=[^\n]*--pr\b)/i;
const LOOP_RE = /\b(?:for|foreach|while|until|xargs|seq)\b|ForEach-Object|\d+\.\.\d+|%\s*\{/i;

/**
 * Shell text that writes the store, runs its code, uses a tap up or loops pr-checkpoint. A read (cat, Get-Content, rg) of the path passes.
 * Best effort, like the whole gate: text built from variables or run through another script is not seen.
 */
function writesStoreText(text: string, deps: Deps): boolean {
  if (USE_TAP_RE.test(text) || (CHECKPOINT_RUN_RE.test(text) && LOOP_RE.test(text))) return true;
  const flat = text.replace(/\\/g, '/');
  // A copy whose first source is the store only reads it. The mention is cut out; a later mention (the destination, a second command) still counts.
  const lower = norm(flat.replace(readCopyRe(deps), ' '));
  const names = [lower, squashQuotes(lower)].some((t) => STORE_TEXT_RE.test(t)) || lower.includes(norm(decisionsPath(deps.env)));
  const code = CODE_SIGNAL_RE.test(text);
  if (names || STORE_CODE_RE.test(text)) {
    if (WRITE_SIGNAL_RE.test(flat)) return true;
    if (!code) return false;
    return !(names && !STORE_CODE_RE.test(text) && READ_ONLY_CODE_RE.test(text) && !CODE_CAN_WRITE_RE.test(text));
  }
  return STORE_FN_RE.test(text) && code;
}

// ---------- the command shapes ----------

/** One push, read from the text. `branch` and `remote` are null when the command names none (resolved later, in the checkout). */
interface PushShape {
  remote: string | null;
  /** The branch the push updates: the refspec destination, else its source; null for HEAD or no refspec (the current branch). */
  branch: string | null;
  /** The source ref whose tree is pushed; null is HEAD. */
  src: string | null;
  /** The -C value, raw. */
  dir: string | null;
  /** The cd targets (raw) that come before this push in the command text, in order. They may set the folder git runs the push in. A cd may not run, so the push is judged in the folder after each prefix (pushDirsOf). */
  cds: string[];
  /** Some cd before this push is joined to it by something other than &&, or follows a || or a pipe (see looseJoin): the push may run in the payload cwd. */
  loose: boolean;
  /** A popd, Pop-Location, `cd -` or a bare cd comes before this push: the folder is unknown (see judgePushAt). */
  unknown: boolean;
  /** A force or delete form (see FORCE_LONG). */
  force: boolean;
  /** --git-dir or --work-tree moves the repo: the checkout cannot be known. */
  moved: boolean;
}
/**
 * Where a create, a land or a merge runs: the cd targets (raw) before it, and whether a popd, Pop-Location, `cd -` or a bare cd made the folder unknowable.
 * `loose`: some cd before it is joined to the shape by a ; || | & or line end (not only &&), so that cd may fail and leave the shell in the payload cwd.
 */
interface Where { cds: string[]; unknown: boolean; loose: boolean }
interface Shape {
  kind: 'create' | 'land' | 'merge' | 'store' | 'push'; pr: string | null; sha?: string | null; push?: PushShape;
  /** Create, land and merge: where the shape runs. */
  at?: Where;
  /** Create: the text of its own command (cut at the next break outside quotes), raw and with its quoted strings masked. The head is read from here only. */
  text?: string;
  mtext?: string;
}
const scopeOf = (s: Shape): Scope => (s.kind === 'push' ? 'push' : 'other');

const LAND_SCRIPT_RE = /\bland-pr\.ps1\b/i;
const LAND_PR_RE = /(?:^|\s)-P(?:r)?(?:\s+|:|=)["']?(\d+)\b/i;
/** Looser than LAND_PR_RE: -P or -Pr, then any run of space, :, =, or quote marks, then a digit. Used only to refuse the text-only exemption. */
const PR_NUMBER_IN_TEXT_RE = /-Pr?[\s:="']*\d/i;
const CLEANUP_RE =/(?:^|\s)-CleanupOnly\b/i;
const MERGE_CLI_RE = /\bgh\s+pr\s+merge\b([^|;&\n]*)/i;
const MERGE_API_RE = /\bgh\s+api\b[^|;&\n]*\/pulls\/(\d+)\/merge\b[^|;&\n]*/i;
const GET_RE = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))GET\b/i;
const SHA_RE = /(?:\bsha=|--match-head-commit(?:\s+|=))["']?([0-9a-f]{40})\b/i;
const SEGMENT_RE = /[;&|\r\n]+/;

const lastArg = (args: string, re: RegExp): string | null => re.exec(args)?.[1] ?? null;

/** The land and merge shapes of ONE command segment (no && ; | or newline in it), with the PR and the sha read from that segment alone. */
function landShapesOf(seg: string, textOnly = false): Shape[] {
  const out: Shape[] = [];
  const sha = SHA_RE.exec(seg)?.[1]?.toLowerCase() ?? null;
  // textOnly: the whole command only prints or reads text (isTextOnlyCommand), so the script name is a mention. A mention that names a PR (-Pr 12) stays a land shape.
  const pr = lastArg(seg, LAND_PR_RE);
  if (LAND_SCRIPT_RE.test(seg) && !CLEANUP_RE.test(seg) && !(textOnly && pr === null)) out.push({ kind: 'land', pr, sha });
  const cli = MERGE_CLI_RE.exec(seg);
  if (cli) out.push({ kind: 'merge', pr: lastArg(cli[1], /(?:^|\s)(?:["']?)(\d+)(?=\s|["']|$)/) ?? lastArg(cli[1], /\/pull\/(\d+)/), sha });
  const api = MERGE_API_RE.exec(seg);
  if (api && !GET_RE.test(api[0])) out.push({ kind: 'merge', pr: api[1], sha });
  return out;
}

// ---------- the push shape ----------

// A wrapper may sit before git: env (with options and assignments), nice, timeout (with a duration), xargs, setsid, sudo (with options). The push is the same push.
// It is part of the lead-in (group 1), like the shared CALL_START words. Regex only. sh -c '...' stays a known gap.
const WRAPPERS = String.raw`(?:env(?:\s+(?:-[uCS]\s+\S+|-\S+|\w+=\S*))*|nice(?:\s+-\S+(?:\s+\d+)?)*|timeout(?:\s+-\S+(?:\s+[A-Z0-9]+)?)*\s+[\d.]+[smhd]?|xargs(?:\s+-\S+(?:\s+(?:\d+|\{\}))?)*|setsid(?:\s+-\S+)*|sudo(?:\s+-\S+(?:\s+\w+)?)*)\s+`;
const PUSH_GIT = new RegExp(String.raw`(${CALL_START}(?:${WRAPPERS})*)(${PATH_PREFIX}git(?:\.exe)?|"\s*"|'\s*')(${GLOBAL_OPT})(\s+push)(?=\s|$)`, 'g');
const PUSH_WRAPPERS = 'git-(?:safe|for)';
/** A PowerShell parameter may be shortened to its first letters (unique prefix) and ignores case. */
const abbr = (name: string, min: number): string => name.slice(0, min) + [...name.slice(min)].reduceRight((acc, ch) => `(?:${ch}${acc})?`, '');
// git-for.ps1 has its own parameters before the git arguments: `git-for.ps1 -UseGitSafe -Remote fork push fork b`, `-Path <dir> push ...`.
// -Path is the directory git runs in, like git -C.
const GIT_FOR_OPTS = String.raw`-(?:${abbr('Path', 2)}|${abbr('Remote', 1)})(?::|\s+)${VAL}|-(?:${abbr('WhichAccount', 2)}|${abbr('UseGitSafe', 1)})(?=\s)|`;
const PUSH_SAFE = safeCallRe('push', PUSH_WRAPPERS, GIT_FOR_OPTS, 'gi');
/** Where the arguments of a push end in the masked view: a segment break, or the ) or } that closes a group. */
const ARGS_END_RE = /[;&|\r\n)}]/;
const DIR_OPT_RE = new RegExp(String.raw`(?:^|\s)-C\s+(${VAL})`, 'g');
const PATH_OPT_RE = new RegExp(String.raw`(?:^|\s)-${abbr('Path', 2)}(?::|\s+)(${VAL})`, 'gi');
const MOVE_OPT_RE = /(?:^|\s)--(?:git-dir|work-tree)(?:=|\s)/;
const REDIRECT_RE = /(?:^|\s)\d*[<>]+\S*/g;
/** Options that take the next word as their value (or `--opt=value`, handled by the `--` branch). */
const VALUE_OPTS = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o']);
const FORCE_LONG = /^--(?:force(?:-with-lease|-if-includes)?|mirror|all|branches|tags|delete|prune)(?:=.*)?$/;

interface RawPush { opts: string; args: string; cds: string[]; loose: boolean; unknown: boolean }

/**
 * The push calls of one view. `masked` and `raw` have the same length. `atStart`: the call must open the text (the squashed view).
 * `before`: the cd targets that come before the text (the squashed view is one segment; the segments before it hold the cds).
 */
function pushCallsOf(masked: string, raw: string, atStart: boolean, before: Where = { cds: [], unknown: false, loose: false }, cutView: string = masked): RawPush[] {
  const calls: RawPush[] = [];
  const kinds: [RegExp, (token: string) => boolean][] = [[PUSH_GIT, isGitToken], [PUSH_SAFE, (t) => isSafeToken(t, PUSH_WRAPPERS)]];
  for (const [re, valid] of kinds) {
    for (const m of masked.matchAll(re)) {
      const tokenStart = m.index! + m[1].length;
      if (!valid(raw.slice(tokenStart, tokenStart + m[2].length))) continue;
      if (atStart && masked.slice(0, m.index!).trim() !== '') continue;
      const optsStart = tokenStart + m[2].length;
      const end = m.index! + m[0].length;
      const cut = cutView.slice(end).search(ARGS_END_RE);
      const own = cdsBefore(masked.slice(0, tokenStart), raw.slice(0, tokenStart));
      calls.push({
        opts: raw.slice(optsStart, optsStart + m[3].length), args: raw.slice(end, cut < 0 ? raw.length : end + cut),
        cds: [...before.cds, ...own.cds], loose: before.loose || own.loose, unknown: before.unknown || own.unknown,
      });
    }
  }
  return calls;
}

/** The quote marks of a view become segment breaks, same length. A call inside a quoted string then sits at a command position. */
const quotesToBreaks = (view: string): string => view.replace(/["']/g, ';');
/** The quote marks become spaces, same length. cmd.exe runs a quoted program name (`"git" push`), so that call has to stay one command. */
const quotesToSpaces = (view: string): string => view.replace(/["']/g, ' ');
/**
 * `cd "<path>"` at a command position, written with its double quotes as spaces, same length: the path is one plain word. cmd.exe pairs the double
 * quote and cds to the path. Only a path with no space and no %, $, backtick, ^, ( ), & | ; < > (nothing that expands or splits), ending the segment.
 * A single-quoted target stays a bare cd under the break view: cmd.exe reads 'A' as a folder name, so the shell may not move (unknown, denied).
 * Without this the quote-break view reads `cd "A" && git push` as a bare cd and denies a push whose folder the text names.
 */
const PLAIN_QUOTED_CD = /(^|[;&|\r\n(]\s*)((?:cd|chdir)\s+)"([^\s"'%$`^()&|;<>\r\n]+)"(?=\s*(?:$|[;&|\r\n)]))/gi;
const plainCdUnquoted = (view: string): string => {
  // cmd.exe reads ^ as an escape: any ^ keeps every quote as it is (fail closed).
  if (view.includes('^')) return view;
  return view.replace(PLAIN_QUOTED_CD, (match: string, lead: string, cd: string, path: string, offset: number) => {
    // A cd inside a double-quoted span of the text is no command for cmd.exe (an odd number of " before it): it stays a bare cd and is denied.
    const quotesBefore = (view.slice(0, offset).match(/"/g) ?? []).length;
    return quotesBefore % 2 === 0 ? `${lead}${cd} ${path} ` : match;
  });
};

/**
 * The push calls of a command: the bash view, the pwsh view, and each bash segment with its quotes deleted (`g"i"t push`, `git "push"`).
 * `cmdExe`: Desktop Commander may run cmd.exe. cmd.exe treats ' as a plain character and & as a command break, so
 * echo 'x & git push fork b & rem ' runs the push. Then a third reading (only when blanking changed the text) sees a call inside quotes.
 * The arguments of that call end at the first break in the real text (quotes kept). A double-quoted echo of a push is denied too (accepted over-deny).
 */
function pushCallsIn(raw: string, cmdExe = false): RawPush[] {
  const bash = joinContinuations(raw, 'bash');
  const pwsh = joinContinuations(raw, 'pwsh');
  const maskedBash = maskQuoted(bash, 'Bash');
  const maskedPwshOnBash = maskQuoted(bash, 'PowerShell');
  const maskedPwsh = maskQuoted(pwsh, 'PowerShell');
  const calls = [...pushCallsOf(maskedBash, bash, false), ...pushCallsOf(maskedPwsh, pwsh, false)];
  if (cmdExe) {
    const cmdBash = plainCdUnquoted(bash);
    const cmdPwsh = plainCdUnquoted(pwsh);
    for (const view of [quotesToBreaks, quotesToSpaces]) {
      if (maskedBash !== bash) calls.push(...pushCallsOf(view(cmdBash), cmdBash, false, undefined, cmdBash));
      if (maskedPwsh !== pwsh) calls.push(...pushCallsOf(view(cmdPwsh), cmdPwsh, false, undefined, cmdPwsh));
    }
  }
  let from = 0;
  const breaks = [...maskedBash.matchAll(/[;&|\r\n]+/g)].map((m) => [m.index!, m.index! + m[0].length] as const);
  for (const [start, next] of [...breaks, [bash.length, bash.length] as const]) {
    const seg = bash.slice(from, start);
    // \" escapes in bash, not in PowerShell: each mask can hide a cd the other shows. Read the cds under both and keep each list that differs.
    const lists = [cdsBefore(maskedBash.slice(0, from), bash.slice(0, from)), cdsBefore(maskedPwshOnBash.slice(0, from), bash.slice(0, from))];
    from = next;
    const squashed = squashQuotes(seg);
    if (squashed === seg) continue;
    for (const before of distinctWheres(lists)) calls.push(...pushCallsOf(squashed, squashed, true, before));
  }
  return calls;
}

const REF_HEADS = /^refs\/heads\//;

/** The shapes of one push call: one per refspec, or one with no refspec. A dry run or a help request has none. */
function pushShapesFrom(call: RawPush): Shape[] {
  const tokens = call.args.replace(REDIRECT_RE, ' ').split(/\s+/).map(squashQuotes).filter(Boolean);
  const dirs = [...call.opts.matchAll(DIR_OPT_RE), ...call.opts.matchAll(PATH_OPT_RE)].sort((a, b) => a.index! - b.index!);
  const dir = dirs.map((m) => squashQuotes(m[1])).pop() ?? null;
  const positional: string[] = [];
  let force = false;
  let quiet = false; // --dry-run, -n, --help, -h
  let literal = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (literal || !t.startsWith('-') || t === '-') { positional.push(t); continue; }
    if (t === '--') { literal = true; continue; }
    if (VALUE_OPTS.has(t)) { i++; continue; }
    if (t.startsWith('--')) {
      if (FORCE_LONG.test(t)) force = true;
      if (t === '--dry-run' || t === '--help') quiet = true;
    } else if (/^-[A-Za-z0-9]+$/.test(t)) {
      if (/[fd]/.test(t)) force = true;
      if (/[nh]/.test(t)) quiet = true;
    }
  }
  if (quiet) return [];
  const [remote = null, ...specs] = positional;
  const base = { remote, dir, cds: call.cds, loose: call.loose, unknown: call.unknown, moved: MOVE_OPT_RE.test(` ${call.opts}`) };
  if (specs.length === 0) return [{ kind: 'push', pr: null, push: { ...base, branch: null, src: null, force } }];
  const out: Shape[] = [];
  for (let i = 0; i < specs.length; i++) {
    let spec = specs[i];
    let rewrite = force;
    if (spec === 'tag') { rewrite = true; i++; spec = specs[i] ?? 'tag'; } // `tag <name>` pushes refs/tags/<name>
    if (spec.startsWith('+')) { rewrite = true; spec = spec.slice(1); }
    const colon = spec.indexOf(':');
    const rawSrc = colon < 0 ? spec : spec.slice(0, colon);
    const rawDst = colon < 0 ? '' : spec.slice(colon + 1);
    if (colon >= 0 && rawSrc === '') rewrite = true; // `:dst` deletes dst
    if (/^refs\/tags\//.test(rawDst || rawSrc)) rewrite = true;
    const src = rawSrc.replace(REF_HEADS, '');
    const name = (rawDst || rawSrc).replace(REF_HEADS, '');
    out.push({ kind: 'push', pr: null, push: { ...base, branch: name === '' || name === 'HEAD' ? null : name, src: src === '' || src === 'HEAD' ? null : src, force: rewrite } });
  }
  return out;
}

/** Every push shape of a command, de-duplicated across the views. */
function pushShapesOf(raw: string, tool?: string): Shape[] {
  const out: Shape[] = [];
  const seen = new Set<string>();
  for (const call of pushCallsIn(raw, mayRunUnderCmd(tool))) {
    for (const shape of pushShapesFrom(call)) {
      const p = shape.push!;
      const id = [p.remote, p.branch, p.src, p.dir, p.force, p.moved, p.loose, p.unknown, p.cds.join('\0')].join('|');
      if (!seen.has(id)) { seen.add(id); out.push(shape); }
    }
  }
  return out;
}

/** The segments of a view, split on && ; | and line ends in the RAW text, each with its start offset. A quoted break splits too: detection reads more, never less. */
function cmdSegments(view: string): { seg: string; from: number }[] {
  const out: { seg: string; from: number }[] = [];
  let from = 0;
  for (const m of view.matchAll(new RegExp(SEGMENT_RE.source, 'g'))) {
    out.push({ seg: view.slice(from, m.index!), from });
    from = m.index! + m[0].length;
  }
  out.push({ seg: view.slice(from), from });
  return out;
}

const whereId = (at: Where): string => `${at.unknown ? '?' : ''}${at.loose ? '~' : ''}${at.cds.join('\0')}`;
/** The folders a segment may run in, one `Where` per distinct reading of the cds before it. */
const distinctWheres = (wheres: Where[]): Where[] => wheres.filter((w, i) => wheres.findIndex((o) => whereId(o) === whereId(w)) === i);

/**
 * The shapes of one command text (continued lines joined, both shells read). EVERY create, land and merge shape is returned, one per segment:
 * the text is split on && ; | and newlines, and each segment is read alone, so a tap for the first PR does not cover the second.
 * Each shape also carries where it runs: the cds before its segment, read under the Bash mask AND the PowerShell mask (a \" escapes in one
 * and not in the other, so each mask can hide a cd the other shows). The readings (bash, pwsh, quotes deleted) are united and de-duplicated,
 * and the cds are part of the id: the same shape in two folders is two shapes. An extra shape only makes the gate stricter.
 */
function shapesOf(raw: string, tool?: string): Shape[] {
  // The words of a create, land or merge inside the quoted text of a harmless command (lane add --title "gh pr create", echo, commit -m) are text. Push is read from raw below.
  const text = normalizeGh(blankInertQuotes(raw, tool));
  const views = [...new Set([joinContinuations(text, 'bash'), joinContinuations(text, 'pwsh')])];
  // A read or print command that only names the land script is text. Only for the tools whose quote rules we read (Bash, PowerShell):
  // Desktop Commander may run cmd.exe. All three readings of the raw text must be text-only (a continuation can differ between shells).
  // A PR number anywhere in the raw text (class B) keeps the land shape. It is read from the RAW text, with no space needed before -Pr:
  // an inert head blanks a quoted "-Pr 12", and LAND_PR_RE (which needs a space before -Pr) misses `"-Pr 12"`.
  const textOnly = (tool === 'Bash' || tool === 'PowerShell')
    && !PR_NUMBER_IN_TEXT_RE.test(raw)
    && [raw, joinContinuations(raw, 'bash'), joinContinuations(raw, 'pwsh')].every(isTextOnlyCommand);
  const out: Shape[] = [];
  const seen = new Set<string>();
  const add = (shape: Shape, id: string): void => { if (!seen.has(id)) { seen.add(id); out.push(shape); } };
  let created = false;
  for (const view of views) {
    const reads = (['Bash', 'PowerShell'] as const).map((tool) => { const masked = maskQuoted(view, tool); return { masked, pos: cdPositions(masked, view) }; });
    for (const { seg, from } of cmdSegments(view)) {
      const wheres = distinctWheres(reads.map((r) => whereAt(r.pos, from)));
      for (const s of new Set([seg, squashQuotes(seg)])) {
        for (const shape of landShapesOf(s, textOnly)) {
          for (const at of wheres) add({ ...shape, at }, `${shape.kind}|${shape.pr}|${shape.sha}|${whereId(at)}`);
        }
      }
      if (!isPrOpenText(seg)) continue;
      created = true;
      for (const { masked } of reads) {
        // The create's own command ends at the next break OUTSIDE quotes: a quoted ; in --title does not cut off a --head after it.
        const cut = masked.slice(from).search(SEGMENT_RE);
        const to = cut < 0 ? view.length : from + cut;
        const own = view.slice(from, to);
        for (const at of wheres) add({ kind: 'create', pr: null, at, text: own, mtext: masked.slice(from, to) }, `create|${whereId(at)}|${own}`);
      }
    }
  }
  // A create that no single segment shows (`gh pr` + newline + `create`): judge the whole text in the cwd and in every folder of the cds.
  if (!created && isPrOpenCommand(text)) {
    const view = views[0];
    const masked = maskQuoted(view, 'Bash');
    for (const at of [{ cds: [], unknown: false, loose: false }, whereAt(cdPositions(masked, view), view.length)]) {
      add({ kind: 'create', pr: null, at, text: view, mtext: masked }, `create|${whereId(at)}|${view}`);
    }
  }
  out.push(...pushShapesOf(raw, tool));
  return out;
}

// ---------- config ----------

/** decisions.enforce of the review-router.config.json found from `cwd` upward, else under <home>/continuous-claude. Only a literal true enforces. */
const enforcing = (deps: Deps, cwd: string): boolean => routerFlag(cwd, deps.readFile, deps.home, 'decisions', 'enforce');
/** decisions.enforcePush: the push gate's own flag, so a push can warn while create, land and merge enforce. Absent is warn. */
const enforcingPush = (deps: Deps, cwd: string): boolean => routerFlag(cwd, deps.readFile, deps.home, 'decisions', 'enforcePush');
const enforcingScope = (scope: Scope, deps: Deps, cwd: string): boolean => (scope === 'push' ? enforcingPush(deps, cwd) : enforcing(deps, cwd));
const FLAG_OF: Record<Scope, string> = { push: 'decisions.enforcePush', other: 'decisions.enforce' };

// ---------- the checkout ----------

// The same reading as pre-pr-gate (PR #411: CMD_POS, CD_NAMES, CD_TARGET, UNKNOWN_CD), kept as its own copy. A cd that is not seen runs the shape in a folder
// that is never judged. A SURE command position is the start or a separator, then any run of openers (a brace, `(`, a backtick, `!`, then, else, do, if,
// while, until, elif, time). `{`, then, else and do count only there: in `echo then cd B` or `Start-Job { cd B }` the word is no command position, so the
// cd is no sure cd. They still count as LOOSE positions (the `soft` group): the cd is read, but the cwd is judged too (cdPositions). `(`, a backtick,
// `)` (a case pattern) are loose anywhere. After the opener: variable prefixes (X=1), a PowerShell `$x =`, builtin, command or eval words, a module name
// (Microsoft.PowerShell.Management\) and one backslash (\cd). The scriptblock of `Invoke-Command` and `icm` runs in the current session: a sure position.
// The gap after the name is spaces or tabs only: `cd` + newline is a bare cd (UNKNOWN_CD_SOURCE), and the next line is not its target.
const OPENER = String.raw`(?:\{\s*|[(\`!]\s*|(?:then|else|do|if|while|until|elif)\s+|time\s+(?:(?:-p|--)\s+)*)`;
const CMD_POS = String.raw`(?:(?<hard>(?:^|[;&|\r\n]\s*|#>\s*|\b(?:Invoke-Command|icm)\s+(?:-ScriptBlock\s+)?(?=\{))${OPENER}*)|(?<soft>(?:[)(\`]\s*|\{\s*|\b(?:then|else|do)\s+)${OPENER}*))`
  + String.raw`(?:(?:[A-Za-z_]\w*\+?=[^\s;&|]*|(?:\d*[<>]{1,2}&?|&>>?)[^\s;&|]+)[ \t]+)*(?:\$\w+[ \t]*=[ \t]*)?(?:(?:builtin|command|eval)\s+(?:(?:-p|--)\s+)*)*(?:[\w.]+\\)?\\?`;
// A bash cd name may be spelled with a backslash or an empty quote pair between (and around) its letters: `c\d`, `c''d`, `c""d`, `''cd`. Bash still runs cd, so the cd is read
// and its folder judged. A quoted name with letters inside (`"cd" A`) stays a residual: the mask blanks it. PowerShell names stay literal.
const NOISE = String.raw`(?:\\|''|"")*`;
const spell = (word: string): string => NOISE + [...word].join(NOISE) + NOISE;
const CD_NAMES = `${spell('cd')}|Set-Location|sl|${spell('chdir')}|${spell('pushd')}|Push-Location`;
// A bash option (cd -P A, cd -- A) or a PowerShell parameter (-Path A, -Path:A) may come before the target. The target is one word of plain
// characters, quoted parts and escapes (`P/"x"`, `P/x\ y`); it ends before a closing `)` or backtick of a subshell. A backtick pair is one part of the target
// (a command substitution: `cd `pwd`/x`), so the cd is read and its folder fails closed. A backslash escapes a character that is no separator, so a PowerShell
// folder that ends in `\` (`Set-Location X\&& y`) does not swallow the next `;`, `&` or `|`. The same reading as pre-pr-gate CD_TARGET (PR #421).
const CD_SOURCE = CMD_POS + String.raw`(?:${CD_NAMES})[ \t]+(?:(?:-[PLe@]+|--)[ \t]+)*(?:-(?:LiteralPath|Path|PSPath)(?:[ \t]+|:))?(?<t>(?:"[^"]*"|'[^']*'|\`[^\`]*\`|\\[^;&|\r\n]|[^\s;&|)\`"'\\])+)`;
// A job, a parallel block or a remote block runs its cd in another runspace, process or machine: the parent shell does not move. True when the text before a cd
// has an open `{` that follows such a word: Start-Job, Start-ThreadJob, pwsh, -Parallel and -AsJob (also -Pa, -Para ... and -As, -AsJo ...), or an Invoke-Command /
// icm with anything between the word and the block but -ScriptBlock (`icm -cn srv {`, `Invoke-Command srv {`, `Invoke-Command @p {`: the target comes before the block).
// It runs on the text with its closed `{ ... }` groups removed (withoutClosed), so `if (1) {}` or `@{}` inside the block does not end it.
const JOB_BLOCK = /(?:\bStart-(?:Job|ThreadJob)\b|\bsajb\b|\b(?:pwsh|powershell)(?:\.exe)?\b|-(?:Pa(?:r(?:a(?:l(?:l(?:e(?:l)?)?)?)?)?)?|As(?:J(?:o(?:b)?)?)?)\b|\b(?:Invoke-Command|icm)\b(?!\s+(?:-ScriptBlock\s+)?\{))[^{};&|\r\n]*\{[^}]*$/i;

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
/** True when the text before a cd leaves a `(`, `$(`, `<(` or backtick open: the cd is inside a subshell or a substitution, so it may not last (`(true && cd B) && push`). */
// A comment line (`# (x`) opens no subshell: the text from a `#` at the start or after a blank to the line end is dropped first. A blank after a backslash is escaped, so its `#`
// is no comment. A `#` inside a word (`a#(x`, `$#`) is no comment either. The cost of a wrong guess is an over-deny, never a fail-open.
const COMMENT = /(?:^|(?<!\\)\s)#[^\r\n]*/g;
const insideSubshell = (before: string): boolean => /[(`]/.test(withoutClosed(before.replace(COMMENT, ''), CLOSED_PARENS));
const gitBashPath = (p: string): string => (process.platform === 'win32' ? p.replace(/^\/([A-Za-z])(?:\/|$)/, '$1:/') : p);

/**
 * True when a cd target holds text the shell expands and this hook does not: `$var`, `$(..)`, `${..}`, `%VAR%`, a backtick, a leading `~`, a glob (`*`, `?`, `[`)
 * or a leading `(` or `@` (a PowerShell expression). Read as a path it names a folder that does not exist, or, with a `..` after it (`$D/..`), the cwd. The same
 * reading as pre-pr-gate hasUnexpandedPart, kept as this gate's own copy.
 */
function hasUnexpandedPart(target: string): boolean {
  const t = target.replace(/^["']|["']$/g, '');
  return /[$`*?[]/.test(t) || /%[^%\s]+%/.test(t) || t.startsWith('~') || /^[(@]/.test(t);
}
/** A folder this hook cannot name. It starts every such path, so a later relative cd keeps it (`cd $D && cd ..`), and only an absolute cd names a folder again. */
const UNEXPANDED = '<cannot-expand>';
const isUnexpanded = (dir: string): boolean => dir.startsWith(UNEXPANDED);
const unexpandedWhy = (dir: string): string => `a cd target or -C value (${dir.slice(UNEXPANDED.length, UNEXPANDED.length + 120)}) holds a variable, a command substitution, a ~ or a glob, so the checkout this command runs in cannot be known. Use a literal path in the cd (cd <full path> && ...).`;
const absoluteText = (t: string): boolean => isAbsolute(t) || /^[A-Za-z]:/.test(t);

/** `base` moved by one cd target (raw, quotes still on): absolute as given, else under `base`. An unexpanded target, or a relative one after it, gives an unexpanded folder. */
function moveTo(base: string, target: string, shell: 'bash' | 'pwsh'): string {
  // Every quote mark goes (P/"x" is P/x); a backslash before a space or a quote is an escape (bash), so the mark itself stays.
  // PowerShell has no backslash escape: a quoted part is taken whole, and a quote inside the other kind is a letter of the name.
  const raw = shell === 'pwsh'
    ? target.replace(/"([^"]*)"|'([^']*)'/g, (_m, d: string | undefined, s: string | undefined) => d ?? s ?? '').trimEnd()
    : target.replace(/\\([ "'])|["']/g, (_m, esc: string | undefined) => esc ?? '');
  if (hasUnexpandedPart(target)) return UNEXPANDED + raw;
  const t = shell === 'bash' ? gitBashPath(raw) : raw;
  if (absoluteText(t)) return t;
  return isUnexpanded(base) ? base : resolve(base, t);
}

/**
 * Where the text that ENDS at a push runs: the cds in it, whether the folder is unknown, whether the cwd must be judged too. A cd is found
 * in the masked view, so a quoted `; cd x` is not one; the target is read from the raw text at the same offsets (both views have the same
 * length). Callers pass the text up to the start of a push: only what runs before it. The same reading as a create or a merge (whereAt).
 */
const cdsBefore = (masked: string, raw: string): Where => whereAt(cdPositions(masked, raw), masked.length);

/**
 * True when the text between a cd and the shape it runs before (masked, so a quoted break is blank) is NOT joined only by `&&`: a `;`, `||`, `|`, `&`
 * or line end lets the shape run after that cd failed (`cd B extra`, a missing folder), and the shell then stays where it was. Same rule as
 * pre-pr-gate cdSteps. It reads separator characters only; it finds no command.
 */
function looseJoin(between: string): boolean {
  // The & of a file-descriptor redirect (2>&1, >&2, &>file) is no joiner: blank it first (as pre-pr-gate cdSteps).
  const joiners = between.replace(FD_REDIRECT, ' ').match(/&&|\|\||[;&|\r\n]/g) ?? [];
  return !(joiners.length > 0 && joiners.every((j) => j === '&&'));
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

// popd, Pop-Location, `cd -`, a bare cd (also with only options: cd -P, cd --) go to a folder the text does not name. Found in the masked view, at a command position.
const UNKNOWN_CD_SOURCE = CMD_POS + String.raw`(?:(?:${spell('popd')}|Pop-Location)(?=\s|[;&|\r\n]|$)|(?:${CD_NAMES})(?:[ \t]+(?:-[PLe@]+|--|[-+]))*[ \t]*(?=[;&|\r\n]|$))`;
/** A cd target that is no folder: `cd -`, or an option with nothing after it (`cd -P`, `cd --`). The shell goes to a place the text does not name. */
const NO_FOLDER = /^(?:[-+]|-[PLe@]+|--)$/i;

// Invoke-Command names its target AFTER the block: `{ cd B } -ComputerName srv` (or -cn, -Comp, -CU, -VMGuid) runs the cd elsewhere. Aliases and prefixes cannot be
// listed safely, so ANY parameter after the closing brace in the same statement counts. A local-only parameter, or a later unrelated block, over-denies (fail closed).
const REMOTE_AFTER_BLOCK = /^[^;\r\n]*?\}[^;&|\r\n{]*?\s(?:-[A-Za-z]|@\w)/;

/** Every cd of a masked view with the offset where it ends, and where each popd-like command ends. Read once per view: a segment takes the ones before it. */
interface CdPositions { cds: { end: number; target: string; piped: boolean }[]; unknown: number[]; masked: string }
function cdPositions(masked: string, raw: string): CdPositions {
  const cds: CdPositions['cds'] = [];
  const unknown = [...masked.matchAll(new RegExp(UNKNOWN_CD_SOURCE, 'gi'))].map((m) => m.index! + m[0].length);
  for (const m of masked.matchAll(new RegExp(CD_SOURCE, 'gi'))) {
    const end = m.index! + m[0].length;
    const target = raw.slice(end - m.groups!.t.length, end);
    if (NO_FOLDER.test(target)) { unknown.push(end); continue; }
    // The match opens on the separator before the cd. A | there (|| or a pipe), a pipe before a comment line (endsInPipe), a `(` (a subshell)
    // or a backtick means the cd may be skipped or may not last: it is loose. So is a cd at a soft position (CMD_POS) and a cd inside a job block.
    // insideSubshell: a separator inside an open `(`, `$(` or backtick (`(true && cd B) && push`) does not make the match start with the `(`. JOB_BLOCK runs on the text
    // with its closed `{ }` groups removed, so a closed brace in the job (`if (1) {}`, `@{}`) does not hide the block.
    const before = masked.slice(0, m.index!);
    const piped = m.groups!.soft !== undefined || /^\||[(`]/.test(m.groups!.hard ?? '') || endsInPipe(before) || insideSubshell(before)
      || JOB_BLOCK.test(withoutClosed(before, CLOSED_BRACES)) || REMOTE_AFTER_BLOCK.test(masked.slice(end));
    cds.push({ end, target, piped });
  }
  return { cds, unknown, masked };
}

/** Where a segment that starts at `from` runs: only a cd that ends before the segment counts, never one in or after it. */
function whereAt(pos: CdPositions, from: number): Where {
  const before = pos.cds.filter((c) => c.end <= from);
  return {
    cds: before.map((c) => c.target),
    unknown: pos.unknown.some((end) => end <= from),
    loose: before.some((c) => c.piped || looseJoin(pos.masked.slice(c.end, from))),
  };
}

/** The folder a push runs in: the payload cwd moved by each cd before the push, in order (the last absolute one wins). */
function pushDir(cwd: string, cds: string[], shell: 'bash' | 'pwsh'): string {
  return cds.reduce((dir, target) => moveTo(dir, target, shell), cwd);
}

/** True when a remote of the checkout is the CCv3 fork. Throws when git cannot list the remotes (the caller denies a gated shape). */
function isCcv3Checkout(deps: Deps, dir: string): boolean {
  const r = deps.git(dir, ['remote', '-v']);
  if (r.status !== 0) throw new Error(`git remote -v failed in ${dir} (exit ${r.status})`);
  return r.stdout.split(/\r?\n/).some((line) => {
    const url = line.split(/\s+/)[1] ?? '';
    const m = /github\.com[:/]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
    return m !== null && m[1].toLowerCase() === CCV3_REPO;
  });
}

const HEAD_FIELD_RE = /(?:^|\s)(?:-[fF]|--(?:raw-)?field)\s*["']?head=["']?([^\s"']+)/g;
const HEAD_FLAG_RE = /(?:^|\s)(?:--head(?:\s+|=)|-H\s*)["']?([^\s"']+)/g;
const PR_CREATE_CMD_RE = /\bgh\s+pr\s+create\b/i;

/** The value of the first flag that is not inside a quoted string: its first character is the same in the masked view (a quoted one is blanked). */
function unquotedFlagValue(re: RegExp, text: string, mtext: string): string | null {
  for (const m of text.matchAll(re)) {
    const at = m.index! + m[0].search(/\S/);
    if (mtext[at] === text[at]) return m[1];
  }
  return null;
}

/**
 * The head branch a PR-create command names (`-F head=`, `--head`, `-H`), without an `owner:` prefix; else the checked-out branch.
 * `text` is the create's own command (shapesOf cuts it at the next break outside quotes), so a later command's -H or a quoted `--head` in a
 * title is not read. `mtext` is the same text with its quoted strings blanked.
 */
function headBranch(text: string, mtext: string, deps: Deps, dir: string): string {
  const named = unquotedFlagValue(HEAD_FIELD_RE, text, mtext)
    ?? (PR_CREATE_CMD_RE.test(text) || PR_CREATE_CMD_RE.test(squashQuotes(text)) ? unquotedFlagValue(HEAD_FLAG_RE, text, mtext) : null);
  if (named) return named.replace(/^[^:\s]+:/, '').replace(/["']+$/, '');
  const r = deps.git(dir, ['branch', '--show-current']);
  if (r.status !== 0) throw new Error('git branch --show-current failed');
  return r.stdout.trim();
}

// ---------- a plain commit before the push, in the same command ----------

const COMMIT_GIT = gitCallRe('commit');
const COMMIT_SAFE = safeCallRe('commit', PUSH_WRAPPERS, '', 'gi');
const READ_VERB = '(?:status|diff|log|show|rev-parse)';
const READ_GIT = gitCallRe(READ_VERB);
const READ_SAFE = safeCallRe(READ_VERB, PUSH_WRAPPERS, '', 'gi');
/** The only commit arguments a chained commit may have: a message by file or text, and quiet. Nothing that stages, amends or names a path. */
const COMMIT_MSG = String.raw`(?:-[Fm]\s+${VAL}|--(?:file|message)(?:=|\s+)${VAL})`;
const COMMIT_ARGS_RE = new RegExp(String.raw`^(?:\s+(?:-q|--quiet))*\s+${COMMIT_MSG}(?:\s+(?:-q|--quiet|${COMMIT_MSG}))*\s*$`);
const CD_SEG_RE = /^\s*(?:cd|Set-Location|sl|chdir|pushd|Push-Location)\s+\S/i;
type SegKind = 'cd' | 'commit' | 'push' | 'read' | 'other';

/** The call that opens a segment (no env prefix, no `then`, no wrapper word). Null when the segment opens with something else. */
function openCall(ms: string, rs: string, git: RegExp, safe: RegExp): { opts: string; end: number } | null {
  const kinds: [RegExp, (token: string) => boolean][] = [[git, isGitToken], [safe, (t) => isSafeToken(t, PUSH_WRAPPERS)]];
  for (const [re, valid] of kinds) {
    for (const m of ms.matchAll(re)) {
      if (m[1].trim() !== '') continue;
      const tokenStart = m.index! + m[1].length;
      if (!valid(rs.slice(tokenStart, tokenStart + m[2].length))) continue;
      const optsStart = tokenStart + m[2].length;
      return { opts: rs.slice(optsStart, optsStart + m[3].length), end: m.index! + m[0].length };
    }
  }
  return null;
}

/** What one command segment is. Anything that is not plainly one of the kinds is 'other'. `ms` is the masked view, `rs` the raw text. */
function segmentKind(ms: string, rs: string): SegKind {
  // A group, a redirect or an expansion can hide a second command. $ and a backtick are checked in the raw text, because a quoted $( ) still runs.
  if (/[(){}<>]/.test(ms) || /[$`]/.test(rs)) return 'other';
  if (CD_SEG_RE.test(ms)) return 'cd';
  const commit = openCall(ms, rs, COMMIT_GIT, COMMIT_SAFE);
  if (commit) return commit.opts.trim() === '' && COMMIT_ARGS_RE.test(rs.slice(commit.end)) ? 'commit' : 'other';
  if (openCall(ms, rs, PUSH_GIT, PUSH_SAFE)) return 'push';
  const read = openCall(ms, rs, READ_GIT, READ_SAFE);
  return read && read.opts.trim() === '' ? 'read' : 'other';
}

/**
 * True when the command commits what is staged and only then pushes, so the tree the push sends is the INDEX tree read now, not HEAD's
 * (HEAD is still the parent while the hook runs). Every segment must be plain: one cd at most, before the first commit; plain commits
 * (segmentKind); pushes; read-only git. Every commit comes before every push, and only && joins the commit to the push (a failed commit
 * must stop it; `;`, a newline or `||` would still push HEAD). A `|`, a lone `&` (background) or any other segment
 * (git add, a checkout, a script, a commit with --amend or -a) gives false, and the push keeps the HEAD tree rule.
 */
function commitPrecedesPush(raw: string, shell: 'bash' | 'pwsh'): boolean {
  const segs = segmentsOf(raw, shell);
  if (segs === null) return false;
  const { seq, before } = segs;
  const firstCommit = seq.indexOf('commit');
  const lastPush = seq.lastIndexOf('push');
  const firstPush = seq.indexOf('push');
  if (seq.includes('other') || firstCommit < 0 || firstPush < 0 || seq.lastIndexOf('commit') > firstPush) return false;
  // A failed commit must stop the push: `;`, a newline or `||` would still run it and send HEAD's tree. Only && joins the commit to the push.
  if (before.slice(firstCommit + 1, lastPush + 1).some((op) => op !== '&&')) return false;
  const cds = seq.flatMap((k, i) => (k === 'cd' ? [i] : []));
  return cds.length === 0 || (cds.length === 1 && cds[0] < firstCommit);
}

/**
 * True when every segment of the command is a cd, a read-only git call or a push, with at least one push. Only then does "Push only" apply:
 * nothing in the command can stage, commit or move HEAD before the push, so the tree pushed is the HEAD tree the tap bound. A redirect, a
 * trailing command, an add, a commit, a merge or any 'other' segment gives false, and the Push only tap does not count (fail closed).
 */
function pushesAlone(raw: string, shell: 'bash' | 'pwsh'): boolean {
  const segs = segmentsOf(raw, shell);
  return segs !== null && segs.seq.includes('push') && segs.seq.every((k) => k === 'cd' || k === 'push' || k === 'read');
}

/** The kinds of the command's segments and the operators before each, or null when a pipe or a lone & (background) is present. */
function segmentsOf(raw: string, shell: 'bash' | 'pwsh'): { seq: SegKind[]; before: string[] } | null {
  const view = joinContinuations(raw, shell);
  const masked = maskQuoted(view, shell === 'pwsh' ? 'PowerShell' : 'Bash');
  if (masked.includes('|') || /(?<!&)&(?!&)/.test(masked)) return null;
  const seq: SegKind[] = [];
  const before: string[] = []; // before[i]: the operators and blanks between segment i-1 and segment i
  let from = 0;
  let pending = '';
  const breaks = [...masked.matchAll(/[;&\r\n]+/g)].map((m) => [m.index!, m.index! + m[0].length] as const);
  for (const [start, next] of [...breaks, [view.length, view.length] as const]) {
    const ms = masked.slice(from, start);
    if (ms.trim() !== '') { seq.push(segmentKind(ms, view.slice(from, start))); before.push(pending.trim()); pending = ''; } else pending += ms;
    pending += masked.slice(start, next);
    from = next;
  }
  return { seq, before };
}

// ---------- the judgment ----------

const shellOf = (input: HookInput): 'bash' | 'pwsh' => ((input.tool_name || input.tool) === 'PowerShell' ? 'pwsh' : 'bash');
const ALLOW: Decision = { action: 'allow' };

/** Create: the open-pr decision for (branch, head of the branch). A create from main, or outside CCv3, is not gated. */
function judgeCreate(text: string, mtext: string, deps: Deps, dir: string, named: string | null): Decision {
  if (named !== CCV3_REPO && !isCcv3Checkout(deps, dir)) return ALLOW;
  const branch = headBranch(text, mtext, deps, dir);
  // An empty head (detached HEAD, or no head the text names) cannot be tied to a tap: deny, never allow.
  if (branch === '') return deny('head-unresolved', `the head branch of this create cannot be named in ${dir} (detached HEAD?), so its open-pr decision cannot be found. Name the head (gh pr create --head <branch>) or run the command from the repo on a branch.`);
  if (branch === 'main') return ALLOW;
  const r = deps.git(dir, ['rev-parse', `${branch}^{commit}`]);
  if (r.status !== 0) return deny('head-unresolved', `cannot read the head of ${branch} in ${dir}, so its open-pr decision cannot be found. Run the command again from the repo.`);
  const head = r.stdout.trim();
  const d = decisionRead({ step: 'open-pr', key: decisionKey({ branch }), head });
  return d && isOpenPrLabel(d.label) ? ALLOW : deny('open-pr', openPrWhy(branch, head));
}

/** Land or merge: a land decision for the PR whose label allows it (and whose head is the sha= of its own segment, when the segment has one). */
function judgeLand(shape: Shape, deps: Deps, dir: string, named: string | null): Decision {
  // land-pr.ps1 is CCv3 only. A merge command is gated in a CCv3 checkout or when it names CCv3.
  if (shape.kind === 'merge' && named !== CCV3_REPO && !isCcv3Checkout(deps, dir)) return ALLOW;
  if (shape.pr === null) return deny('no-pr', NO_PR_WHY);
  const sha = shape.sha ?? undefined;
  // A raw merge with no sha= has no head to compare, so an old tap (a head that has since moved) could land a new head. land-pr.ps1 pins the head itself.
  if (shape.kind === 'merge' && !sha) return deny('merge-no-head', `${shape.pr ? `PR #${shape.pr}` : 'this PR'}: a raw merge command names no head, so Dave's tap cannot be tied to the head that would land. Run land-pr.ps1 -Pr ${shape.pr ?? '<n>'} (it pins the head), or pass the tapped head: gh api .../merge -f sha=<head>, gh pr merge --match-head-commit <head>. The Land question must be tapped first (ship-ask.mjs land --pr ${shape.pr ?? '<n>'}).`);
  const key = decisionKey({ pr: shape.pr });
  const ok = decisionRows(deps.env).some((r) => r.step === 'land' && r.key === key && isLandLabel(r.label) && (!sha || r.head.toLowerCase() === sha));
  return ok ? ALLOW : deny('land', landWhy(shape.pr));
}

/** `-C <path>` of a push: absolute as given, else under the directory the command acts in. */
function resolveDir(base: string, raw: string, shell: 'bash' | 'pwsh'): string {
  if (hasUnexpandedPart(raw)) return UNEXPANDED + raw;
  const t = shell === 'bash' ? gitBashPath(raw) : raw;
  if (absoluteText(t)) return t;
  return isUnexpanded(base) ? base : resolve(base, t);
}

/**
 * Every folder a shape may run in. A cd in the text may never run (|| short-circuit, a failed cd, a comment) or may not last (a subshell,
 * a pipe, the background), so the shape is judged in the folder after each prefix of its cds. With no cd it is the payload cwd.
 * `dir` is a -C (or -Path) of the shape itself: it then moves each of them. Used by push, create, land and merge.
 * `loose`: a cd before the shape is joined to it by something other than && (looseJoin), so it can fail and the shape runs in the payload
 * cwd (or the folder of an earlier cd, which the prefixes already hold). The cwd is judged too, as planRun in pre-pr-gate does.
 */
function dirsAfter(cwd: string, cds: string[], shell: 'bash' | 'pwsh', loose: boolean, dir: string | null = null): string[] {
  const dirs = cds.length === 0 ? [cwd] : [...(loose ? [cwd] : []), ...cds.map((_, i) => pushDir(cwd, cds.slice(0, i + 1), shell))];
  return [...new Set(dirs.map((d) => (dir === null ? d : resolveDir(d, dir, shell))))];
}
const pushDirsOf = (p: PushShape, cwd: string, shell: 'bash' | 'pwsh'): string[] => dirsAfter(cwd, p.cds, shell, p.loose, p.dir);

const POSITION_WHY = 'popd, Pop-Location, cd - or a bare cd moves the folder to a place this text does not name, so the checkout this command runs in cannot be known. Run the command with one absolute cd (cd <full path> && ...) and no popd.';

/** Every deny of one create, land or merge: judged in each folder on its cd path. A position that is unknown is denied when CCv3 may be the place. */
function judgeAt(s: Shape, deps: Deps, cwd: string, shell: 'bash' | 'pwsh', named: string | null): Decision[] {
  const at = s.at!;
  const dirs = dirsAfter(cwd, at.cds, shell, at.loose);
  // An unexpanded cd target names a folder this hook cannot know: denied in any checkout (as pre-pr-gate: cannot expand). The land script reads no folder.
  const lost = dirs.find(isUnexpanded);
  if (lost !== undefined && s.kind !== 'land') return [deny('cd-unexpanded', unexpandedWhy(lost))];
  // judgeLand reads no folder for the land script, so a popd never blocks it: its PR tap alone decides.
  if (at.unknown && s.kind !== 'land') {
    const ccv3 = named === CCV3_REPO || [...new Set([cwd, ...dirs])].some((d) => isCcv3Checkout(deps, d));
    return ccv3 ? [deny('position-unknown', POSITION_WHY)] : [];
  }
  return dirs.map((d) => (s.kind === 'create' ? judgeCreate(s.text!, s.mtext!, deps, d, named) : judgeLand(s, deps, d, named)));
}

/**
 * Every deny of one push: judged in each folder on its cd path (pushDirsOf). When a popd, Pop-Location, `cd -` or a bare cd comes before it the
 * folder is unknown (as in judgeAt): it is denied, tap or not, if the cwd or a folder on the known cd path is a CCv3 checkout. A -C that is
 * absolute names the folder itself, so the position does not matter and the push is judged there.
 */
function judgePushAt(s: Shape, deps: Deps, cwd: string, shell: 'bash' | 'pwsh', subagent: boolean, chained: boolean, alone: boolean): Decision[] {
  const p = s.push!;
  const dirs = pushDirsOf(p, cwd, shell);
  const lost = dirs.find(isUnexpanded);
  if (lost !== undefined) return [deny('cd-unexpanded', unexpandedWhy(lost), 'push')];
  const fixedByDir = p.dir !== null && resolveDir('/a', p.dir, shell) === resolveDir('/b', p.dir, shell);
  if (p.unknown && !fixedByDir) {
    const ccv3 = [...new Set([cwd, ...dirs])].some((d) => isCcv3Checkout(deps, d));
    // No CCv3 folder on the path: judge the known folders anyway, so a --git-dir or --work-tree push (p.moved) still denies.
    if (ccv3) return [deny('position-unknown', POSITION_WHY, 'push')];
  }
  return dirs.map((d) => judgePush(s, deps, d, subagent, chained, alone));
}

/** A remote name or URL: the upstream (origin, parcadei), the fork (fork, the CCv3 repo URL) or neither. */
function remoteKind(remote: string): 'origin' | 'fork' | null {
  const r = remote.toLowerCase();
  if (r === 'origin' || r.includes('parcadei')) return 'origin';
  return r === 'fork' || r.includes(CCV3_REPO) ? 'fork' : null;
}

/**
 * Push: a ship decision ("Commit and push", or "Push only" when no commit is chained) for the branch, bound to the tree being pushed.
 * The head is not compared: the tap was made before the commit, so its head is the parent of the commit now at HEAD. The tree is the
 * same before and after the commit. "Push only" is bound to HEAD's tree. It counts only when `alone` is true (pushesAlone: the command holds
 * nothing but cd, read-only git and pushes), so a command that can stage or commit before the push never takes it, whatever shape it has.
 * `chained`: the same command commits the staged tree first (commitPrecedesPush), so the tree pushed is `git write-tree`, not HEAD's.
 * Order: unreadable target, not CCv3, origin, other remote, subagent, force or delete form, branch, main, tree, tap.
 * A force form is denied before the main check: a force push to the fork's main rewrites the branch every PR lands on.
 */
function judgePush(shape: Shape, deps: Deps, dir: string, subagent: boolean, chained: boolean, alone: boolean): Decision {
  const p = shape.push!;
  const d = (pattern: string, why: string): Deny => deny(pattern, why, 'push');
  if (p.moved) return d('push-target-unresolved', pushUnresolvedWhy('--git-dir or --work-tree moves the repo, so the checkout is unknown'));
  if (!isCcv3Checkout(deps, dir)) return ALLOW;
  let remote = p.remote;
  if (remote === null) {
    const up = deps.git(dir, ['rev-parse', '--abbrev-ref', '@{push}']);
    remote = up.status === 0 && up.stdout.trim() !== '' ? up.stdout.trim().split('/')[0] : 'fork';
  }
  let kind = remoteKind(remote);
  if (kind === null) { // another name for a URL we gate: ask git what the remote points at
    const u = deps.git(dir, ['remote', 'get-url', remote]);
    if (u.status === 0) kind = remoteKind(u.stdout.trim());
  }
  if (kind === 'origin') return d('push-origin', PUSH_ORIGIN_WHY);
  if (kind === null) return ALLOW;
  // A subagent never has a tap (D3): any push to the fork is denied, main included. Its pushes elsewhere are not our business.
  if (subagent) return d('subagent', SUBAGENT_WHY);
  if (p.force) return d('push-unsafe', PUSH_UNSAFE_WHY);
  let branch = p.branch;
  if (branch === null) {
    const r = deps.git(dir, ['branch', '--show-current']);
    if (r.status !== 0) throw new Error('git branch --show-current failed');
    branch = r.stdout.trim();
  }
  if (branch === '') return d('push-target-unresolved', pushUnresolvedWhy('the branch of this push cannot be named (detached HEAD?)'));
  if (branch === 'main') return ALLOW;
  const ref = p.src ?? 'HEAD';
  if (ref.startsWith('-')) return d('push-target-unresolved', pushUnresolvedWhy(`${ref} is not a ref`));
  // A plain commit earlier in the same command moves HEAD to the staged tree before this push runs: read the index. The commit lands on the
  // checked-out branch in this directory, so the push must send HEAD or that branch, with no -C of its own. Anything else keeps the HEAD rule.
  const viaIndex = chained && p.dir === null && (p.src === null || deps.git(dir, ['branch', '--show-current']).stdout.trim() === p.src);
  const r = viaIndex ? deps.git(dir, ['write-tree']) : deps.git(dir, ['rev-parse', `${ref}^{tree}`]);
  if (r.status !== 0) return d('push-tree-unresolved', `cannot read the tree of ${viaIndex ? 'the index (git write-tree)' : ref} in ${dir}, so its ship decision cannot be found. Run the command again from the repo.`);
  const tree = r.stdout.trim();
  const key = decisionKey({ branch });
  const ok = decisionRows(deps.env).some((row) => row.step === 'ship' && row.key === key && (isShipLabel(row.label) || (!viaIndex && alone && isPushOnlyLabel(row.label))) && row.tree !== null && row.tree === tree);
  return ok ? ALLOW : d('ship', pushWhy(branch));
}

// The environment can point git at another repo than the folder: GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR. The flag forms (--git-dir, --work-tree) are p.moved. The name is
// read in the quote-masked text (a quoted mention such as echo "the GIT_DIR variable" is text) and as `NAME=` in the raw text (env "GIT_DIR=x" is a real assignment).
// A cd alias (alias go=cd, Set-Alias go Set-Location, sal, nal, New-Alias) runs a cd the text does not show: the definition is read in the text with its quotes deleted.
// Neither names a folder, so the shape is denied in any checkout (fail closed). An unquoted read of the name (echo $GIT_DIR) over-denies: pinned by tests.
const MOVE_ENV_MASKED = /(?:^|\W)GIT_(?:DIR|WORK_TREE|COMMON_DIR)(?!\w)/i;
// The raw text adds one thing the mask hides: a QUOTED assignment given to env or export, or at a command position (env "GIT_DIR=x" git push). A quoted GIT_DIR= in an argument is text.
const MOVE_ENV_RAW = /(?:^|[;&|\r\n(]\s*)(?:(?:env|export)\s+(?:-\S+\s+|\S+=\S*\s+)*)?["']GIT_(?:DIR|WORK_TREE|COMMON_DIR)=/i;
const CD_ALIAS = /(?:^|[;&|(\r\n]\s*)(?:alias|(?:Set|New)-Alias|sal|nal)\s[^;&|\r\n]*?(?<![\w-])(?:cd|chdir|pushd|popd|Set-Location|sl|Push-Location|Pop-Location)(?![\w-])/i;
const MOVED_WHY = 'GIT_DIR, GIT_WORK_TREE or an alias for cd moves git or the shell to a folder this text does not name, so the checkout this command runs in cannot be known. Run the command in the repo with no GIT_DIR and no cd alias.';
function movesRepo(text: string): boolean {
  return MOVE_ENV_RAW.test(text) || (['Bash', 'PowerShell'] as const).some((tool) => MOVE_ENV_MASKED.test(maskQuoted(text, tool))) || CD_ALIAS.test(squashQuotes(text));
}

/** Every deny of a command. All shapes are judged (no early return), so each deny keeps its scope and decide() applies the flag of that scope. */
function judgeCommand(input: HookInput, deps: Deps): Deny[] {
  const cmd = readShellCommand(input);
  if (cmd.kind !== 'command' || cmd.text === '') return [];
  const cwd = input.cwd || process.cwd();
  if (writesStoreText(cmd.text, deps)) return [deny('store-write', STORE_WHY)];
  const shapes = shapesOf(cmd.text, cmd.tool);
  const denies: Deny[] = [];
  // A subagent never has a tap: any create, land or merge is denied at once. A push is judged (the checkout and the remote decide), see judgePush.
  if (input.agent_id && shapes.some((s) => s.kind !== 'push')) denies.push(deny('subagent', SUBAGENT_WHY));
  const pushes = shapes.filter((s) => s.kind === 'push');
  const rest = input.agent_id ? [] : shapes.filter((s) => s.kind !== 'push');
  if (pushes.length === 0 && rest.length === 0) return denies;
  const shell = shellOf(input);
  const named = namedRepo(cmd.text, deps.env);
  const chained = pushes.length > 0 && commitPrecedesPush(cmd.text, shell);
  const alone = pushes.length > 0 && pushesAlone(cmd.text, shell);
  const moved = movesRepo(cmd.text);
  for (const s of [...rest, ...pushes]) {
    // The land script reads no folder, so GIT_DIR and an alias never block it.
    if (moved && s.kind !== 'land') {
      denies.push(s.kind === 'push' ? deny('push-target-unresolved', pushUnresolvedWhy(MOVED_WHY), 'push') : deny('repo-moved', MOVED_WHY));
      continue;
    }
    const found = s.kind === 'push' ? judgePushAt(s, deps, cwd, shell, Boolean(input.agent_id), chained, alone) : judgeAt(s, deps, cwd, shell, named);
    for (const d of found) {
      if (d.action === 'deny' && !denies.some((o) => o.pattern === d.pattern && o.reason === d.reason && o.scope === d.scope)) denies.push(d);
    }
  }
  return denies;
}

function judgeWrite(input: HookInput, deps: Deps): Deny[] {
  const args = input.tool_input ?? {};
  const cwd = input.cwd || process.cwd();
  const hit = PATH_FIELDS.some((f) => typeof args[f] === 'string' && isStorePath(args[f] as string, deps, cwd));
  return hit ? [deny('store-write', STORE_WHY)] : [];
}

/** The raw judgment, as if enforcing: every deny, each with its scope. May throw (git). */
function judge(input: HookInput, deps: Deps): Deny[] {
  const tool = input.tool_name || input.tool || '';
  if (WRITE_TOOLS.has(tool)) return judgeWrite(input, deps);
  return COMMAND_TOOLS.has(tool) ? judgeCommand(input, deps) : [];
}

/**
 * Pure given its deps. A deny whose flag is on (decisions.enforce for most shapes, decisions.enforcePush for a push) is returned as a deny.
 * Other denies become an allow with `warn`.
 */
export function decide(input: HookInput, deps: Deps): Decision {
  const denies = judge(input, deps);
  if (denies.length === 0) return ALLOW;
  const cwd = input.cwd || process.cwd();
  const live = denies.find((d) => enforcingScope(d.scope, deps, cwd));
  if (live) return live;
  return { action: 'allow', warn: `${denies[0].pattern}: ${denies[0].reason}`, scope: denies[0].scope };
}

// ---------- hook plumbing ----------

const out = (extra: Record<string, unknown>): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...extra } });
const denyOut = (reason: string): string => out({ permissionDecision: 'deny', permissionDecisionReason: reason });
const warnOut = (text: string, scope: Scope = 'other'): string => out({ additionalContext: `WARNING (decision-gate, warn mode): this command would be blocked when ${FLAG_OF[scope]} is true. ${text.replace(/^BLOCKED \(decision-gate\): /, '')}` });

/** The scopes of the gated shapes of the tool call, empty when it is not gated. Cheap, no git: it decides what an internal error does. */
function gatedScopes(input: HookInput): Set<Scope> {
  const tool = input.tool_name || input.tool || '';
  if (WRITE_TOOLS.has(tool)) return new Set<Scope>(['other']);
  const cmd = readShellCommand(input);
  return new Set(cmd.kind === 'command' ? shapesOf(cmd.text, cmd.tool).map(scopeOf) : []);
}

/**
 * One line on stderr when the input cannot be read. The text never holds the input or the parse error (a V8 parse error quotes the input).
 * The log row is a fixed text for the same reason.
 */
function unreadableInput(): string {
  const note = 'decision-gate: the hook input is not readable JSON, so no command shape can be judged; the call is allowed.';
  try { logGuardError(HOOK, new Error('unreadable hook input')); } catch { /* the log never blocks */ }
  try { process.stderr.write(`${note}\n`); } catch { /* stderr is only a note */ }
  return '{}';
}

/**
 * The whole hook: raw stdin text in, stdout text out. Never throws.
 * Unreadable input (not JSON, or JSON that is not an object) is ALLOWED, with a note on stderr. This is the documented posture, not a gap:
 * the gate fails closed only for a gated shape, and it cannot see a shape in input it cannot read. Denying here would block all work.
 */
export function handle(raw: string, deps: Deps): string {
  let input: HookInput = {};
  try {
    const parsed: unknown = JSON.parse(raw.trim() || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return unreadableInput();
    input = parsed as HookInput;
  } catch {
    return unreadableInput();
  }
  try {
    const d = decide(input, deps);
    if (d.action === 'allow' && d.warn) {
      logGuardDecision(HOOK, input, 'warn', d.warn.split(':')[0]);
      return warnOut(d.warn.slice(d.warn.indexOf(':') + 2), d.scope);
    }
    if (d.action === 'deny') {
      logGuardDecision(HOOK, input, 'deny', d.pattern);
      return denyOut(d.reason);
    }
    return '{}';
  } catch (err) {
    return unjudgeable(input, deps, err);
  }
}

/**
 * A gated call that could not be judged because git failed or threw: fail closed where a flag is on, warn where it is off.
 * A missing cwd (MissingCwdError) is a condition of the call, not a crash of the hook: it is logged as a deny or warn row
 * (reason cwd-missing), so it does not show as an error row in the harness doctor. Any other throw stays an error row.
 */
function unjudgeable(input: HookInput, deps: Deps, err: unknown): string {
  const gone = err instanceof MissingCwdError;
  if (!gone) { try { logGuardError(HOOK, err); } catch { /* the log never blocks */ } }
  const scopes = gatedScopesSafe(input);
  if (scopes.size === 0) return '{}';
  const detail = gone ? err.message : String((err as Error)?.message ?? err).slice(0, 160);
  const hint = gone ? 'Run the command from a folder that exists.' : 'Run the command again. If it keeps failing, ask Dave.';
  const why = `could not verify Dave's tap (${detail}). ${hint}`;
  const cwd = input.cwd || process.cwd();
  // Each gated scope is judged by its own flag. A mixed command denies when either flag is on.
  const live = [...scopes].some((s) => enforcingScope(s, deps, cwd));
  if (gone) logGuardDecision(HOOK, input, live ? 'deny' : 'warn', 'cwd-missing');
  return live ? denyOut(`BLOCKED (decision-gate): ${why}`) : warnOut(why, scopes.has('other') ? 'other' : 'push');
}

const gatedScopesSafe = (input: HookInput): Set<Scope> => { try { return gatedScopes(input); } catch { return new Set(); } };

/**
 * The cwd of a git call is gone (a removed worktree). Node reports that as "spawnSync git ENOENT", the text of a missing git binary,
 * so makeGit checks the folder first and throws this instead. The call stays unjudged (fail closed), with the folder named.
 */
export class MissingCwdError extends Error {
  constructor(readonly cwd: string) {
    super(`the working folder does not exist: ${cwd}`);
    this.name = 'MissingCwdError';
  }
}

export function makeGit(): Deps['git'] {
  return (cwd, args) => {
    if (!existsSync(cwd)) throw new MissingCwdError(cwd);
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout ?? '' };
  };
}

function realDeps(): Deps {
  return {
    git: makeGit(),
    readFile: (p) => { try { return existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { return null; } },
    env: process.env,
    home: homedir(),
  };
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  console.log(handle(Buffer.concat(chunks).toString('utf-8'), realDeps()));
}

// Auto-run only as a hook; VITEST imports the pure functions above.
if (!process.env.VITEST) {
  main().catch((err) => { logGuardError(HOOK, err); console.error('decision-gate: stdin could not be read; the call is allowed.'); console.log('{}'); });
}
