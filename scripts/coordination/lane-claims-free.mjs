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
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';

const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p) => (FOLD ? p.toLowerCase() : p);
const CHUNK = 100;
const TIMEOUT_MS = 10000;

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
  if (r.error || r.status !== 0) {
    const why = (r.error?.message || r.stderr || `status ${r.status}`).trim().split('\n')[0];
    throw new Error(`git ${args[0]} failed in ${dir}: ${why}`);
  }
  return r.stdout;
}

/** The files a merge commit brought to main: its diff against the first parent. */
export function mergedFiles(dir, sha) {
  return git(dir, ['diff', '--name-only', '-z', `${sha}^1`, sha]).split('\0').filter(Boolean);
}

/** Repo-relative names with uncommitted changes in any live worktree of the clone. A rename counts both names. */
export function dirtyFiles(dir) {
  const dirty = new Set();
  const blocks = git(dir, ['worktree', 'list', '--porcelain']).split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const wt = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!wt || lines.includes('bare') || !fs.existsSync(wt)) continue;
    const parts = git(wt, ['status', '--porcelain', '-z', '--untracked-files=no']).split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      dirty.add(norm(e.slice(3)));
      if (e[0] === 'R' || e[0] === 'C') dirty.add(norm(parts[++i] ?? ''));
    }
  }
  return dirty;
}

/** Run release-claim on `files` in `dir` as `sessionId`. Returns freed count and the other holders' counts. */
function release(bin, dir, files, sessionId) {
  const out = { freed: 0, kept: 0, holders: new Map() };
  for (let i = 0; i < files.length; i += CHUNK) {
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId };
    const r = spawnSync(process.execPath, [bin, ...files.slice(i, i + CHUNK)], { cwd: dir, env, encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true });
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
 */
export function freeMergedClaims({ dir, sha, sessionId, repoRoot }) {
  const bin = process.env.LANE_RELEASE_CLAIM_BIN || join(repoRoot, '.claude', 'hooks', 'dist', 'release-claim.mjs');
  const files = mergedFiles(dir, sha);
  const dirty = dirtyFiles(dir);
  const clean = files.filter((f) => !dirty.has(norm(f)));
  const r = clean.length ? release(bin, dir, clean, sessionId) : { freed: 0, kept: 0, holders: new Map() };
  return { ...r, dirty: files.length - clean.length };
}
