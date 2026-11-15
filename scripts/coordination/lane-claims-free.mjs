/**
 * lane-claims-free -- after `done --merged`, free the CALLER's own file claims on the merged files
 * (card coord-land-frees-claims).
 *
 * A file claim belongs to a session. A builder lives on after its card lands, so without this its claims on the
 * landed files stay held and block the next builder. The free reuses the built `release-claim.mjs`:
 *  - holder only: its DELETE has `session_id = <caller>`, so another session's claim is never freed;
 *  - the key is built by the same resolver the file-claims hook uses (repo-relative name in the shared git dir),
 *    so a claim made in a removed worktree matches a name from the board root;
 *  - the delete and its `claim_released` event are one transaction.
 * A merged file with uncommitted changes in any live worktree of the clone keeps its claim (a second card may be
 * editing it). A worktree whose status cannot be read stops the free: nothing is freed (fails safe).
 * The whole step has ONE time budget (20 s; the 16 worktrees of 11-15 took 2.5 s). Each git and release-claim
 * run gets only the time that is left. Past the budget the step throws before any release, so nothing is freed.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';

const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p) => (FOLD ? p.toLowerCase() : p);
const CHUNK = 100;
export const BUDGET_MS = 20000;

/** A deadline for one free step. `left()` throws once the budget is spent. */
function budget(ms) {
  const end = Date.now() + ms;
  return () => {
    const left = end - Date.now();
    if (left <= 0) throw new Error(`time budget of ${Math.round(ms / 1000)} s passed, nothing freed`);
    return left;
  };
}
const NO_BUDGET = () => 600000;
/** A child that spawnSync killed at its timeout: the budget ran out while it ran. */
const timedOut = (r) => r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal);
const OUT_OF_TIME = 'time budget passed while a child ran, nothing more freed';

function git(dir, args, left = NO_BUDGET) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: left(), windowsHide: true });
  if (timedOut(r)) throw new Error(`${OUT_OF_TIME} (git ${args[0]})`);
  if (r.error || r.status !== 0) {
    const why = (r.error?.message || r.stderr || `status ${r.status}`).trim().split('\n')[0];
    throw new Error(`git ${args[0]} failed in ${dir}: ${why}`);
  }
  return r.stdout;
}

/** The files a merge commit brought to main: its diff against the first parent. */
export function mergedFiles(dir, sha, left = NO_BUDGET) {
  return git(dir, ['diff', '--name-only', '-z', `${sha}^1`, sha], left).split('\0').filter(Boolean);
}

/** Repo-relative names with uncommitted changes in any live worktree of the clone. A rename counts both names. */
export function dirtyFiles(dir, left = NO_BUDGET) {
  const dirty = new Set();
  const blocks = git(dir, ['worktree', 'list', '--porcelain'], left).split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const wt = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!wt || lines.includes('bare') || !fs.existsSync(wt)) continue;
    const parts = git(wt, ['status', '--porcelain', '-z', '--untracked-files=no'], left).split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      dirty.add(norm(e.slice(3)));
      if (e[0] === 'R' || e[0] === 'C') dirty.add(norm(parts[++i] ?? ''));
    }
  }
  return dirty;
}

/**
 * Run release-claim on `files` in `dir` as `sessionId`. Returns freed count and the other holders' counts.
 * OUTPUT CONTRACT of release-claim (.claude/hooks/src/release-claim.ts): the lines come from `describe()`
 * ("freed: <file>" and "held by another session (<session id>), not freed: <path>"), and exit 4 means "some path
 * was not freed" (`releaseCommand`, header "Exit:" lines). lane-done-frees-claims.test.mjs fails when a text
 * changes: the "freed 1 of your file claims" note, the "#<sid8> ... holds 1 merged file" note and the --json
 * `claims.freed` count are all counted from these lines.
 */
function release(bin, dir, files, sessionId, left) {
  const out = { freed: 0, kept: 0, holders: new Map() };
  for (let i = 0; i < files.length; i += CHUNK) {
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId };
    const r = spawnSync(process.execPath, [bin, ...files.slice(i, i + CHUNK)], { cwd: dir, env, encoding: 'utf8', timeout: left(), windowsHide: true });
    if (timedOut(r)) throw new Error(`${OUT_OF_TIME} (release-claim)`);
    if (r.error) throw new Error(`release-claim did not run: ${r.error.message}`);
    if (r.status !== 0 && r.status !== 4) throw new Error((r.stderr || '').trim().split('\n')[0] || `release-claim exit ${r.status}`);
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('freed: ')) out.freed++;
      const m = /^held by another session \(([^)]+)\), not freed: /.exec(line);
      if (m) { out.kept++; out.holders.set(m[1], (out.holders.get(m[1]) ?? 0) + 1); }
    }
  }
  return out;
}

/**
 * Free the caller's own claims on the files of merge `sha`. Throws on any failure; the caller turns that into a note.
 * Returns { freed, kept, dirty, holders } where holders maps another session id to its count of merged files.
 * `budgetMs` defaults to BUDGET_MS; LANE_CLAIMS_FREE_BUDGET_MS overrides it (the test of the budget uses it).
 */
export function freeMergedClaims({ dir, sha, sessionId, repoRoot, budgetMs }) {
  const ms = budgetMs ?? (Number(process.env.LANE_CLAIMS_FREE_BUDGET_MS) || BUDGET_MS);
  const left = budget(ms);
  const bin = process.env.LANE_RELEASE_CLAIM_BIN || join(repoRoot, '.claude', 'hooks', 'dist', 'release-claim.mjs');
  const files = mergedFiles(dir, sha, left);
  const dirty = dirtyFiles(dir, left);
  const clean = files.filter((f) => !dirty.has(norm(f)));
  const r = clean.length ? release(bin, dir, clean, sessionId, left) : { freed: 0, kept: 0, holders: new Map() };
  return { ...r, dirty: files.length - clean.length };
}
