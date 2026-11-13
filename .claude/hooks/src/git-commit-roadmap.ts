#!/usr/bin/env node
/**
 * Git Commit ROADMAP Sync Hook
 *
 * PostToolUse:Bash - Detects successful git commits and updates ROADMAP.md
 *
 * Parses conventional commit messages:
 * - feat: → adds to Completed as feature
 * - fix: → adds to Completed as fix
 * - chore: → skipped by default (configurable)
 *
 * Hook: PostToolUse (Bash matching git commit)
 * Output: Appends to {project}/ROADMAP.md Completed section
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import {
  commitRanInProject,
  isPathInsideProject,
  localDateStamp,
  parseGitCommitInvocations,
} from './shared/roadmap-sync-guards.js';
import { insertUnderSection } from './shared/roadmap-splice.js';
import { writeRoadmapGuarded, appendRoadmapAuditRecord } from './shared/roadmap-audit.js';
import { isEngineHost } from './shared/engine-host.js';

interface PostToolUseInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
}

interface HookOutput {
  result?: 'continue' | 'block';
  message?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
}

interface ParsedCommit {
  type: string;
  scope: string | null;
  description: string;
  hash: string | null;
  isAmend: boolean;
  isMerge: boolean;
  isRevert: boolean;
}

const COMMIT_PATTERNS = {
  conventional: /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci)(?:\(([^)]+)\))?!?:\s*(.+)$/i,
  commitOutput: /^\[([^\s]+)\s+([a-f0-9]{7,})\]\s+(.+)$/m,
  amendIndicator: /\[.*\s+[a-f0-9]+\].*\(amend\)/i,
  mergeIndicator: /^Merge\s+(branch|pull request|remote-tracking)/i,
  revertIndicator: /^Revert\s+"/i,
};

const SKIP_TYPES = new Set(['chore', 'style', 'ci']);

/**
 * Harness tools that run a shell command and therefore can produce a commit.
 * MUST stay in step with this hook's `matcher` in settings.json (currently
 * `Bash|PowerShell`) -- a matcher that admits a tool this set rejects is an
 * inert registration, which is exactly the 2026-08-05 defect.
 */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000).unref();
  });
}

/**
 * Recognise a `git commit` in any option form.
 *
 * Was `normalized.includes('git commit')`, which is FALSE for
 * `git -C <path> commit` — so every commit made that way was invisible to this
 * hook and never reached the ROADMAP (found 2026-08-05; `git -C` is the form
 * .claude/docs/windows/platform-notes.md recommends for the PowerShell tool, because
 * the Bash tool hangs on git/network ops). Now tokenizes the invocation.
 *
 * The `--amend` exclusion is preserved, and is now per-invocation rather than a
 * whole-string test — so `git commit -m "..."` in a command that ALSO mentions
 * the word --amend elsewhere is still recorded correctly.
 */
function isGitCommitCommand(command: string): boolean {
  const invocations = parseGitCommitInvocations(command);
  return invocations.length > 0 && invocations.some((inv) => !inv.hasAmend);
}

function isSuccessfulCommit(response: string): boolean {
  return COMMIT_PATTERNS.commitOutput.test(response) &&
         !COMMIT_PATTERNS.amendIndicator.test(response);
}

function parseCommitFromOutput(output: string): ParsedCommit | null {
  const commitMatch = output.match(COMMIT_PATTERNS.commitOutput);
  if (!commitMatch) {
    return null;
  }

  const [, branch, hash, message] = commitMatch;
  const trimmedMsg = message.trim();

  const isAmend = COMMIT_PATTERNS.amendIndicator.test(output);
  const isMerge = COMMIT_PATTERNS.mergeIndicator.test(trimmedMsg);
  const isRevert = COMMIT_PATTERNS.revertIndicator.test(trimmedMsg);

  const conventionalMatch = trimmedMsg.match(COMMIT_PATTERNS.conventional);
  if (conventionalMatch) {
    const [, type, scope, desc] = conventionalMatch;
    return {
      type: type.toLowerCase(),
      scope: scope || null,
      description: desc.trim(),
      hash,
      isAmend,
      isMerge,
      isRevert,
    };
  }

  return {
    type: 'other',
    scope: null,
    description: trimmedMsg,
    hash,
    isAmend,
    isMerge,
    isRevert,
  };
}

function findRoadmapPath(projectDir: string): string | null {
  const candidates = [
    path.join(projectDir, 'ROADMAP.md'),
    path.join(projectDir, '.claude', 'ROADMAP.md'),
    path.join(projectDir, 'roadmap.md'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function formatCommitEntry(commit: ParsedCommit, date: string): string {
  const typeLabel = commit.type !== 'other' ? commit.type : '';
  const scopeLabel = commit.scope ? `(${commit.scope})` : '';
  const prefix = typeLabel && scopeLabel ? `${typeLabel}${scopeLabel}: ` :
                 typeLabel ? `${typeLabel}: ` :
                 scopeLabel ? `${scopeLabel} ` : '';
  const hashLabel = commit.hash ? ` \`${commit.hash.slice(0, 7)}\`` : '';

  return `- [x] ${prefix}${commit.description} (${date})${hashLabel}`;
}

function isDuplicateEntry(content: string, commit: ParsedCommit): boolean {
  if (commit.hash) {
    if (content.includes(commit.hash.slice(0, 7))) {
      return true;
    }
  }

  const descLower = commit.description.toLowerCase();
  const lines = content.split('\n');

  for (const line of lines) {
    if (line.trim().startsWith('- [x]')) {
      const lineLower = line.toLowerCase();
      if (lineLower.includes(descLower.slice(0, 30))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Private wrapper preserved at its original call site so behaviour and the
 * existing pinned tests (`git-commit-roadmap.test.ts`,
 * `git-commit-roadmap-qw12.test.ts`) are unchanged. The actual logic now lives
 * once, in `shared/roadmap-splice.ts`'s `insertUnderSection` -- a verbatim
 * behavioural promotion of what used to be this function's body. See that
 * export's doc comment for the two quirks (dead `inSection` flag, first-prefix
 * section match) preserved on purpose rather than fixed here.
 */
function appendToCompleted(content: string, entry: string): string {
  return insertUnderSection(content, '## completed', entry);
}

// ---------------------------------------------------------------------------
// H2 auto-commit follow-on (plan `i-was-working-in-composed-manatee.md` SS6).
//
// Recursion is prevented by three INDEPENDENT barriers, not one:
//   1. Hooks fire on *tool* events. The `git commit --only` below is spawned
//      directly by THIS hook process via execFileSync, never through the Bash
//      tool -- so it cannot itself produce a PostToolUse:Bash event and
//      re-enter this hook. (Proved by inspection: there is no Bash-tool call
//      anywhere on this path, not merely assumed.)
//   2. `chore` is in SKIP_TYPES (checked well above, before any of this runs)
//      -- which is exactly why the auto-commit message below MUST start with
//      `chore(roadmap):`. That is a deliberate belt, not cosmetics.
//   3. `isDuplicateEntry` matches the 7-char commit hash already written into
//      ROADMAP.md, so even a `chore` slipping past SKIP_TYPES would find its
//      own entry already present and skip.
//
// NOTE: `commitRanInProject` (QW-12/D2d-10) does NOT cover recursion -- it
// only rejects a `cd <other-repo> && git commit` that ran outside this
// project directory. Do not assume it protects against this hook
// re-triggering itself; nobody reading this later should have to rediscover
// that boundary the hard way.
// ---------------------------------------------------------------------------

interface AutoCommitGitFacts {
  isGitWorkTree: boolean;
  operationInProgress: boolean;
  isTracked: boolean;
  preDirty: boolean;
}

export interface ShouldAutoCommitRoadmapOptions {
  roadmapPath: string;
  projectDir: string;
  isGitWorkTree: boolean;
  operationInProgress: boolean;
  isTracked: boolean;
  preDirty: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Pure, git-free, fully table-testable gate for the H2 auto-commit
 * follow-on. Every git-derived fact (work-tree membership, an operation in
 * progress, whether ROADMAP.md is tracked, pre-existing dirtiness) is passed
 * in as a plain boolean/string by the caller -- this function itself never
 * shells out, so it needs no process mocking to unit test.
 */
export function shouldAutoCommitRoadmap(
  opts: ShouldAutoCommitRoadmapOptions,
): { ok: boolean; reason?: string } {
  const env = opts.env ?? process.env;

  if (env.CCV3_ROADMAP_AUTOCOMMIT === '0') {
    return { ok: false, reason: 'autocommit_disabled' };
  }

  const expectedPath = path.join(opts.projectDir, 'ROADMAP.md');
  if (opts.roadmapPath !== expectedPath) {
    return { ok: false, reason: 'path_mismatch' };
  }
  if (!isPathInsideProject(opts.roadmapPath, opts.projectDir)) {
    return { ok: false, reason: 'path_outside_project' };
  }
  if (!opts.isGitWorkTree) {
    return { ok: false, reason: 'not_git_worktree' };
  }
  if (opts.operationInProgress) {
    return { ok: false, reason: 'git_operation_in_progress' };
  }
  if (!opts.isTracked) {
    return { ok: false, reason: 'not_tracked' };
  }
  if (opts.preDirty) {
    return { ok: false, reason: 'pre_dirty' };
  }

  return { ok: true };
}

function isInsideGitWorkTree(projectDir: string): boolean {
  try {
    const out = execFileSync(
      'git',
      ['-C', projectDir, 'rev-parse', '--is-inside-work-tree'],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf-8' },
    );
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

function resolveGitDir(projectDir: string): string | null {
  try {
    const out = execFileSync(
      'git',
      ['-C', projectDir, 'rev-parse', '--git-dir'],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf-8' },
    ).trim();
    if (!out) return null;
    return path.isAbsolute(out) ? out : path.resolve(projectDir, out);
  } catch {
    return null;
  }
}

function isGitOperationInProgress(gitDir: string | null): boolean {
  // Unknown git dir -> fail closed (an operation could be in progress).
  if (!gitDir) return true;
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];
  for (const marker of markers) {
    if (fs.existsSync(path.join(gitDir, marker))) return true;
  }
  return (
    fs.existsSync(path.join(gitDir, 'rebase-merge')) ||
    fs.existsSync(path.join(gitDir, 'rebase-apply'))
  );
}

function isRoadmapTracked(projectDir: string, relPath: string): boolean {
  try {
    execFileSync(
      'git',
      ['-C', projectDir, 'ls-files', '--error-unmatch', '--', relPath],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf-8' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Item B: dirtiness MUST be captured before this hook's own write -- else the
 * flag would just reflect our own pending append and every auto-commit would
 * spuriously refuse.
 */
function isRoadmapPreDirty(projectDir: string, relPath: string): boolean {
  try {
    const out = execFileSync(
      'git',
      ['-C', projectDir, 'status', '--porcelain', '--', relPath],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf-8' },
    );
    return out.trim().length > 0;
  } catch {
    // Unable to determine cleanliness -> fail closed, skip auto-commit.
    return true;
  }
}

function collectAutoCommitGitFacts(
  projectDir: string,
  relRoadmapPath: string,
  preDirty: boolean,
): AutoCommitGitFacts {
  const isGitWorkTree = isInsideGitWorkTree(projectDir);
  const gitDir = isGitWorkTree ? resolveGitDir(projectDir) : null;
  return {
    isGitWorkTree,
    operationInProgress: isGitWorkTree ? isGitOperationInProgress(gitDir) : true,
    isTracked: isGitWorkTree ? isRoadmapTracked(projectDir, relRoadmapPath) : false,
    preDirty,
  };
}

/**
 * Mirrors `formatCommitEntry`'s prefix construction but is kept separate --
 * `formatCommitEntry`'s output is pinned by existing tests and must not
 * change shape to accommodate this message.
 */
function buildAutoCommitMessage(commit: ParsedCommit): string {
  const typeLabel = commit.type !== 'other' ? commit.type : '';
  const scopeLabel = commit.scope ? `(${commit.scope})` : '';
  const prefix = typeLabel && scopeLabel ? `${typeLabel}${scopeLabel}: ` :
                 typeLabel ? `${typeLabel}: ` :
                 scopeLabel ? `${scopeLabel} ` : '';
  const hashLabel = commit.hash ? ` \`${commit.hash.slice(0, 7)}\`` : '';
  return `chore(roadmap): record ${prefix}${commit.description}${hashLabel}`;
}

interface AutoCommitResult {
  committed: boolean;
  commitHash: string | null;
  failureReason?: string;
}

/**
 * Item E: options MUST precede `--` --
 * `git commit --only -m "<msg>" -- ROADMAP.md`. After `--`, git treats every
 * token as a pathspec, so putting `-m` there makes it a bogus pathspec
 * (error) or drops to an interactive editor (hangs the hook). NEVER
 * `--amend` -- that would change the hash we just wrote into ROADMAP.md,
 * pointing the entry at a commit that no longer exists.
 *
 * Item H: `windows-platform.md` documents this repo manufacturing an MSYS
 * fork storm on every commit, and that `msys-crash.jsonl` only sees
 * `git-safe.ps1`-wrapped git -- a raw execFileSync crash here would otherwise
 * be invisible. Every failure is caught here and degrades to exactly today's
 * behaviour (ROADMAP.md written, left uncommitted) -- never worse -- with the
 * captured stderr riding in the audit record's `reason` field: this file does
 * not own `shared/roadmap-audit.ts` and its `RoadmapAuditRecord` shape has no
 * dedicated stderr field, so it is embedded (truncated) there instead of
 * being silently dropped.
 */
function attemptRoadmapAutoCommit(projectDir: string, commit: ParsedCommit): AutoCommitResult {
  const message = buildAutoCommitMessage(commit);
  try {
    const stdout = execFileSync(
      'git',
      ['-C', projectDir, 'commit', '--only', '-m', message, '--', 'ROADMAP.md'],
      { cwd: projectDir, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf-8' },
    );
    const match = stdout.match(COMMIT_PATTERNS.commitOutput);
    return { committed: true, commitHash: match ? match[2] : null };
  } catch (err) {
    const anyErr = err as { killed?: boolean; stderr?: string | Buffer; message?: string };
    const stderrText = anyErr.stderr
      ? (Buffer.isBuffer(anyErr.stderr) ? anyErr.stderr.toString('utf-8') : String(anyErr.stderr))
      : (anyErr.message ?? String(err));
    const isTimeout = Boolean(anyErr.killed);
    const reasonTag = isTimeout ? 'commit_timeout' : 'commit_failed';
    const clipped = stderrText.slice(0, 500).replace(/\s+/g, ' ').trim();
    return { committed: false, commitHash: null, failureReason: `${reasonTag}: ${clipped}` };
  }
}

async function main() {
  const input = await readStdin();
  if (!input.trim()) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  let data: PostToolUseInput;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Under cursor-agent (the review engine): no ROADMAP.md write and no git commit in the reviewed tree. (card engine-run-hook-files).
  if (isEngineHost(data)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  // Both shell tools carry the command in `tool_input.command`, so both can
  // produce a commit this hook must record.
  //
  // This gate is the SECOND of two layers, and forgetting it is what made the
  // 2026-08-05 matcher fix inert. Widening the settings.json matcher to
  // `Bash|PowerShell` let the event reach the hook; this line then dropped it
  // anyway, so the symptom (PowerShell commits go unrecorded) did not move and
  // looked exactly like a wrong matcher string. When a registration is widened,
  // widen the runtime check in the same change -- grep the hook for its own
  // tool_name comparison before believing a matcher edit did anything.
  if (!COMMAND_TOOLS.has(data.tool_name)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const command = (data.tool_input?.command as string) || '';
  if (!isGitCommitCommand(command)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  let response: string;
  if (typeof data.tool_response === 'string') {
    response = data.tool_response;
  } else if (data.tool_response && typeof (data.tool_response as any).output === 'string') {
    response = (data.tool_response as any).output;
  } else if (data.tool_response && typeof (data.tool_response as any).stdout === 'string') {
    response = (data.tool_response as any).stdout;
  } else {
    response = JSON.stringify(data.tool_response || '');
  }

  if (!isSuccessfulCommit(response)) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const commit = parseCommitFromOutput(response);
  if (!commit) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  if (commit.isAmend) {
    console.error('ℹ Skipping amend commit (no duplicate entries)');
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  if (commit.isMerge) {
    console.error('ℹ Skipping merge commit');
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  if (SKIP_TYPES.has(commit.type)) {
    console.error(`ℹ Skipping ${commit.type} commit`);
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // D2d-10: verify the commit actually ran in THIS project before recording it.
  // A `cd <other-repo> && git commit` (routine for ~/.claude quick fixes) must
  // not write a foreign repo's commit into the session project's ROADMAP.
  if (!commitRanInProject(command, projectDir)) {
    console.error('ℹ Skipping commit that ran outside this project directory');
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const roadmapPath = findRoadmapPath(projectDir);

  if (!roadmapPath) {
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const content = fs.readFileSync(roadmapPath, 'utf-8');

  if (isDuplicateEntry(content, commit)) {
    console.error('ℹ Skipping duplicate entry');
    console.log(JSON.stringify({ result: 'continue' }));
    return;
  }

  const relRoadmapPath = path.relative(projectDir, roadmapPath) || 'ROADMAP.md';

  // Item B: capture dirtiness BEFORE this hook's own write -- this is what
  // guarantees the only ROADMAP.md diff in an auto-commit is ours. A file
  // already modified before we touched it must never get folded into our
  // commit.
  const preDirty = isRoadmapPreDirty(projectDir, relRoadmapPath);

  const today = localDateStamp();
  const entry = formatCommitEntry(commit, today);
  const updated = appendToCompleted(content, entry);

  const beforeLineCount = content.split('\n').length;
  const afterLineCount = updated.split('\n').length;

  // Item C: route the write through the guarded path. appendToCompleted is a
  // pure insert (delegates to insertUnderSection), so no allowedDeletions.
  const guardResult = writeRoadmapGuarded({
    hook: 'git-commit-roadmap',
    tool: data.tool_name,
    roadmapPath,
    projectDir,
    before: content,
    after: updated,
    ops: [
      {
        label: 'completed-append',
        lines_removed: 0,
        lines_added: Math.max(0, afterLineCount - beforeLineCount),
      },
    ],
    sessionId: data.session_id,
  });

  if (guardResult.outcome !== 'written') {
    const reasonSuffix = guardResult.record.reason ? `: ${guardResult.record.reason}` : '';
    console.error(`ℹ ROADMAP.md write skipped (${guardResult.outcome}${reasonSuffix})`);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `⚠️ ROADMAP.md entry NOT recorded (${guardResult.outcome}${reasonSuffix}). Commit was left untouched.`,
      },
    }));
    return;
  }

  const typeDesc = commit.type !== 'other' ? `${commit.type}: ` : '';
  const scopeDesc = commit.scope ? `(${commit.scope}) ` : '';

  console.error(`✓ ROADMAP.md: ${typeDesc}${scopeDesc}${commit.description}`);

  // Items D-H: the H2 auto-commit follow-on. Only attempted after a
  // successful (`written`) guarded write, so audit record #2 always has a
  // record #1 to correlate against (by `before_sha256`) -- a mid-commit kill
  // loses only this second record, never the ROADMAP.md write itself.
  const gitFacts = collectAutoCommitGitFacts(projectDir, relRoadmapPath, preDirty);
  const decision = shouldAutoCommitRoadmap({
    roadmapPath,
    projectDir,
    isGitWorkTree: gitFacts.isGitWorkTree,
    operationInProgress: gitFacts.operationInProgress,
    isTracked: gitFacts.isTracked,
    preDirty: gitFacts.preDirty,
  });

  if (!decision.ok) {
    appendRoadmapAuditRecord(projectDir, {
      ...guardResult.record,
      ts: new Date().toISOString(),
      committed: false,
      reason: decision.reason,
    });
  } else {
    const autoCommit = attemptRoadmapAutoCommit(projectDir, commit);
    appendRoadmapAuditRecord(projectDir, {
      ...guardResult.record,
      ts: new Date().toISOString(),
      committed: autoCommit.committed,
      commit_hash: autoCommit.commitHash,
      reason: autoCommit.failureReason,
    });
    if (!autoCommit.committed) {
      console.error(`ℹ ROADMAP.md auto-commit skipped: ${autoCommit.failureReason}`);
    }
  }

  const output: HookOutput = {
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `📋 ROADMAP updated: ${commit.description}` },
  };

  console.log(JSON.stringify(output));
}

main().catch((err) => {
  console.error('[git-commit-roadmap] Error:', err.message);
  console.log(JSON.stringify({ result: 'continue' }));
});
