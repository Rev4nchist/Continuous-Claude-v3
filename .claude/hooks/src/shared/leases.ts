/**
 * Lease classes and their TTLs.
 *
 * THE INTERVAL THIS IS MEASURED AGAINST
 * -------------------------------------
 * An earlier draft of the plan justified these TTLs against the ~3s worst-case
 * hook latency, which is the wrong interval by three orders of magnitude. The
 * critical section a file lease protects is not the hook call — it is the
 * HUMAN's edit-and-think session. A 10-minute lease can expire while somebody is
 * simply reading the file they are about to change.
 *
 * That is survivable only because of two rules that are load-bearing, not
 * decorative:
 *
 *   1. Leases renew on ACTIVITY. Every Edit/Write by the holder pushes
 *      expires_at out again (see resolveFileClaim). A lease therefore measures
 *      "time since you last did something", never "time since you started".
 *   2. Expiry alone NEVER reclaims. Reclamation additionally requires the
 *      holder's session heartbeat to be stale, so an idle-but-alive terminal is
 *      not preempted. Either condition alone is what produced the original false
 *      positives, where a session's own claims became reclaimable while it was
 *      actively editing.
 *
 * WHY harness:src IS SIX TIMES LONGER
 * -----------------------------------
 * ~/.claude/ is a single global directory: every session on this machine runs
 * the same dist/*.mjs. Two sessions editing hook source concurrently do not
 * produce a merge conflict, they produce a machine whose harness is a mix of two
 * half-applied changes — and the mirror step is itself unserialized. The cost of
 * being wrong is asymmetric, so the lease is long and reclamation is slow.
 *
 * NOT YET HERE
 * ------------
 * The plan also specifies `git-index:`/`build:` at 90s and `work_claim` at
 * 30min. Neither is represented in this file because neither has a resource to
 * classify yet: file_claims holds file paths, and those two classes key on
 * things that arrive with steps 11 and 9 respectively. They are deliberately
 * absent rather than declared-and-unreachable — an unused branch here would read
 * as coverage in exactly the way this codebase has been burned by before.
 */

/** Lease classes that a *file path* can currently resolve to. */
export type LeaseClass = 'file' | 'harness:src';

export interface Lease {
  leaseClass: LeaseClass;
  ttlMs: number;
}

export const FILE_LEASE_MS = 10 * 60 * 1000;
export const HARNESS_LEASE_MS = 60 * 60 * 1000;

/**
 * Directories whose contents ARE the harness.
 *
 * Matched as a path segment anywhere in the path, so this deliberately covers
 * both `<any repo>/.claude/hooks/...` and the live `~/.claude/hooks/...`. The
 * live copy is if anything the more dangerous of the two: edits there take
 * effect for every session on the machine with no commit, no review and no sync
 * step in between.
 */
const HARNESS_DIRS = ['hooks', 'rules', 'skills'];

/**
 * Does this path address harness source?
 *
 * Exported for the probe, which asserts the classification directly rather than
 * inferring it from an observed TTL — a TTL is a number that could be right for
 * the wrong reason.
 */
export function isHarnessPath(filePath: string): boolean {
  // Windows hands us backslashes from some call sites and forward slashes from
  // others (the same split that put one repo under two project keys and cost
  // 5,737 rows). Normalize before matching, and lowercase because Windows paths
  // are case-insensitive.
  //
  // A claim key is repo-relative (shared/claim-target.ts), so a harness file can arrive as
  // `.claude/hooks/x.ts` with no leading slash. The segment test below needs a slash before
  // `.claude`: put one there. An absolute path still matches, and so does the settings basename.
  const p = `/${filePath.replace(/\\/g, '/')}`.toLowerCase();

  for (const dir of HARNESS_DIRS) {
    if (p.includes(`/.claude/${dir}/`)) return true;
  }

  // settings.json, settings.local.json, settings.json.template — the harness
  // configuration, wherever it lives. Matched on the BASENAME so that a path
  // merely containing the word settings does not qualify.
  //
  // Note what this excludes on purpose: settings.json.bak-step4 does not end in
  // .json and is a rollback copy, not a live config. Claiming it for an hour
  // would be a lease on a file nothing reads.
  const base = p.split('/').pop() ?? '';
  if (/^settings[^/]*\.json$/.test(base)) return true;

  return false;
}

/**
 * The per-project memory index: `<any>/.claude/projects/<one folder>/memory/MEMORY.md`.
 *
 * It is one append point that EVERY session shares, so the file guard never holds it (card
 * coord-file-claims-memory-index). A short lease would not do: a takeover needs an expired lease AND a
 * holder quiet for 5 minutes, so an alive session keeps the file for as long as it works.
 *
 * Pass the CANONICAL path: the real path (links resolved), forward slashes. `fold` is true on a file
 * system that ignores case (win32, darwin). Narrow on purpose: another memory file, a MEMORY.md outside a
 * `memory` folder and one in a sub folder of `memory` are not the index. A string test only: no file read.
 */
export function isMemoryIndexPath(canonicalPath: string, fold: boolean): boolean {
  const p = canonicalPath.replace(/\\/g, '/');
  return (fold ? /(^|\/)\.claude\/projects\/[^/]+\/memory\/memory\.md$/i : /(^|\/)\.claude\/projects\/[^/]+\/memory\/MEMORY\.md$/).test(p);
}

/**
 * The lease a claim on this path should carry.
 */
export function leaseFor(filePath: string): Lease {
  return isHarnessPath(filePath)
    ? { leaseClass: 'harness:src', ttlMs: HARNESS_LEASE_MS }
    : { leaseClass: 'file', ttlMs: FILE_LEASE_MS };
}
