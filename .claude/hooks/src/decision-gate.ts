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
 * NOT gated: git push (the push gate is not in this PR), anything else.
 *
 * Mode. `decisions.enforce` is a TOP-LEVEL block of review-router.config.json (not `checkpoint`). Only a literal true denies.
 * Anything else, a missing file included, is WARN mode: the command runs and the hook adds a context line (and a log row).
 * This is the opposite of pre-pr-gate, which fails closed on a missing config: this gate ships OFF.
 * The config is read from the payload cwd upward (no git), then from <home>/continuous-claude.
 *
 * Posture when enforcing: a gated shape that cannot be judged (git fails, no PR number in the text) is denied. Everything else passes.
 * Unreadable input (not JSON) has no visible shape: it passes, with one line on stderr. Blocking it would block all work.
 * A subagent (agent_id) never has a tap: its create, land and merge are denied. -CleanupOnly never merges, so it passes.
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
import { isPrOpenCommand, joinContinuations, normalizeGh, squashQuotes } from './pr-opened-review-loop.js';
import { CCV3_REPO, namedRepo } from './shared/checkpoint-shapes.js';
import { decisionKey, decisionRead, decisionRows, decisionsPath } from './shared/decisions-store.js';
import { logGuardDecision, logGuardError } from './shared/guard-log.js';
import { routerFlag } from './shared/router-config.js';
import { readShellCommand } from './shared/shell-tools.js';

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
export type Decision = { action: 'allow'; warn?: string } | { action: 'deny'; reason: string; pattern: string };
interface HookInput { tool_name?: string; tool?: string; tool_input?: Record<string, unknown>; cwd?: string; agent_id?: string; session_id?: string }

/** The label of a decision that lets the action run. Any other label (Keep open, Stop here, Show ..., a re-run) does not. */
export const isOpenPrLabel = (label: string): boolean => /^Open draft PR\b/.test(label);
export const isLandLabel = (label: string): boolean => /^Land (?:now|when READY)\b/.test(label);

// ---------- the question to ask, per deny ----------

const deny = (pattern: string, why: string): Decision => ({ action: 'deny', pattern, reason: `BLOCKED (decision-gate): ${why}` });
const openPrWhy = (branch: string, head: string): string =>
  `no "open-pr" decision from Dave for ${branch} at ${head.slice(0, 7)}. Ask him first: run node scripts/github/ship-ask.mjs open-pr --branch ${branch} --json, pass its JSON to AskUserQuestion word for word, then open the PR only if he taps "Open draft PR".`;
const landWhy = (pr: string): string =>
  `no "land" decision from Dave for PR #${pr}. Ask him first: run node scripts/github/ship-ask.mjs land --pr ${pr} --json, pass its JSON to AskUserQuestion word for word. Only "Land now" or "Land when READY" lets a land run. If the PR already merged, run land-pr.ps1 -Pr ${pr} -CleanupOnly.`;
const STORE_WHY = 'only decision-ledger writes the decision store, from Dave\'s tap in AskUserQuestion. Do not write it by hand. To record a decision, ask the question with AskUserQuestion.';
const SUBAGENT_WHY = 'a subagent cannot open a PR, land or merge: Dave\'s tap belongs to the main session. Ask the main session to do it.';
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
  'write|append|copy|rename|unlink|\\brm|truncate|open|link|mkdir|chmod|chown|utimes|stream|child_process|spawn|exec|eval|\\bFunction\\b|import\\s*\\(',
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

interface Shape { kind: 'create' | 'land' | 'merge' | 'store'; pr: string | null; sha?: string | null }

const LAND_SCRIPT_RE = /\bland-pr\.ps1\b/i;
const LAND_PR_RE = /(?:^|\s)-P(?:r)?(?:\s+|:|=)["']?(\d+)\b/i;
const CLEANUP_RE = /(?:^|\s)-CleanupOnly\b/i;
const MERGE_CLI_RE = /\bgh\s+pr\s+merge\b([^|;&\n]*)/i;
const MERGE_API_RE = /\bgh\s+api\b[^|;&\n]*\/pulls\/(\d+)\/merge\b[^|;&\n]*/i;
const GET_RE = /(?:^|\s)(?:-X\s*|--method(?:\s+|=))GET\b/i;
const SHA_RE = /(?:\bsha=|--match-head-commit(?:\s+|=))["']?([0-9a-f]{40})\b/i;
const SEGMENT_RE = /[;&|\r\n]+/;

const lastArg = (args: string, re: RegExp): string | null => re.exec(args)?.[1] ?? null;

/** The land and merge shapes of ONE command segment (no && ; | or newline in it), with the PR and the sha read from that segment alone. */
function landShapesOf(seg: string): Shape[] {
  const out: Shape[] = [];
  const sha = SHA_RE.exec(seg)?.[1]?.toLowerCase() ?? null;
  if (LAND_SCRIPT_RE.test(seg) && !CLEANUP_RE.test(seg)) out.push({ kind: 'land', pr: lastArg(seg, LAND_PR_RE), sha });
  const cli = MERGE_CLI_RE.exec(seg);
  if (cli) out.push({ kind: 'merge', pr: lastArg(cli[1], /(?:^|\s)(?:["']?)(\d+)(?=\s|["']|$)/) ?? lastArg(cli[1], /\/pull\/(\d+)/), sha });
  const api = MERGE_API_RE.exec(seg);
  if (api && !GET_RE.test(api[0])) out.push({ kind: 'merge', pr: api[1], sha });
  return out;
}

/**
 * The shapes of one command text (continued lines joined, both shells read). EVERY land and merge shape is returned, one per segment:
 * the text is split on && ; | and newlines, and each segment is read alone, so a tap for the first PR does not cover the second.
 * The three readings (bash, pwsh, quotes squashed) are united and de-duplicated: an extra shape only makes the gate stricter.
 */
function shapesOf(raw: string): Shape[] {
  const text = normalizeGh(raw);
  const bash = joinContinuations(text, 'bash');
  const pwsh = joinContinuations(text, 'pwsh');
  const out: Shape[] = [];
  if (isPrOpenCommand(text)) out.push({ kind: 'create', pr: null });
  const seen = new Set<string>();
  for (const t of [bash, pwsh, squashQuotes(bash)]) {
    for (const seg of t.split(SEGMENT_RE)) {
      for (const shape of landShapesOf(seg)) {
        const id = `${shape.kind}|${shape.pr}|${shape.sha}`;
        if (!seen.has(id)) { seen.add(id); out.push(shape); }
      }
    }
  }
  return out;
}

// ---------- config ----------

/** decisions.enforce of the review-router.config.json found from `cwd` upward, else under <home>/continuous-claude. Only a literal true enforces. */
const enforcing = (deps: Deps, cwd: string): boolean => routerFlag(cwd, deps.readFile, deps.home, 'decisions', 'enforce');

// ---------- the checkout ----------

const CD_TARGET = /(?:^|[;&|\r\n]\s*)(?:cd|Set-Location|sl|pushd|Push-Location)\s+(?:-LiteralPath\s+|-Path\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/i;
const gitBashPath = (p: string): string => (process.platform === 'win32' ? p.replace(/^\/([A-Za-z])(?:\/|$)/, '$1:/') : p);

/** The directory the command acts in: the first cd target, else the payload cwd. */
function workDir(text: string, cwd: string, shell: 'bash' | 'pwsh'): string {
  const m = CD_TARGET.exec(text);
  if (!m) return cwd;
  const raw = m[1].replace(/^["']|["']$/g, '');
  const t = shell === 'bash' ? gitBashPath(raw) : raw;
  return isAbsolute(t) || /^[A-Za-z]:/.test(t) ? t : resolve(cwd, t);
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

/** The head branch a PR-create command names (`-F head=`, `--head`, `-H`), without an `owner:` prefix; else the checked-out branch. */
function headBranch(text: string, deps: Deps, dir: string): string {
  const named = /(?:^|\s)(?:-[fF]|--(?:raw-)?field)\s*["']?head=["']?([^\s"']+)/.exec(text)
    ?? (/\bgh\s+pr\s+create\b/i.test(text) ? /(?:^|\s)(?:--head(?:\s+|=)|-H\s*)["']?([^\s"']+)/.exec(text) : null);
  if (named) return named[1].replace(/^[^:\s]+:/, '').replace(/["']+$/, '');
  const r = deps.git(dir, ['branch', '--show-current']);
  if (r.status !== 0) throw new Error('git branch --show-current failed');
  return r.stdout.trim();
}

// ---------- the judgment ----------

const shellOf = (input: HookInput): 'bash' | 'pwsh' => ((input.tool_name || input.tool) === 'PowerShell' ? 'pwsh' : 'bash');
const ALLOW: Decision = { action: 'allow' };

/** Create: the open-pr decision for (branch, head of the branch). A create from main, or outside CCv3, is not gated. */
function judgeCreate(text: string, deps: Deps, dir: string, named: string | null): Decision {
  if (named !== CCV3_REPO && !isCcv3Checkout(deps, dir)) return ALLOW;
  const branch = headBranch(text, deps, dir);
  if (branch === '' || branch === 'main') return ALLOW;
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

function judgeCommand(input: HookInput, deps: Deps): Decision {
  const cmd = readShellCommand(input);
  if (cmd.kind !== 'command' || cmd.text === '') return ALLOW;
  const cwd = input.cwd || process.cwd();
  if (writesStoreText(cmd.text, deps)) return deny('store-write', STORE_WHY);
  const shapes = shapesOf(cmd.text);
  if (shapes.length === 0) return ALLOW;
  if (input.agent_id) return deny('subagent', SUBAGENT_WHY);
  const dir = workDir(cmd.text, cwd, shellOf(input));
  const named = namedRepo(cmd.text, deps.env);
  for (const s of shapes) {
    const d = s.kind === 'create' ? judgeCreate(cmd.text, deps, dir, named) : judgeLand(s, deps, dir, named);
    if (d.action === 'deny') return d;
  }
  return ALLOW;
}

function judgeWrite(input: HookInput, deps: Deps): Decision {
  const args = input.tool_input ?? {};
  const cwd = input.cwd || process.cwd();
  const hit = PATH_FIELDS.some((f) => typeof args[f] === 'string' && isStorePath(args[f] as string, deps, cwd));
  return hit ? deny('store-write', STORE_WHY) : ALLOW;
}

/** The raw judgment, as if enforcing. May throw (git). */
function judge(input: HookInput, deps: Deps): Decision {
  const tool = input.tool_name || input.tool || '';
  if (WRITE_TOOLS.has(tool)) return judgeWrite(input, deps);
  return COMMAND_TOOLS.has(tool) ? judgeCommand(input, deps) : ALLOW;
}

/** Pure given its deps. A deny becomes an allow with `warn` unless decisions.enforce is true. */
export function decide(input: HookInput, deps: Deps): Decision {
  const d = judge(input, deps);
  if (d.action !== 'deny' || enforcing(deps, input.cwd || process.cwd())) return d;
  return { action: 'allow', warn: `${d.pattern}: ${d.reason}` };
}

// ---------- hook plumbing ----------

const out = (extra: Record<string, unknown>): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...extra } });
const denyOut = (reason: string): string => out({ permissionDecision: 'deny', permissionDecisionReason: reason });
const warnOut = (text: string): string => out({ additionalContext: `WARNING (decision-gate, warn mode): this command would be blocked when decisions.enforce is true. ${text.replace(/^BLOCKED \(decision-gate\): /, '')}` });

/** True when the tool call reads like a gated shape. Cheap, no git: it decides what an internal error does. */
function looksGated(input: HookInput): boolean {
  const tool = input.tool_name || input.tool || '';
  if (WRITE_TOOLS.has(tool)) return true;
  const cmd = readShellCommand(input);
  return cmd.kind === 'command' && shapesOf(cmd.text).length > 0;
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
      return warnOut(d.warn.slice(d.warn.indexOf(':') + 2));
    }
    if (d.action === 'deny') {
      logGuardDecision(HOOK, input, 'deny', d.pattern);
      return denyOut(d.reason);
    }
    return '{}';
  } catch (err) {
    try { logGuardError(HOOK, err); } catch { /* the log never blocks */ }
    if (!looksGatedSafe(input)) return '{}';
    const why = `could not verify Dave's tap (${String((err as Error)?.message ?? err).slice(0, 160)}). Run the command again. If it keeps failing, ask Dave.`;
    return enforcing(deps, input.cwd || process.cwd()) ? denyOut(`BLOCKED (decision-gate): ${why}`) : warnOut(why);
  }
}

const looksGatedSafe = (input: HookInput): boolean => { try { return looksGated(input); } catch { return false; } };

function makeGit(): Deps['git'] {
  return (cwd, args) => {
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
