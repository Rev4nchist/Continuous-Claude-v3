#!/usr/bin/env node
/**
 * pre-pr.mjs: run every check BEFORE a CCv3 pull request opens (review budget, 2026-10-27).
 * Why: CodeRabbit allows 8 PR reviews per hour for the one Rev4nchist identity, and fewer as the 7-day
 * count rises. Each opening review and each `@coderabbitai review` costs one. Work that is not pushed costs
 * nothing, so the gates, the Evidence block and one CLI review run here first.
 * Facts and flow: .claudedocs/2026-10-27-coderabbit-review-budget.md.
 *
 * Usage: node scripts/github/pre-pr.mjs --body <evidence-draft.md> [--base main] [--skip-cr] [--cr-timeout-min N] [--json]
 * A review can take 10 to 30 minutes, and a foreground tool call may be cut off before that. Run this script in
 * the background (Bash run_in_background) and read its log when the exit notice arrives. It prints a progress line
 * to stderr each minute while `cr` runs, and streams the review to e2e/<date>-pre-pr-cr-<sha7>.running.txt.
 *   --body     the draft PR body (the Evidence block from pr-and-commit-style.md). Required.
 *   --base     the base branch. Default main. It is compared as a LOCAL ref, and as fork/<base> after a bounded
 *              (30 s) `git fetch fork <base>` that runs first. A failed fetch keeps the last-fetched fork ref, says so
 *              on the git:behind line, and never fails the run by itself.
 *              The body file is edited in one case: after a merge of the base the GREEN line names the old head. When the
 *              evidence has no other problem, that commit is an ancestor of HEAD, nothing but a clean merge of the base
 *              came after it (no own commit, no hand-resolved conflict) and every other step passed, the sha
 *              after "@" on the GREEN line becomes the HEAD short sha (line endings kept; RED never changes), a NOTE
 *              "GREEN updated <old> -> <new>" is printed, and the stamp holds the hash of the new file.
 *   --skip-cr  do not run the CodeRabbit CLI review. The stamp records cr_skipped and cr_skip_reason "flag",
 *              and the pre-pr-gate hook denies such a stamp. Use it to test this script, not to open a PR.
 *   --cr-timeout-min N  the hard time limit of the CodeRabbit review in minutes (default 30; env PRE_PR_CR_TIMEOUT_MIN).
 *              The floor is 15: a lower value is ignored with a warning and the limit stays 30.
 *   --json     print one JSON document, not lines.
 * Steps, one PASS / FAIL / SKIP / NOTE line each: git:branch, git:clean, git:behind, changes, evidence,
 * gate:<id> (the gates of every surface the diff touches, SURFACES below), coderabbit, git:stable (the last step: HEAD
 * and the tracked files are unchanged since the start; a failed git call is a FAIL). NOTE lines follow the
 * gates: a surface with no automatic gate, a changed file no surface owns, an opc source change with no test.
 * A NOTE zizmor line follows when the diff touches .github/workflows/*.yml: counts by severity and the top 3 file:line items from
 * `zizmor --offline --format json` (CCV3_ZIZMOR or ~/tools/review-scanners/zizmor/<ver>/bin/zizmor.exe; config .github/zizmor.yml).
 * It is advisory in a one-week trial and never fails the run; a missing binary is a skip note (scripts/github/lib/zizmor-advisory.mjs).
 * A step FAILs when:
 *   - the branch is main, the base or detached; the tree has an edited, staged or untracked file;
 *     HEAD is behind the local base or behind fork/<base> (fetched first; the last-fetched ref if the fetch fails);
 *     no file differs from the base;
 *   - the Evidence in the body has a problem READY would report, the body cannot be read, a docs type has a
 *     non-docs changed file, or the GREEN line does not name HEAD;
 *   - a gate exits non-zero, times out, cannot start, or (the hooks build) leaves dist changed or untracked;
 *   - the CLI review does not finish (non-zero exit, timeout, no complete event), reports outcome failed or unreviewed
 *     files, sends an error event, has a status or complete record of awaiting_confirmation or action_required
 *     (a finding that quotes those words does not count), its run counter file is unreadable, or another CodeRabbit
 *     step holds the run lock for this branch (a run is in progress). Findings read
 *     before a failure are kept in the output and the log.
 * The coderabbit step SKIPs, and the stamp records cr_skipped true and cr_skip_reason, when: "flag" (--skip-cr),
 * "cap" (the 2 runs of this branch are used; the stamp also holds cr_finished_runs, the runs that finished with a PASS
 * event), "cli-missing" (cr cannot start: ENOENT or EINVAL; no run is spent), "cli-error" (cr usage or cr failed in another
 * way: exit code, timeout, auth error, EACCES; no run is spent; a retry costs nothing), "rate-limited" (`cr usage --agent`
 * reports no included review left; no run is spent; the stamp also holds cr_retry_minutes), "no-changes" (the CLI saw an
 * empty --committed scope; the run is given back), "cli-cap" (today's paid CLI spend reached coderabbit.cli_daily_cap_usd in
 * review-router.config.json; no run is spent) or "earlier-step-failed". The hook accepts "cli-missing", "cli-cap", "cap" with
 * cr_finished_runs >= 1, and "rate-limited" with a retry time. It denies the rest, including "cli-error".
 * Spend log: CLI 0.9.0 bills usage credits past the free hourly allowance with no flag and no prompt. When the complete record
 * carries usageCost with costCents above 0, the step appends one {kind: "cli"} row to ~/.claude/state/coderabbit-paid.jsonl
 * (cr-paid.mjs recordCliSpend) and prints "billed $X.XX" in its line. Before a run it sums today's cli rows (America/Chicago).
 * A cap key that is missing or not a number means no cap.
 * Exit 0 = no step failed and a stamp was written. Exit 1 = a step failed (any old stamp is removed).
 * Exit 2 = bad usage (no --body, or the body file cannot be read). Exit 3 = an internal error (an exception inside the run,
 * for example a missing review-router.config.json); the message goes to stderr.
 * Files (all under the gitignored .claude/cache/):
 *   pre-pr/stamp.json                      read by the pre-pr-gate hook: { head, branch, at, body_sha256,
 *                                          cr_skipped, cr_skip_reason, cr_retry_minutes, cr_finished_runs, results }
 *   pre-pr/cr-runs-<branch>.json           the CLI runs used on this branch (cap 2, coderabbit-cli.md). Keyed on the branch
 *                                          name and its first own commit: a merge of main keeps the count, a rebase starts a new one.
 *   pre-pr/cr-lock-<branch>.json           { pid, head, at }, held for the whole CodeRabbit step; a second step on the
 *                                          branch FAILs while it is held; a lock whose pid is dead is replaced.
 *   The counter and the lock sit in the primary checkout's cache (git's common dir), so every worktree shares them.
 *   e2e/<date>-pre-pr-<shortsha>.log       the full log
 *   e2e/<date>-pre-pr-cr-<shortsha>.txt    the CLI review output for the head (reused, never run twice)
 * The CLI review is advisory: its findings are listed and never fail the step. The step fails only when the run is not
 * complete (see the FAIL causes above). It never passes --use-credits or --api-key.
 * Known limits: the stamp and the hook stop an accident, not a forged stamp or a PR opened another way.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findZizmor as defaultFindZizmor, zizmorAdvisory } from './lib/zizmor-advisory.mjs';
import { killTree, processChildren } from './lib/proc.mjs';
import { classify, matchGlob } from './review-router.mjs';
import { parseProof, proofProblems } from './review-status.mjs';
import { cliCapCheck, cliCapLine, cliCapOf, recordCliSpend } from './cr-paid.mjs';

// killTree and processChildren moved to lib/proc.mjs so cursor-review.mjs need not import this file. Kept here for existing importers.
export { killTree, processChildren };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_ROOT = path.resolve(HERE, '..', '..');
const MIN = 60_000;

// ---------- surface table (data: add a row to cover a new surface) ----------

const nodeTest = (id, pattern, timeoutMs = 5 * MIN) => ({ id, cmd: 'node', args: ['--test', pattern], cwd: '.', timeoutMs });

// validate-mods exits 1 when its typecheck cannot run. On Claude Code 2.1.296 and later no command writes the
// .claude-plugin/types folder tsc needs, so this machine has none. Accept that one case, and only that case: validate
// OK, tsc NOT RUN, and every mod test passing. Any other non-zero exit still FAILs.
const MODS_TSC_NOT_RUN = /^mods FAIL: validate OK \([^)]*\) \| tsc NOT RUN \| test \d+ pass 0 fail\s*$/m;
const modsTscNotRun = (out) =>
  MODS_TSC_NOT_RUN.test(out) ? 'tsc NOT RUN (no .claude-plugin/types on this machine); validate OK and every mod test passed' : null;
const nodeGate = (id, script, extra = [], more = {}) => ({ id, cmd: 'node', args: [script, ...extra], cwd: '.', timeoutMs: 5 * MIN, ...more });

/** Runs for every change set. */
export const ALWAYS_GATES = [
  nodeGate('context-budget', 'scripts/rules/context-budget-guard.mjs', ['--repo']),
];

/**
 * One row per surface (AGENTS.md "Testing", every-surface-checklist.md). `globs` use the review router's
 * glob rules. A gate is { id, cmd, args, cwd, timeoutMs }. `postCheck`: git commands that must all print nothing
 * once the gate ran. `appendTouched`: add the touched files that match `globs`, relative to `relativeTo`; the
 * gate is dropped when none match, and `noneNote` becomes a NOTE line. A surface with `manual` adds a NOTE line
 * (with or without gates). A changed path that no surface owns, and is not in the docs class, adds its own NOTE.
 */
const BEHAVIOUR = 'after the forward sync, run the AGENTS.md behaviour check: claude -p "<a prompt this change targets>" --output-format json, and keep the JSON';
export const SURFACES = [
  {
    id: 'hooks',
    globs: ['.claude/hooks/src/**', '.claude/hooks/dist/**', '.claude/hooks/package.json', '.claude/hooks/vitest.config.ts', '.claude/settings.json.template'],
    gates: [
      {
        id: 'hooks-build', cmd: 'npm', args: ['run', 'build'], cwd: '.claude/hooks', timeoutMs: 5 * MIN,
        // `git diff` (content) and `ls-files --others` (new files), not `git status`: after a build on Windows, status
        // lists every dist file as modified when only the file times changed.
        postCheck: {
          argv: [['diff', '--name-only', '--', '.claude/hooks/dist'], ['ls-files', '--others', '--exclude-standard', '--', '.claude/hooks/dist']],
          failText: 'dist is stale: the build changed these files. Commit them with the source',
        },
      },
      // Several dist-integration tests spawn node and use real timers. Alone they take about 3 s; in the full parallel
      // suite on a busy machine they pass vitest's 5 s default (msys-crash-capture, 2026-10-28). --testTimeout gives
      // them room, and --retry covers a rare timer race.
      { id: 'hooks-vitest', cmd: 'npx', args: ['vitest', 'run', '--retry=2', '--testTimeout=30000'], cwd: '.claude/hooks', timeoutMs: 20 * MIN },
    ],
  },
  {
    id: 'rules',
    globs: ['.claude/rules-ondemand/**', '.claude/rules-src/**'],
    gates: [nodeGate('ondemand-index', 'scripts/rules/ondemand-index-check.mjs'), nodeGate('rule-router-probe', 'scripts/rules/rule-router-probe.mjs')],
    manual: BEHAVIOUR,
  },
  { id: 'skills', globs: ['.claude/skills/**'], gates: [nodeGate('audit-skills', 'scripts/skills/audit-skills.mjs')], manual: BEHAVIOUR },
  {
    id: 'agents',
    globs: ['.claude/agents/**'],
    gates: [nodeGate('agent-model-drift', 'scripts/check-agent-model-drift.mjs', ['.']), nodeGate('agent-body', 'scripts/agents/check-agent-body.mjs')],
    manual: `${BEHAVIOUR}; confirm "effort":"high" in the subagent transcript`,
  },
  { id: 'rules-scripts', globs: ['scripts/rules/**'], gates: [nodeTest('rules-tests', 'scripts/rules/test/*.test.mjs')] },
  { id: 'skills-scripts', globs: ['scripts/skills/**'], gates: [nodeTest('skills-tests', 'scripts/skills/*.test.mjs')] },
  { id: 'agents-scripts', globs: ['scripts/agents/**'], gates: [nodeTest('agents-tests', 'scripts/agents/*.test.mjs')] },
  // The workflow is here because semgrep-ccv3.test.mjs (SG2) compares the Semgrep digest in it with the wrapper default.
  { id: 'ratchets-scripts', globs: ['scripts/ratchets/**', '.github/workflows/ccv3-checks.yml'], gates: [nodeTest('ratchets-tests', 'scripts/ratchets/*.test.mjs')] },
  // A surface row, not an always gate: a docs-only PR does not need Docker. Docker not running is a FAIL (D3), never a NOTE or SKIP.
  {
    id: 'semgrep-ccv3',
    // Code files and the rule pack only: a Markdown-only change needs no Docker (CLI review of d405939).
    globs: [
      'scripts/**/*.mjs', 'scripts/**/*.js', 'scripts/**/*.cjs', 'scripts/**/*.ts', 'scripts/ratchets/semgrep-ccv3/**',
      '.claude/plugins/ccv3-mods/hooks/**/*.ts', '.claude/plugins/ccv3-mods/hooks/**/*.tsx', '.claude/hooks/src/**/*.ts',
    ],
    gates: [nodeGate('semgrep-ccv3', 'scripts/ratchets/semgrep-ccv3.mjs')],
  },
  {
    id: 'agentic-os-scrub',
    globs: ['apps/agentic-os/src/server/sources/**', 'apps/agentic-os/e2e/safe-message*.spec.ts', 'apps/agentic-os/playwright.pure.config.ts'],
    // The pure config needs no server, database or browser. It needs root node_modules: run npm ci --ignore-scripts first.
    gates: [nodeGate('scrub-invariant', 'node_modules/@playwright/test/cli.js', ['test', '--config', 'apps/agentic-os/playwright.pure.config.ts', '--reporter=line'])],
  },
  { id: 'checks-scripts', globs: ['scripts/checks/**'], gates: [{ id: 'checks-tests', cmd: 'node', args: ['--test', 'scripts/checks/prove-check.test.mjs', 'scripts/checks/state-table.test.mjs'], cwd: '.', timeoutMs: 5 * MIN }, nodeTest('test-map-tests', 'scripts/checks/test-map.test.mjs')] },
  {
    id: 'config',
    globs: ['.coderabbit.yaml', 'review-router.config.json', '.claude/project-registry.json'],
    gates: [],
    manual: 'a config or registry file with no gate of its own: check it by hand (the review router classes it infra)',
  },
  { id: 'templates', globs: ['.claude/templates/**'], gates: [], manual: 'an always-loaded template: the context-budget gate runs anyway; the sync installs it' },
  // The github suite takes about 14 minutes on this machine (real git, child processes and PowerShell).
  { id: 'github-scripts', globs: ['scripts/github/**'], gates: [nodeTest('github-tests', 'scripts/github/*.test.mjs', 25 * MIN), nodeTest('github-lib-tests', 'scripts/github/lib/*.test.mjs', 2 * MIN), nodeTest('local-review-tests', 'scripts/github/local-review/*.test.mjs', 5 * MIN)] },
  { id: 'trex', globs: ['.trex/**', 'scripts/trex/**', 'docker/trex/**', 'apps/agentic-os/.trex/**', 'apps/agentic-os/e2e/trex-*.spec.ts', 'apps/agentic-os/playwright.trex.config.ts', 'scripts/checks/test-map.mjs'], gates: [nodeTest('trex-tests', 'scripts/trex/**/*.test.mjs')] },
  {
    id: 'mod',
    globs: ['.claude/plugins/ccv3-mods/**'],
    gates: [nodeGate('mods-validate', 'scripts/mods/validate-mods.mjs', [], { timeoutMs: 10 * MIN, acceptExit: modsTscNotRun })],
  },
  {
    id: 'mod-scripts',
    globs: ['scripts/mods/**', '.claude/plugins/claude-hud/**'],
    gates: [nodeTest('mods-script-tests', 'scripts/mods/validate-mods.test.mjs'), nodeTest('claude-hud-config-test', 'scripts/mods/claude-hud-config.test.mjs')],
  },
  {
    id: 'opc',
    globs: ['opc/**'],
    gates: [{
      id: 'opc-pytest', cmd: 'uv', args: ['run', 'pytest'], cwd: 'opc', timeoutMs: 15 * MIN,
      appendTouched: { globs: ['opc/**/test_*.py'], relativeTo: 'opc', noneNote: 'opc changed with no test file touched, so no pytest ran: run uv run pytest in opc for the area you changed' },
    }],
  },
  { id: 'sync', globs: ['scripts/sync-to-active*', 'scripts/sync-claude.sh'], gates: [{ id: 'sync-cursor-test', cmd: 'bash', args: ['scripts/sync-to-active-cursor.test.sh'], cwd: '.', timeoutMs: 5 * MIN }] },
  { id: 'coordination', globs: ['scripts/coordination/**'], gates: [], manual: 'run the matching scripts/coordination/*-probe.mjs and keep its output (AGENTS.md Testing)' },
];

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const touches = (surface, paths) => paths.some((p) => surface.globs.some((g) => matchGlob(g, p)));

function resolveGate(gate, paths) {
  if (!gate.appendTouched) return { ...gate };
  const { globs, relativeTo } = gate.appendTouched;
  const files = paths.filter((p) => globs.some((g) => matchGlob(g, p))).map((p) => path.posix.relative(relativeTo, p));
  return files.length === 0 ? null : { ...gate, args: [...gate.args, ...files] };
}

/** The gates a change set needs: the touched surfaces' gates once each, then the always gates. */
export function gatesFor(changed) {
  const paths = changed.map(norm);
  const out = [];
  const add = (gate) => {
    const resolved = resolveGate(gate, paths);
    if (resolved) out.push(resolved);
  };
  for (const s of SURFACES) if (touches(s, paths)) (s.gates ?? []).forEach(add);
  ALWAYS_GATES.forEach(add);
  return out;
}

/** One NOTE line for each touched surface with a `manual` text, and for a gate dropped because no test file was touched. */
export function manualNotes(changed) {
  const paths = changed.map(norm);
  const touched = SURFACES.filter((s) => touches(s, paths));
  const note = (s, detail) => ({ step: `manual:${s.id}`, status: 'NOTE', detail, notes: [] });
  const dropped = touched.flatMap((s) => (s.gates ?? []).filter((g) => g.appendTouched && resolveGate(g, paths) === null).map((g) => note(s, g.appendTouched.noneNote)));
  return [...touched.filter((s) => s.manual).map((s) => note(s, s.manual)), ...dropped];
}

/** One NOTE line for every changed path that no surface owns and that is not in the docs class (the docs class needs no gate). */
export function unownedNotes(changed, config) {
  return changed.map(norm)
    .filter((p) => !SURFACES.some((s) => s.globs.some((g) => matchGlob(g, p))) && classify([p], config).class !== 'docs')
    .map((p) => ({ step: `unowned:${p}`, status: 'NOTE', detail: 'no surface owns this path, so no gate ran for it beyond the always gate', notes: [] }));
}

export const notesFor = (changed, config) => [...manualNotes(changed), ...unownedNotes(changed, config)];

// ---------- small helpers ----------

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const SUMMARY_LINE = [/\b\d+\s+(?:passed|failed|pass|fail)\b/i, /^#\s*(?:pass|fail)\s+\d+/i, /^(?:PASS|FAIL|OK|ok)\b/, /always-loaded:/i, /\bsummary\b/i];

/** The runner's own summary line: the last line that looks like one, else the last line. Pure. */
export function summaryLine(output) {
  const lines = String(output ?? '').replace(ANSI, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '(no output)';
  for (let i = lines.length - 1; i >= 0; i -= 1) if (SUMMARY_LINE.some((re) => re.test(lines[i]))) return lines[i];
  return lines[lines.length - 1];
}

const result = (step, status, detail, notes = []) => ({ step, status, detail, notes });
const clip = (text, max) => (String(text).length <= max ? String(text) : `${String(text).slice(0, max - 3)}...`);

export function makeGit(root) {
  return (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

// ---------- git preconditions ----------

/** Three results: branch, clean tree, behind. `fetched` is the fetchBase result, or null when no fetch was tried. */
export function checkGit(git, base, fetched = null) {
  const branch = git(['branch', '--show-current']).stdout.trim();
  const branchResult = !branch ? result('git:branch', 'FAIL', 'HEAD is detached: switch to the feature branch')
    : branch === 'main' || branch === base ? result('git:branch', 'FAIL', `on ${branch}: a PR opens from a feature branch, never from ${branch}`)
      : result('git:branch', 'PASS', `on ${branch}`);
  return [branchResult, checkClean(git), checkBehind(git, base, fetched)];
}

/**
 * Edited, staged or untracked files, from three content-based commands. Not `git status --porcelain`: after a
 * build that rewrites a file with the same content, status lists it as modified (only its file time changed),
 * and that made a clean tree fail. Gitignored files do not count.
 */
const DIRTY_COMMANDS = [['diff', '--name-only'], ['diff', '--cached', '--name-only'], ['ls-files', '--others', '--exclude-standard']];
function checkClean(git) {
  const runs = DIRTY_COMMANDS.map((a) => git(a));
  const failed = runs.find((r) => r.status !== 0);
  if (failed) return result('git:clean', 'FAIL', `cannot read the working tree state: ${clip(failed.stderr.trim(), 120)}`);
  const dirty = [...new Set(runs.flatMap((r) => r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)))];
  if (dirty.length === 0) return result('git:clean', 'PASS', 'working tree clean (gitignored files do not count)');
  return result('git:clean', 'FAIL', `${dirty.length} uncommitted path(s): ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', ...' : ''}`);
}

/**
 * The last step before a stamp: HEAD is still the stamped head, and no tracked file is edited or staged. A gate, the
 * build or the CodeRabbit step may have changed the code. Untracked files do not count (the log and stamp are untracked).
 * A git call that fails is a FAIL, never a pass.
 */
const STABLE_COMMANDS = [['diff', '--name-only'], ['diff', '--cached', '--name-only']];
export function checkStable(git, head) {
  const now = git(['rev-parse', 'HEAD']);
  const runs = STABLE_COMMANDS.map((a) => git(a));
  const failed = [now, ...runs].find((r) => r.status !== 0);
  if (failed) return result('git:stable', 'FAIL', `cannot re-read the repo state before the stamp: ${clip(failed.stderr.trim(), 120)}`);
  if (now.stdout.trim() !== head) return result('git:stable', 'FAIL', `HEAD moved during the run: it was ${head.slice(0, 7)}, it is ${now.stdout.trim().slice(0, 7)}. Run pre-pr.mjs again`);
  const dirty = [...new Set(runs.flatMap((r) => r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)))];
  if (dirty.length > 0) return result('git:stable', 'FAIL', `${dirty.length} tracked path(s) changed during the run: ${dirty.slice(0, 8).join(', ')}. The checks did not see this code`);
  return result('git:stable', 'PASS', 'HEAD and tracked files are unchanged since the start');
}

/** The fork remote: every CCv3 push goes there (CONTEXT.md). runPrePr fetches the base from it first (fetchBase). */
const FORK = 'fork';
/** The time limit of the fetch before the behind check. A slow or dead network must not hold the run. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetches `<base>` from the fork into refs/remotes/fork/<base>, so the behind check sees the real remote base.
 * Returns { state, detail }: "ok", "failed" (the exit, the time limit or the spawn error; the caller keeps the old
 * comparison) or "no-remote" (no fork remote, so nothing to fetch). Never throws. A credential prompt is switched off.
 */
export function fetchBase(root, base, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const run = (args, extra = {}) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, ...extra });
  if (run(['remote', 'get-url', FORK]).status !== 0) return { state: 'no-remote', detail: `no ${FORK} remote` };
  // The spawn timeout kills git.exe only. On Windows git-remote-https or ssh can keep the stderr pipe open, so the network
  // limits below stop a hung transfer in git itself, and stdout and stdin are not piped.
  const env = fetchEnv(process.env, run(['config', '--get', 'core.sshCommand']).stdout?.trim() ?? '');
  const refspec = `+refs/heads/${base}:refs/remotes/${FORK}/${base}`;
  const r = run(['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=15', 'fetch', '--quiet', FORK, refspec], { timeout: timeoutMs, env, stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error?.code === 'ETIMEDOUT') return { state: 'failed', detail: `timed out after ${Math.round(timeoutMs / 1000)} s` };
  if (r.error) return { state: 'failed', detail: clip(String(r.error.message), 100) };
  if (r.status !== 0) return { state: 'failed', detail: clip((r.stderr || '').trim().split(/\r?\n/).pop() || `exit ${r.status}`, 100) };
  return { state: 'ok', detail: `fetched ${FORK}/${base}` };
}

/**
 * The env of the base fetch: no credential prompt, and a bounded batch ssh only when the user set no ssh transport.
 * GIT_SSH_COMMAND outranks GIT_SSH and core.sshCommand, so a default here would override the user's own transport.
 */
export function fetchEnv(env, coreSshCommand) {
  const ownSsh = env.GIT_SSH_COMMAND || env.GIT_SSH || coreSshCommand;
  const sshDefault = ownSsh ? {} : { GIT_SSH_COMMAND: 'ssh -o ConnectTimeout=10 -o BatchMode=yes' };
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...sshDefault };
}

/** { n } commits that `ref` has and HEAD lacks, or { error }. */
function behindCount(git, ref) {
  const r = git(['rev-list', '--count', `HEAD..${ref}`]);
  const text = r.stdout.trim();
  if (r.status !== 0 || !/^\d+$/.test(text)) return { error: `cannot count commits behind ${ref}: ${clip(r.stderr.trim() || text, 100)}` };
  return { n: Number(text) };
}

/** What the compared text says about the fork ref: fetched just now, a fetch that failed, or no fetch. */
function behindCaveat(base, hasFork, fetched) {
  const fresh = fetched?.state === 'ok' && hasFork;
  if (fresh) return `compared with local ${base} and ${FORK}/${base}, fetched just now; local ${base} is not fetched, so run git fetch first if it may be stale`;
  const compared = `compared with local ${base}${hasFork ? ` and the last-fetched ${FORK}/${base}` : ''}`;
  if (fetched?.state === 'failed') return `fetch of ${FORK}/${base} failed (${fetched.detail}); ${compared}, so the ${FORK} side may be stale`;
  return `${compared}; no fetch was done, so run git fetch first if ${base} may be stale`;
}

function checkBehind(git, base, fetched = null) {
  if (git(['rev-parse', '--verify', '--quiet', base]).status !== 0) return result('git:behind', 'FAIL', `base ref "${base}" does not exist locally`);
  const forkRef = `refs/remotes/${FORK}/${base}`;
  const hasFork = git(['rev-parse', '--verify', '--quiet', forkRef]).status === 0;
  const counts = [{ name: base, ...behindCount(git, base) }, ...(hasFork ? [{ name: `${FORK}/${base}`, ...behindCount(git, forkRef) }] : [])];
  const broken = counts.find((c) => c.error);
  if (broken) return result('git:behind', 'FAIL', broken.error);
  const caveat = behindCaveat(base, hasFork, fetched);
  const asFetched = fetched?.state === 'ok' ? '' : ' (as last fetched)';
  const behind = counts.filter((c) => c.n > 0).map((c) => `${c.n} commit(s) behind ${c.name}${c.name === base ? '' : asFetched}`);
  // Merge, not rebase: the CLI run cap keys on the branch's first own commit, which a merge keeps and a rebase rewrites.
  if (behind.length > 0) {
    const how = `merge ${base} in (a rebase rewrites the first own commit and starts a new CodeRabbit CLI run count)`;
    return result('git:behind', 'FAIL', `${behind.join('; ')}: ${how} (${caveat})`);
  }
  return result('git:behind', 'PASS', `0 commits behind ${counts.map((c) => c.name).join(' and ')} (${caveat})`);
}

/** { result, paths }: `git diff --name-only <base>...HEAD`. No files is a FAIL. */
export function changedFiles(git, base) {
  const r = git(['diff', '--name-only', `${base}...HEAD`]);
  const paths = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (r.status !== 0) return { paths: [], result: result('changes', 'FAIL', `git diff ${base}...HEAD failed: ${clip(r.stderr.trim(), 120)}`) };
  if (paths.length === 0) return { paths, result: result('changes', 'FAIL', `no files differ from ${base}: nothing to open a PR for`) };
  return { paths, result: result('changes', 'PASS', `${paths.length} file(s) differ from ${base}`) };
}

// ---------- evidence ----------

/** The PR body proof, the way READY reads it (review-status.mjs). `docs` needs every changed file in the docs class. */
export function checkEvidence({ body, head, paths, config }) {
  if (typeof body !== 'string') return result('evidence', 'FAIL', 'no PR body text', ['PR body proof: the draft body could not be read']);
  const parsed = parseProof(body);
  const docsVerified = classify(paths, config).class === 'docs'; // no files classes as normal, never docs
  const problems = proofProblems(parsed, { head, docsVerified });
  if (problems.length > 0) return result('evidence', 'FAIL', `${problems.length} problem(s) READY would report`, problems);
  return result('evidence', 'PASS', `Proof type ${parsed.types[0].trim()}${docsVerified ? ' (every changed file is docs)' : `, GREEN names the head ${head.slice(0, 7)}`}`);
}

// ---------- GREEN sha after a merge of the base ----------

const GREEN_KEY = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?GREEN(?:\*\*|__)?\s*:/;
const GREEN_SHA = /((?:^|\s)(?:@|at\s)\s*`?)([0-9a-fA-F]{7,40})(`?(?=[\s.,;)]|$))/;
const FENCE_START = /^\s*(`{3,}|~{3,})/;
const FENCE_END = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * Text with the sha after "@" on the one GREEN field line replaced by `newSha`, or null. Null when the text has not
 * exactly one GREEN line outside a code fence, or that line does not hold `oldSha`. Only that sha changes: the
 * line endings (CRLF or LF, kept per line), RED, BEFORE and every output block stay byte for byte.
 */
export function rewriteGreenSha(text, oldSha, newSha) {
  const parts = String(text).split(/(\r\n|\n)/); // even indexes are lines, odd indexes are their endings
  let fence = null;
  const hits = [];
  for (let i = 0; i < parts.length; i += 2) {
    const close = fence && FENCE_END.exec(parts[i]);
    if (fence) { if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null; continue; }
    const open = FENCE_START.exec(parts[i]);
    if (open) { fence = { ch: open[1][0], len: open[1].length }; continue; }
    if (GREEN_KEY.test(parts[i])) hits.push(i);
  }
  if (hits.length !== 1) return null;
  const line = parts[hits[0]];
  const afterKey = line.indexOf(':') + 1;
  const command = /^\s*(?:\*\*|__)?\s*`[^`]+`/.exec(line.slice(afterKey));
  const from = afterKey + (command ? command[0].length : 0);
  const m = GREEN_SHA.exec(line.slice(from));
  if (!m || m[2].toLowerCase() !== oldSha) return null;
  const at = from + m.index + m[1].length;
  parts[hits[0]] = `${line.slice(0, at)}${newSha}${line.slice(at + m[2].length)}`;
  return parts.join('');
}

/**
 * True when the only change from `oldSha` to `head` is a clean merge of the base: no own non-merge commit sits between them
 * (the commits the base and fork/<base> already hold do not count), and no merge there holds an edit of its own (a conflict
 * resolved by hand). An ancestor check alone is true for any later commit on a linear branch, so it cannot say that.
 * Any git failure reads as false.
 */
export function onlyBaseMergedSince(git, base, oldSha, head) {
  const forkRef = `refs/remotes/${FORK}/${base}`;
  const hasFork = git(['rev-parse', '--verify', '--quiet', forkRef]).status === 0;
  const range = [`${oldSha}..${head}`, '--not', base, ...(hasFork ? [forkRef] : [])];
  const own = git(['rev-list', '--no-merges', ...range]);
  if (own.status !== 0 || own.stdout.trim() !== '') return false;
  const merges = git(['rev-list', '--merges', ...range]);
  if (merges.status !== 0) return false;
  return merges.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).every((m) => isCleanMerge(git, m));
}

/**
 * True when merge `m` holds exactly the tree git builds from its two parents with no conflict. diff-tree --cc cannot say
 * this: a conflict resolved by taking one parent's version whole shows no combined diff. A conflict, an octopus merge or
 * any git failure reads as false.
 */
function isCleanMerge(git, m) {
  const parents = git(['rev-list', '--parents', '-n', '1', m]);
  const fields = parents.stdout.trim().split(/\s+/);
  if (parents.status !== 0 || fields.length !== 3) return false;
  const rebuilt = git(['merge-tree', '--write-tree', fields[1], fields[2]]); // exit 1 on a conflict
  if (rebuilt.status !== 0) return false;
  const actual = git(['rev-parse', `${m}^{tree}`]);
  return actual.status === 0 && actual.stdout.trim() === rebuilt.stdout.trim().split(/\r?\n/)[0];
}

/**
 * After a merge of the base the GREEN line names the pre-merge head. This updates it when that is safe: the evidence has
 * no other problem, the GREEN commit is an ancestor of HEAD, nothing but a clean merge of the base came after it
 * (onlyBaseMergedSince), and no other step failed (the gates ran on HEAD). It writes the body file and returns
 * { evidence, bodyText, note }. Any other case returns null and changes nothing.
 */
export function updateGreen({ git, base = 'main', bodyPath, bodyText, head, paths, config, results, evidence }) {
  if (!bodyPath || typeof bodyText !== 'string' || evidence.status !== 'FAIL') return null;
  if (evidence.notes.length !== 1 || !/GREEN names commit/.test(evidence.notes[0])) return null;
  if (results.some((r) => r !== evidence && r.status === 'FAIL')) return null;
  const greens = parseProof(bodyText).fields.GREEN;
  const oldSha = greens.length === 1 ? greens[0].sha : null;
  if (!oldSha || git(['merge-base', '--is-ancestor', oldSha, head]).status !== 0) return null;
  if (!onlyBaseMergedSince(git, base, oldSha, head)) return null;
  const newSha = head.slice(0, 7);
  const text = rewriteGreenSha(bodyText, oldSha, newSha);
  if (text === null) return null;
  const again = checkEvidence({ body: text, head, paths, config });
  if (again.status !== 'PASS') return null;
  try {
    if (readFileSync(bodyPath, 'utf8') !== bodyText) return null; // the file changed during the run: never overwrite it
    writeFileSync(bodyPath, text);
  } catch { return null; }
  return { evidence: again, bodyText: text, note: result('evidence:green', 'NOTE', `GREEN updated ${oldSha.slice(0, 7)} -> ${newSha}`) };
}

// ---------- gates ----------

/**
 * The program and arguments to spawn for a gate, never with a shell. npm and npx run as `node <npm>/bin/npm-cli.js`
 * (or npx-cli.js): on Windows their .cmd shims would need a shell, and Node 20.12+ refuses a .cmd without one.
 * Searched next to node (Windows layout) and in ../lib/node_modules (POSIX layout). Not found: POSIX runs the plain
 * command; Windows throws, so the gate FAILs and names the missing file.
 */
export function resolveSpawn(spec, { platform = process.platform, execPath = process.execPath, exists = existsSync } = {}) {
  const win = platform === 'win32';
  const { cmd, args } = spec;
  if (cmd === 'node') return { cmd: execPath, args, shell: false };
  if (cmd === 'bash' && win) return { cmd: 'C:\\Program Files\\Git\\bin\\bash.exe', args, shell: false };
  if (cmd === 'npm' || cmd === 'npx') {
    const sep = win ? '\\' : '/';
    const dir = execPath.slice(0, Math.max(execPath.lastIndexOf('\\'), execPath.lastIndexOf('/')));
    const script = `${cmd}-cli.js`;
    const candidates = [[dir, 'node_modules', 'npm', 'bin', script], [dir, '..', 'lib', 'node_modules', 'npm', 'bin', script]].map((p) => p.join(sep));
    const found = candidates.find((p) => exists(p));
    if (found) return { cmd: execPath, args: [found, ...args], shell: false };
    if (win) throw new Error(`cannot find ${script} next to ${execPath}; looked in ${candidates.join(', ')}`);
  }
  return { cmd, args, shell: false };
}

export function defaultExec(spec) {
  let s;
  try { s = resolveSpawn(spec); } catch (err) { return { status: null, stdout: '', stderr: '', timedOut: false, error: String(err.message) }; }
  const r = spawnSync(s.cmd, s.args, { cwd: spec.cwd, encoding: 'utf8', timeout: spec.timeoutMs, windowsHide: true, shell: false, maxBuffer: 64 * 1024 * 1024 });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut, error: r.error && !timedOut ? String(r.error.message) : undefined };
}

const outputOf = (r) => `${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`;

/** Run one gate. PASS on exit 0 (and an empty post-check). The summary line is the runner's own. */
export function runGate(gate, { root, exec, git }) {
  const step = `gate:${gate.id}`;
  const shown = `${gate.cmd} ${gate.args.join(' ')} (in ${gate.cwd})`;
  const r = exec({ id: gate.id, cmd: gate.cmd, args: gate.args, cwd: path.join(root, gate.cwd), timeoutMs: gate.timeoutMs });
  const out = outputOf(r);
  const base = { output: out, command: shown };
  if (r.timedOut) return { ...result(step, 'FAIL', `timed out after ${Math.round(gate.timeoutMs / MIN)} min: ${shown}`), ...base };
  if (r.error) return { ...result(step, 'FAIL', `could not start: ${r.error}`), ...base };
  if (r.status !== 0) {
    // `acceptExit` names the one known non-zero exit a gate may pass with (see MODS_TSC_NOT_RUN); it returns the note.
    const accepted = gate.acceptExit?.(out.replace(ANSI, ''));
    if (accepted) return { ...result(step, 'PASS', accepted), ...base };
    const tail = out.replace(ANSI, '').split(/\r?\n/).filter(Boolean).slice(-12);
    return { ...result(step, 'FAIL', `exit ${r.status}: ${summaryLine(out)}`, tail), ...base };
  }
  if (gate.postCheck) {
    const posts = gate.postCheck.argv.map((a) => git(a));
    const files = posts.flatMap((p) => p.stdout.split(/\r?\n/).filter(Boolean));
    if (posts.some((p) => p.status !== 0) || files.length > 0) return { ...result(step, 'FAIL', `${gate.postCheck.failText} (${files.length})`, files.slice(0, 10)), ...base };
  }
  return { ...result(step, 'PASS', summaryLine(out)), ...base };
}

// ---------- CodeRabbit CLI review ----------
// The output contract is docs.coderabbit.ai/cli "Agent mode output and exit codes": one JSON object per line, with
// events review_context, status, heartbeat, finding, complete and error.

export const CR_RUN_LIMIT = 2;
/** The hard time limit of one review. Set --cr-timeout-min or PRE_PR_CR_TIMEOUT_MIN to change it. */
export const CR_TIMEOUT_MIN_DEFAULT = 30;
/** How often a running review prints a progress line. */
export const CR_TICK_MS = 60_000;
const USAGE_TIMEOUT_MS = 60_000;
export const STAMP_REL = '.claude/cache/pre-pr/stamp.json';

/** --committed: only the committed work (the gate needs a clean tree). --base is explicit: this checkout has only the fork remote. */
export const CR_ARGS = (base) => ['review', '--agent', '--committed', '--base', base];
/** Read-only and free: how many included reviews are left. */
export const CR_USAGE_ARGS = ['usage', '--agent'];

/** The runner may only run `review` or `usage --agent`, and never with paid or key flags. */
export function assertSafeCrArgs(args) {
  if (args[0] === 'usage') {
    if (args.length !== 2 || args[1] !== '--agent') throw new Error(`forbidden CodeRabbit argument: ${args.join(' ')}`);
    return;
  }
  const bad = args.find((a) => /^--(?:use-credits|api-key)\b/.test(a) || a === 'code');
  if (bad || args[0] !== 'review') throw new Error(`forbidden CodeRabbit argument: ${bad ?? args[0]}`);
}

/** coderabbit-cli.md: a review needs a time limit of at least 15 minutes, or a normal review is cut off and a run is wasted. */
export const CR_TIMEOUT_MIN_FLOOR = 15;

const timeoutSetting = (argv, env) => {
  const fromFlag = option(argv, '--cr-timeout-min');
  return fromFlag !== null ? { name: '--cr-timeout-min', raw: fromFlag } : { name: 'PRE_PR_CR_TIMEOUT_MIN', raw: env.PRE_PR_CR_TIMEOUT_MIN };
};

/**
 * The review time limit in ms: --cr-timeout-min, else PRE_PR_CR_TIMEOUT_MIN, else 30 minutes. A value under 15 (or not a number)
 * is not used: the limit falls back to 30. It is not a usage error, so a run is never refused over this; crTimeoutProblem says so.
 * A test that needs a short limit passes timeoutMs to runCodeRabbit or defaultCrRunner, not the flag.
 */
export function crTimeoutMs(argv, env = process.env) {
  const n = Number(timeoutSetting(argv, env).raw);
  return (Number.isFinite(n) && n >= CR_TIMEOUT_MIN_FLOOR ? n : CR_TIMEOUT_MIN_DEFAULT) * MIN;
}

/** A warning text when a time limit was given and is not used, else null. */
export function crTimeoutProblem(argv, env = process.env) {
  const { name, raw } = timeoutSetting(argv, env);
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= CR_TIMEOUT_MIN_FLOOR) return null;
  return `${name}=${raw} is not used: the time limit must be a number of at least ${CR_TIMEOUT_MIN_FLOOR} minutes. Using ${CR_TIMEOUT_MIN_DEFAULT}.`;
}

/**
 * Runs `cr` as a child process and resolves when it ends. Stdout is streamed into `streamTo` as it arrives, so the file
 * is a live log, and `onTick({ elapsedSec, lastEvent })` runs every `tickMs`. The hard `timeoutMs` stops the child and its
 * whole process tree (killTree). A non-zero exit, a timeout and a spawn error are results, never throws; the partial stdout
 * is kept. Nothing is written to the stream file once the run has settled, and a stream error is returned as `streamError`.
 * The second argument is for tests: another binary, a faster tick, a fake spawn, killer or stream.
 */
export function defaultCrRunner({ cwd, args, timeoutMs, streamTo = null, onTick = null }, {
  command = 'cr', prefixArgs = [], tickMs = CR_TICK_MS, killGraceMs = 5000, spawnFn = spawn, killer = (c) => killTree(c.pid), openStream = createWriteStream,
} = {}) {
  return new Promise((resolve) => {
    assertSafeCrArgs(args);
    const file = streamTo ? openStream(streamTo) : null;
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let partial = '';
    let lastEvent = null;
    let timedOut = false;
    let settled = false;
    let error;
    let errorCode;
    let streamError;
    let child;
    file?.on('error', (err) => { streamError ??= String(err.message); });
    const ticker = setInterval(() => onTick?.({ elapsedSec: Math.round((Date.now() - started) / 1000), lastEvent }), tickMs);
    const limit = setTimeout(() => {
      timedOut = true;
      try { killer(child); } catch { /* the grace timer below ends the wait */ }
      try { child?.kill(); } catch { /* already gone */ }
      setTimeout(() => finish(null), killGraceMs).unref();
    }, timeoutMs);
    function finish(status) {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      clearTimeout(limit);
      file?.end();
      resolve({ status, stdout, stderr, timedOut, error, errorCode, streamError });
    }
    try {
      child = spawnFn(command, [...prefixArgs, ...args], { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      error = String(err.message);
      errorCode = err.code;
      finish(null);
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdout += chunk;
      file?.write(chunk);
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      for (const line of lines) lastEvent = /"type"\s*:\s*"([^"]+)"/.exec(line)?.[1] ?? lastEvent;
    });
    child.stderr.on('data', (chunk) => { if (!settled) stderr += chunk; });
    child.on('error', (err) => { error = String(err.message); errorCode = err.code; finish(null); });
    child.on('close', (code) => finish(code));
  });
}

/** A spawn failure that means the process never started: no CodeRabbit review was begun, so no run is spent. */
const NOT_STARTED = /ENOENT|EINVAL|EACCES|EPERM/;
/** The CLI is not installed (cli-missing). Any other spawn failure is cli-error. */
const MISSING = /ENOENT|EINVAL/;

const skipped = (reason, detail) => ({ ...result('coderabbit', 'SKIP', detail), skipReason: reason });

const safeName = (s) => `${String(s).replace(/[^A-Za-z0-9._-]/g, '_')}-${createHash('sha1').update(String(s)).digest('hex').slice(0, 8)}`;
/** The local calendar day, so a late-evening run is dated the day Dave sees (the stamp `at` stays UTC). */
const dayOf = (now) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const rel = (root, p) => path.relative(root, p).replace(/\\/g, '/');

function readCounter(file, branch) {
  if (!existsSync(file)) return { branch, runs: [] };
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (!doc || !Array.isArray(doc.runs)) throw new Error('shape');
  return doc;
}

/** The JSON objects of an NDJSON text. Blank and non-JSON lines are skipped (and counted by the caller). */
function jsonObjects(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    try {
      const o = JSON.parse(l);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch { return null; }
  });
}

/** { remaining, retryMinutes } from the `cr usage --agent` report, or null when it holds no number `remaining`. */
export function parseUsage(text) {
  for (const o of jsonObjects(text)) {
    // CLI 0.9.0 prints the counts under includedReviews; a flat object is read too.
    const counts = [o?.includedReviews, o, o?.usage, o?.data].find((c) => typeof c?.remaining === 'number');
    if (!counts) continue;
    const ms = Number(counts.fullCapacityInMs);
    return { remaining: counts.remaining, retryMinutes: Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / MIN) : null };
  }
  return null;
}

/** True when `cr usage --agent` reports that CodeRabbit could not look the usage up: a usage status record with status "unavailable". */
export function usageUnavailable(text) {
  return jsonObjects(text).some((o) => o?.type === 'status' && o?.phase === 'usage' && o?.status === 'unavailable');
}

/**
 * What a finished run billed: { files, costCents, unitPriceCents, method } from the complete record's `usageCost`, or null for a free run
 * (no usageCost) and for a malformed one. A charge needs costCents as a whole number above 0. A missing file count reads as 0; a bad one
 * makes the whole record malformed. CLI 0.9.0 bills past the free hourly allowance with no flag and no prompt when usage billing is on
 * (Dave, 2026-11-02).
 */
export function usageCostOf(complete) {
  const u = complete?.usageCost;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  if (!Number.isInteger(u.costCents) || u.costCents <= 0) return null;
  const given = u.billedFilesCount !== undefined;
  if (given && (!Number.isInteger(u.billedFilesCount) || u.billedFilesCount < 0)) return null;
  return { files: given ? u.billedFilesCount : 0, costCents: u.costCents, unitPriceCents: Number.isInteger(u.unitPriceCents) ? u.unitPriceCents : null, method: typeof u.billingMethod === 'string' && u.billingMethod !== '' ? u.billingMethod : null };
}

/** ", billed $1.00 (usage credits)" for a billed run, or "". */
export function billedText(usageCost) {
  if (!usageCost) return '';
  const method = usageCost.method ? ` (${usageCost.method.replace(/_/g, ' ')})` : '';
  return `, billed $${(usageCost.costCents / 100).toFixed(2)}${method}`;
}

const SEVERITIES = ['critical', 'major', 'minor', 'trivial', 'info'];
/** A status or complete record whose own `status` field is one of these stops the run. Text inside a finding never does. */
const AWAITING_STATUS = /^(?:awaiting_confirmation|action_required)$/i;
const KNOWN_EVENTS = new Set(['review_context', 'status', 'heartbeat', 'finding', 'complete', 'error']);

/**
 * Reads an agent stream. Pure. { findings, bySeverity, complete, errors, awaiting, unknown, reviewContext, unparsed, usageCost }.
 * usageCost is usageCostOf(the complete record): null for a free run.
 * A finding has severity, file (fileName), start and end (startLine, endLine) and text (the first non-empty of title,
 * comment, codegenInstructions). Severity "none" is not a finding.
 */
export function parseAgentStream(text) {
  const p = { findings: [], bySeverity: {}, complete: null, errors: [], awaiting: null, unknown: [], reviewContext: false, unparsed: 0, usageCost: null };
  for (const o of jsonObjects(text)) {
    if (o === null) { p.unparsed += 1; continue; }
    if ((o.type === 'status' || o.type === 'complete') && AWAITING_STATUS.test(String(o.status ?? ''))) p.awaiting ??= String(o.status).toLowerCase();
    if (o.type === 'finding') {
      const severity = String(o.severity ?? 'info').toLowerCase();
      if (severity === 'none') continue;
      p.bySeverity[severity] = (p.bySeverity[severity] ?? 0) + 1;
      p.findings.push({ severity, file: o.fileName ?? o.path ?? o.file ?? '?', start: o.startLine, end: o.endLine, text: [o.title, o.comment, o.codegenInstructions].find((v) => typeof v === 'string' && v.trim() !== '') ?? '' });
    } else if (o.type === 'complete') { p.complete = o; p.usageCost = usageCostOf(o); }
    else if (o.type === 'error') p.errors.push(o);
    else if (o.type === 'review_context') p.reviewContext = true;
    else if (!KNOWN_EVENTS.has(o.type) && !p.unknown.includes(String(o.type))) p.unknown.push(String(o.type));
  }
  return p;
}

const rank = (s) => (SEVERITIES.includes(s) ? SEVERITIES.indexOf(s) : SEVERITIES.length);
const lineRange = (f) => (f.start == null ? '' : `:${f.start}${f.end != null && f.end !== f.start ? `-${f.end}` : ''}`);

/** Up to 20 finding lines, worst first, then notes about unknown events, a failed local save and non-JSON lines. */
function streamNotes(p) {
  const lines = [...p.findings].sort((a, b) => rank(a.severity) - rank(b.severity)).slice(0, 20).map((f) => clip(`${f.severity} ${f.file}${lineRange(f)} ${f.text}`.trim(), 170));
  if (p.findings.length > 20) lines.push(`... and ${p.findings.length - 20} more finding(s): read the output file`);
  if (p.unknown.length > 0) lines.push(`unknown event type(s) in the stream: ${p.unknown.join(', ')}`);
  if (p.complete?.persistence?.status === 'failed') lines.push(`the CLI could not save the results locally (${p.complete.persistence.errorCode ?? 'unknown'}): the findings above are from this stream only`);
  if (p.unparsed > 0) lines.push(`${p.unparsed} output line(s) were not JSON`);
  return lines;
}

/** Verdict from the parsed stream and how the process ended (`exitProblem`: a text, or null). The output path is added by the caller. */
function crVerdict(p, { exitProblem, base }) {
  const notes = streamNotes(p);
  const fail = (detail) => result('coderabbit', 'FAIL', detail, notes);
  const c = p.complete;
  if (p.awaiting) return fail(`the CLI ended ${p.awaiting}: stop and report to Dave; do not confirm anything.`);
  if (p.errors.length > 0 && !c) {
    const e = p.errors[0];
    return fail(`the CLI sent an error event (${e.errorType ?? 'unknown'}): ${clip(String(e.message ?? ''), 160)}${exitProblem ? `; ${exitProblem}` : ''}.`);
  }
  if (exitProblem) return fail(`the CLI did not finish: ${exitProblem}; the ${p.findings.length} finding(s) read before the stop are kept.`);
  if (!c) return fail(`INCOMPLETE: no complete event in the stream (${p.findings.length} finding(s) kept).`);
  if (c.status === 'review_skipped') return skipped('no-changes', `the CLI found no changes to review with --committed --base ${base}: check --base and that the work is committed.`);
  if (c.outcome === 'failed' || Number(c.unreviewedFileCount) > 0) {
    return fail(`INCOMPLETE: outcome ${c.outcome ?? 'unknown'}, ${Number(c.unreviewedFileCount) || 0} file(s) not reviewed${c.message ? ` (${clip(String(c.message), 100)})` : ''}.`);
  }
  const words = SEVERITIES.filter((s) => p.bySeverity[s]).map((s) => `${p.bySeverity[s]} ${s}`).join(', ');
  return result('coderabbit', 'PASS', `${p.findings.length} finding(s)${words ? ` (${words})` : ''}${billedText(p.usageCost)}${c.reused ? ', a reused result (not a new review)' : ''}, advisory only (fix real ones, then re-run the Evidence GREEN).`, notes);
}

const withOutput = (verdict, savedAs) => ({ ...verdict, detail: `${verdict.detail} Output: ${savedAs}` });

/**
 * The folder of the run counter and the run lock: the primary checkout's .claude/cache/pre-pr, found through git's common dir, so
 * every worktree of the repo shares one cap. A folder that is not the root of a checkout keeps its own (and never reaches a repo
 * above it).
 */
export function sharedPrDir(root) {
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', windowsHide: true });
  const top = git('rev-parse', '--show-toplevel');
  const common = git('rev-parse', '--git-common-dir');
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (top.status === 0 && common.status === 0 && same(top.stdout.trim(), root)) {
    const dir = path.resolve(root, common.stdout.trim());
    if (path.basename(dir) === '.git') return path.join(path.dirname(dir), '.claude', 'cache', 'pre-pr');
  }
  return path.join(root, '.claude', 'cache', 'pre-pr');
}

/**
 * The branch's first own commit: the oldest commit of `git rev-list --reverse --first-parent <base>..<branch>`, or '' when the branch has
 * none or git cannot tell (not a checkout). It makes a branch name that is reused for new work start with an empty count. A merge of the base
 * into the branch leaves it unchanged (the first-parent line stays), so the cap holds across a merge of main. A rebase or an amend of
 * that commit rewrites it and so starts a new count. HEAD is read only when the branch ref does not exist.
 */
function firstOwnCommitOf(root, branch, base) {
  for (const tip of [`refs/heads/${branch}`, 'HEAD']) {
    const r = spawnSync('git', ['rev-list', '--reverse', '--first-parent', `${base}..${tip}`], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) continue;
    const first = r.stdout.split(/\r?\n/)[0].trim();
    return /^[0-9a-f]{40}$/.test(first) ? first : '';
  }
  return '';
}

/** { dir, counter, lock } for a branch, in the shared folder. The key is the branch name plus its first own commit (see firstOwnCommitOf). */
export function crPaths(root, branch, base = 'main') {
  const dir = sharedPrDir(root);
  const firstCommit = firstOwnCommitOf(root, branch, base);
  const name = safeName(firstCommit ? `${branch}@${firstCommit}` : branch);
  return { dir, counter: path.join(dir, `cr-runs-${name}.json`), lock: path.join(dir, `cr-lock-${name}.json`) };
}

/** How many CLI runs on this branch finished with a PASS (the cap counts only these for the hook). 0 when there is no counter. */
export function finishedRuns(root, branch, base = 'main') {
  try { return readCounter(crPaths(root, branch, base).counter, branch).runs.filter((r) => r.complete === true).length; } catch { return 0; }
}

/** An empty or half-written lock younger than this may still be in its writer's hands (wx creates, then writes). */
export const LOCK_GRACE_MS = 10_000;

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

/**
 * Takes the run lock: a file made with flag wx that holds { pid, head, at }. { ok: true } when it is ours. { ok: false, pid, head }
 * when a live process holds it. A lock is stale, and replaced, when its pid is not alive, its body cannot be read, or it is older than
 * `staleMs` (pids are reused on Windows, so a live pid alone does not prove the run is still going).
 */
export function acquireLock(file, info, { nowMs, staleMs, stat = statSync }) {
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify(info), { flag: 'wx' });
      return { ok: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let held = null;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') continue; // the holder just released it: try again
      throw err; // another read error: never remove a lock we cannot read
    }
    try { held = JSON.parse(text); } catch { held = null; }
    if (!held) {
      // Empty or half-written: wx creates the file before its body is written. Remove it only when it is old enough
      // that no live writer can still be between those two steps (LOCK_GRACE_MS), else report it as held.
      let mtimeMs;
      try { mtimeMs = stat(file).mtimeMs; } catch (err) {
        if (err.code === 'ENOENT') continue; // the holder just released it: the next create can win (L6)
        throw err; // another stat error: never guess the lock's age
      }
      if (Date.now() - mtimeMs < LOCK_GRACE_MS) return { ok: false, pid: null, head: null };
      rmSync(file, { force: true });
      continue;
    }
    const age = nowMs - Date.parse(held.at);
    if (Number.isInteger(held.pid) && pidAlive(held.pid) && !(age > staleMs)) return { ok: false, pid: held.pid, head: held.head };
    rmSync(file, { force: true });
  }
  return { ok: false, pid: null, head: null };
}

/** The free check before a slot is spent. Null to go on, or a SKIP: the CLI is missing (cli-missing), broken (cli-error), or no included review is left. */
async function preflight(runner, root) {
  const r = await runner({ cwd: root, args: CR_USAGE_ARGS, timeoutMs: USAGE_TIMEOUT_MS });
  // CodeRabbit could not look the count up (exit 1, status "unavailable"): the count is unknown, not the CLI broken. Go on: the
  // review itself stops on awaiting_confirmation past the allowance, and pre-pr never passes --use-credits.
  if (!r.error && !r.timedOut && usageUnavailable(r.stdout)) return null;
  if (r.error || r.timedOut || r.status !== 0) {
    const missing = Boolean(r.error) && MISSING.test(String(r.errorCode ?? r.error));
    const why = r.timedOut ? 'timed out' : r.error ?? `exit ${r.status}${r.stderr ? `: ${clip(r.stderr.trim().split(/\r?\n/)[0], 100)}` : ''}`;
    return skipped(missing ? 'cli-missing' : 'cli-error', `cr usage --agent failed (${why}), so no CLI review was started and no run was spent. ${missing ? 'Install cr or ask Dave' : 'Check cr auth status; a retry costs nothing'}`);
  }
  const usage = parseUsage(r.stdout);
  if (usage && usage.remaining <= 0) {
    const wait = usage.retryMinutes === null ? 'the wait is unknown' : `capacity returns in about ${usage.retryMinutes} min`;
    return { ...skipped('rate-limited', `no included CLI review is left (remaining ${usage.remaining}); ${wait}. No run was spent`), retryMinutes: usage.retryMinutes };
  }
  return null;
}

/**
 * One `cr review --agent --committed` per head, at most CR_RUN_LIMIT per branch across every worktree. In order: --skip-cr; a saved
 * output for this head (reused, no run); the run lock (a second step on the same branch FAILs while one runs; a stale lock is replaced);
 * the run counter and its cap; the free `cr usage --agent` preflight; the review, streamed to <date>-pre-pr-cr-<sha7>.running.txt and then
 * saved as .txt (a finished review) or .failed.txt. A run that started uses a slot, even if it failed. A process that never started, a failed
 * preflight, a cap and a review_skipped result use none. Findings never fail the step. `log` gets a progress line each minute.
 * `runner` may be sync or async.
 */
export async function runCodeRabbit({ root, branch, head, base, now, runner, skip = false, timeoutMs = CR_TIMEOUT_MIN_DEFAULT * MIN, log = () => {}, cliCapUsd = null, ledgerPath = null }) {
  if (skip) return skipped('flag', '--skip-cr: no CLI review was run (the pre-pr-gate hook denies a stamp that skipped it by flag)');
  const short = head.slice(0, 7);
  const e2e = path.join(root, '.claude', 'cache', 'e2e');
  const saved = existsSync(e2e) ? readdirSync(e2e).find((n) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-pre-pr-cr-${short}\\.txt$`).test(n)) : undefined;
  if (saved) {
    const verdict = crVerdict(parseAgentStream(readFileSync(path.join(e2e, saved), 'utf8')), { exitProblem: null, base });
    return { ...verdict, detail: `reused the saved CLI output for ${short} (no run, no slot used): ${verdict.detail} Output: ${rel(root, path.join(e2e, saved))}` };
  }
  const paths = crPaths(root, branch, base);
  const lock = acquireLock(paths.lock, { pid: process.pid, head, at: now.toISOString() }, { nowMs: now.getTime(), staleMs: timeoutMs + 10 * MIN });
  if (!lock.ok) return result('coderabbit', 'FAIL', `a CodeRabbit run is in progress (pid ${lock.pid ?? 'unknown'}${lock.head ? `, head ${String(lock.head).slice(0, 7)}` : ''}) on ${branch}: wait for it, then run pre-pr.mjs again. If no run is going, delete the lock file ${paths.lock}`);
  try {
    return await reviewUnderLock({ root, branch, head, base, now, runner, timeoutMs, log, paths, e2e, short, cliCapUsd, ledgerPath });
  } finally {
    rmSync(paths.lock, { force: true });
  }
}

/** The deps of the paid ledger helpers in cr-paid.mjs: the step's clock, and a ledger path when the caller gives one. */
const ledgerDeps = (now, ledgerPath) => ({ now: () => now, ...(ledgerPath ? { ledgerPath } : {}) });

/**
 * The daily CLI spend cap (review-router.config.json coderabbit.cli_daily_cap_usd). Null to go on, or a result that stops the run before a
 * usage call or a slot: SKIP cli-cap at or over the cap, FAIL when the ledger cannot be read (the total is unknown). No cap: never reads the ledger.
 */
function cliCapBlock(cliCapUsd, now, ledgerPath) {
  if (cliCapUsd === null || cliCapUsd === undefined) return null;
  try {
    const check = cliCapCheck(cliCapUsd, ledgerDeps(now, ledgerPath));
    return check.capped ? skipped('cli-cap', `${cliCapLine(check)}, so no CLI review this time and no run was spent. Raise the cap or run it tomorrow; ask Dave`) : null;
  } catch (err) {
    return result('coderabbit', 'FAIL', `the paid ledger is unreadable (${String(err.message).split('\n')[0]}), so the CLI spend today is unknown and no CLI review was started: fix or delete the ledger, then re-run`);
  }
}

/** Logs the cost of a billed run in the paid ledger. Returns a note when the row could not be written (the run is already paid for), else null. */
function logCliSpend({ branch, head, parsed, now, ledgerPath }) {
  if (!parsed.usageCost) return null;
  try { recordCliSpend({ branch, head, usageCost: parsed.usageCost }, ledgerDeps(now, ledgerPath)); return null; } catch (err) {
    return `could not log this run's cost (${billedText(parsed.usageCost).replace(/^, /, '')}) in the paid ledger: ${String(err.message).split('\n')[0]}. Add the row by hand`;
  }
}

async function reviewUnderLock({ root, branch, head, base, now, runner, timeoutMs, log, paths, e2e, short, cliCapUsd, ledgerPath }) {
  const counterFile = paths.counter;
  let counter;
  try { counter = readCounter(counterFile, branch); } catch { return result('coderabbit', 'FAIL', `the run counter ${rel(root, counterFile)} is unreadable: fix or delete it, then re-run`); }
  if (counter.runs.length >= CR_RUN_LIMIT) return skipped('cap', `limit reached: ${counter.runs.length} cr review runs already used on ${branch} (coderabbit-cli.md allows ${CR_RUN_LIMIT} per PR), so no CLI review this time; the stamp records cr_skip_reason cap`);
  const capped = cliCapBlock(cliCapUsd, now, ledgerPath);
  if (capped) return capped;
  const blocked = await preflight(runner, root);
  if (blocked) return blocked;
  const run = { head, at: now.toISOString(), outcome: 'started' };
  const giveBack = () => {
    counter.runs.splice(counter.runs.indexOf(run), 1);
    writeFileSync(counterFile, JSON.stringify(counter, null, 2));
  };
  counter.runs.push(run);
  mkdirSync(path.dirname(counterFile), { recursive: true });
  writeFileSync(counterFile, JSON.stringify(counter, null, 2));
  mkdirSync(e2e, { recursive: true });
  const running = path.join(e2e, `${dayOf(now)}-pre-pr-cr-${short}.running.txt`);
  const onTick = (t) => log(`pre-pr: cr review still running (${t.elapsedSec}s${t.lastEvent ? `, last event: ${t.lastEvent}` : ''}); limit ${Math.round(timeoutMs / MIN)} min`);
  const r = await runner({ cwd: root, args: CR_ARGS(base), timeoutMs, streamTo: running, onTick });
  if (r.error && !r.timedOut && NOT_STARTED.test(String(r.errorCode ?? r.error))) {
    giveBack();
    const missing = MISSING.test(String(r.errorCode ?? r.error));
    return skipped(missing ? 'cli-missing' : 'cli-error', `the CLI did not start (${r.error}); no run was spent. ${missing ? 'Install cr or ask Dave' : 'Check the cr install; a retry costs nothing'}`);
  }
  const exitProblem = r.timedOut ? `timed out after ${Math.round(timeoutMs / MIN)} min` : r.error ? `could not run (${r.error})` : r.status !== 0 ? `exit ${r.status}` : null;
  const stdout = r.stdout ?? '';
  const parsed = parseAgentStream(stdout);
  const verdict = crVerdict(parsed, { exitProblem, base });
  const out = path.join(e2e, `${dayOf(now)}-pre-pr-cr-${short}${verdict.status === 'PASS' ? '' : '.failed'}.txt`);
  writeFileSync(out, r.stderr && verdict.status !== 'PASS' ? `${stdout}\n[stderr]\n${r.stderr}` : stdout);
  rmSync(running, { force: true });
  const logNote = logCliSpend({ branch, head, parsed, now, ledgerPath });
  if (logNote) verdict.notes = [...(verdict.notes ?? []), logNote];
  if (verdict.skipReason === 'no-changes') giveBack();
  else {
    run.outcome = verdict.status === 'PASS' ? 'finished' : 'failed';
    run.complete = verdict.status === 'PASS';
    writeFileSync(counterFile, JSON.stringify(counter, null, 2));
  }
  return withOutput(verdict, rel(root, out));
}

// ---------- the whole run ----------

const lineOf = (r) => `${r.status} ${r.step} - ${r.detail}`;

function formatLines(results) {
  return results.flatMap((r) => [lineOf(r), ...(r.notes ?? []).map((n) => `    ${n}`)]);
}

function writeLog({ root, now, head, branch, base, bodySha, results, lines }) {
  const dir = path.join(root, '.claude', 'cache', 'e2e');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${dayOf(now)}-pre-pr-${head.slice(0, 7)}.log`);
  const outputs = results.filter((r) => r.output).map((r) => `\n===== ${r.step}: ${r.command}\n${clip(r.output.replace(ANSI, ''), 200_000)}`);
  const head2 = [`pre-pr ${now.toISOString()}`, `head ${head}`, `branch ${branch}`, `base ${base} (local ref; fork/${base} fetched first, see git:behind)`, `body_sha256 ${bodySha}`, ''];
  writeFileSync(file, [...head2, ...lines, ...outputs, ''].join('\n'));
  return file;
}

/** One row in the guard decision log (the file the hooks write): the CodeRabbit CLI is not installed, so no CLI review ran. Never throws. */
export function logCliMissing(entry, env = process.env) {
  try {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    const file = env.CCV3_GUARD_DECISIONS_LOG || path.join(home, '.claude', 'logs', 'guard-decisions.jsonl');
    const row = { ts: new Date().toISOString(), hook: 'pre-pr', tool: '', decision: 'cli-missing', reason: String(entry?.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200), session_id: '' };
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch { /* a log problem never stops the run */ }
}

/** Runs every step. Writes the log always and the stamp only on a full pass. Returns { ok, results, lines, head, branch, logPath, stampPath }. */
export async function runPrePr({ root, base = 'main', bodyText, bodyPath = null, skipCr = false, now = new Date(), git = makeGit(root), exec = defaultExec, crRunner = defaultCrRunner, config, crTimeout = CR_TIMEOUT_MIN_DEFAULT * MIN, log = () => {}, guardLog = logCliMissing, fetch = (r, b) => fetchBase(r, b), ledgerPath = null, findZizmor = defaultFindZizmor, zizmorRun = undefined }) {
  const cfg = config ?? JSON.parse(readFileSync(path.join(root, 'review-router.config.json'), 'utf8'));
  const stampPath = path.join(root, STAMP_REL);
  const headRun = git(['rev-parse', 'HEAD']);
  const head = headRun.status === 0 ? headRun.stdout.trim() : null;
  const branch = git(['branch', '--show-current']).stdout.trim();
  const fetched = fetch(root, base);
  if (fetched?.state === 'failed') log(`pre-pr: fetch of ${FORK}/${base} failed (${fetched.detail}); the behind check uses the last-fetched ref`);
  const results = [...checkGit(git, base, fetched)];
  const changes = head ? changedFiles(git, base) : { paths: [], result: result('changes', 'FAIL', 'cannot read HEAD') };
  results.push(changes.result);
  const evidenceAt = results.length;
  results.push(checkEvidence({ body: bodyText, head: head ?? '', paths: changes.paths, config: cfg }));
  for (const gate of gatesFor(changes.paths)) results.push(runGate(gate, { root, exec, git }));
  // A stale GREEN sha after a merge of the base: fix the body file once the gates passed on this head.
  const green = head ? updateGreen({ git, base, bodyPath, bodyText, head, paths: changes.paths, config: cfg, results, evidence: results[evidenceAt] }) : null;
  if (green) {
    bodyText = green.bodyText;
    results.splice(evidenceAt, 1, green.evidence, green.note);
    log(`pre-pr: ${green.note.detail}`);
  }
  results.push(...notesFor(changes.paths, cfg));
  // Advisory only (one-week trial): a NOTE line when the diff touches .github/workflows/*, never a FAIL.
  const zizmor = zizmorAdvisory({ root, paths: changes.paths, bin: findZizmor(), run: zizmorRun });
  if (zizmor) results.push(zizmor);
  const failedBefore = results.some((r) => r.status === 'FAIL');
  results.push(failedBefore && !skipCr
    ? skipped('earlier-step-failed', 'not run: an earlier step failed, and a CLI review run is limited to 2 per branch')
    : await runCodeRabbit({ root, branch, head: head ?? '', base, now, runner: crRunner, skip: skipCr, timeoutMs: crTimeout, log, cliCapUsd: cliCapOf(cfg), ledgerPath }));
  const crStep = results[results.length - 1];
  if (crStep.skipReason === 'cli-missing') {
    // The hook accepts this stamp, so say plainly that no CLI review ran, and leave a row Dave can find later.
    results.push({ step: 'coderabbit:cli-missing', status: 'NOTE', detail: `no CLI review ran: ${crStep.detail}`, notes: [] });
    guardLog({ hook: 'pre-pr', decision: 'cli-missing', reason: crStep.detail });
  }
  // A tree that was already dirty at the start is reported once, by git:clean.
  if (head !== null && !results.some((r) => r.step === 'git:clean' && r.status === 'FAIL')) results.push(checkStable(git, head));
  const ok = head !== null && !results.some((r) => r.status === 'FAIL');
  const lines = formatLines(results);
  const bodySha = createHash('sha256').update(String(bodyText ?? '')).digest('hex');
  const logPath = head ? writeLog({ root, now, head, branch, base, bodySha, results, lines }) : null;
  if (existsSync(stampPath)) unlinkSync(stampPath);
  if (ok) {
    mkdirSync(path.dirname(stampPath), { recursive: true });
    const slim = results.map(({ step, status, detail }) => ({ step, status, detail }));
    const cr = results.find((r) => r.step === 'coderabbit');
    const crSkipped = cr?.status === 'SKIP';
    writeFileSync(stampPath, JSON.stringify({ head, branch, at: now.toISOString(), body_sha256: bodySha, cr_finished_runs: finishedRuns(root, branch, base), cr_skipped: crSkipped, cr_skip_reason: crSkipped ? cr.skipReason ?? null : null, cr_retry_minutes: crSkipped ? cr.retryMinutes ?? null : null, results: slim }, null, 2));
  }
  return { ok, results, lines, head, branch, logPath, stampPath: ok ? stampPath : null };
}

// ---------- CLI ----------

const USAGE = 'usage: node scripts/github/pre-pr.mjs --body <evidence-draft.md> [--base main] [--skip-cr] [--cr-timeout-min N] [--json]';

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

function repoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : SCRIPT_ROOT;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
  const bodyPath = option(args, '--body');
  if (!bodyPath) { console.error(USAGE); process.exit(2); }
  let bodyText;
  try { bodyText = readFileSync(path.resolve(bodyPath), 'utf8'); } catch (err) {
    console.error(`pre-pr: cannot read the body file ${bodyPath} (${String(err.message).split('\n')[0]})\n${USAGE}`);
    process.exit(2);
  }
  const timeoutProblem = crTimeoutProblem(args);
  if (timeoutProblem) console.error(`pre-pr: ${timeoutProblem}`);
  const run = await runPrePr({
    root: repoRoot(), base: option(args, '--base') ?? 'main', bodyText, bodyPath: path.resolve(bodyPath), skipCr: args.includes('--skip-cr'),
    crTimeout: crTimeoutMs(args), log: (line) => console.error(line),
  });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok: run.ok, head: run.head, branch: run.branch, logPath: run.logPath, stampPath: run.stampPath, results: run.results.map(({ step, status, detail, notes }) => ({ step, status, detail, notes })) }));
  } else {
    console.log(run.lines.join('\n'));
    console.log(`RESULT ${run.ok ? 'PASS: stamp written' : 'FAIL: no stamp'}${run.logPath ? ` (log ${rel(repoRoot(), run.logPath)})` : ''}`);
  }
  process.exit(run.ok ? 0 : 1);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
}
if (isDirectRun()) {
  main().catch((err) => {
    console.error(`pre-pr: stopped by an error (${String(err?.message ?? err).split('\n')[0]})`);
    process.exit(3);
  });
}
