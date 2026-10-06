/**
 * done-proof: is there proof that this change works? One judge for two callers
 * (commit-preflight on `git commit`, test-before-done on TaskUpdate completed).
 *
 * Two kinds of proof, both read from disk:
 *   - the session's last test run (`$TEMP/claude-recent-test-runs-<session>.json`, written by
 *     test-run-tracker), and
 *   - the newest verify sidecar (`<repo>/.claude/cache/e2e/*.log.json`, written by
 *     `.claude/scripts/verify.mjs`).
 *
 * A ratchet (context-budget-guard, audit-skills) measures size. It is not proof that the change
 * works, so it never counts as a test run here.
 *
 * Known limit: edits made after verify ran and before the commit are not detected. The `head`
 * check only catches "no verify since the last commit".
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { getStateFile } from './test-run-state.js';

const MIN = 60_000;
/** A test run or passing sidecar this recent is proof. */
export const PROOF_WINDOW_MS = 5 * MIN;
/** A failed, killed or stale sidecar this recent is worth a warning. */
export const FAILURE_WINDOW_MS = 30 * MIN;
const VERIFY = 'node ~/.claude/scripts/verify.mjs';

export interface TestRun {
  lastTestRun: number;
  command?: string;
  /** true = passed, false = failed, null = unknown (a state file from before the field). */
  ok: boolean | null;
}

export interface Sidecar {
  exit: number | null;
  started: string | null;
  finished: string | null;
  head: string | null;
  artifact?: string;
}

export type VerdictKind = 'proven' | 'failed' | 'killed' | 'stale' | 'none';
export interface Verdict {
  kind: VerdictKind;
  /** Empty when kind is `proven`. */
  message: string;
}

export interface JudgeInput {
  run: TestRun | null;
  sidecar: Sidecar | null;
  /** Full HEAD sha of the repo; null when unknown. */
  head: string | null;
  /** The repo's registry entry has an `e2e` key. Without it, `none` is silent. */
  hasE2e: boolean;
  now: number;
}

const RATCHETS = [/\bcontext-budget-guard\b/, /\baudit-skills\b/];

export function isRatchet(command: string | undefined): boolean {
  return !!command && RATCHETS.some((re) => re.test(command));
}

export function readTestRun(sessionId: string | undefined): TestRun | null {
  try {
    const file = getStateFile(sessionId);
    if (!file || !existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    const s = JSON.parse(raw);
    if (typeof s?.lastTestRun !== 'number' || !s.lastTestRun) return null;
    return {
      lastTestRun: s.lastTestRun,
      command: typeof s.command === 'string' ? s.command : undefined,
      ok: typeof s.ok === 'boolean' ? s.ok : null,
    };
  } catch {
    return null;
  }
}

const MAX_SIDECARS = 50;

/** The sidecar with the newest `started`. Reads only the newest files by mtime. */
export function latestSidecar(repoRoot: string): Sidecar | null {
  const dir = join(repoRoot, '.claude', 'cache', 'e2e');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.log.json'));
  } catch {
    return null;
  }
  const newest = names
    .map((n) => {
      try { return { n, t: statSync(join(dir, n)).mtimeMs }; } catch { return { n, t: 0 }; }
    })
    .sort((a, b) => b.t - a.t)
    .slice(0, MAX_SIDECARS);
  let best: Sidecar | null = null;
  let bestAt = -Infinity;
  for (const { n } of newest) {
    try {
      const j = JSON.parse(readFileSync(join(dir, n), 'utf8'));
      const at = Date.parse(j.started);
      if (Number.isNaN(at) || at <= bestAt) continue;
      bestAt = at;
      best = {
        exit: typeof j.exit === 'number' ? j.exit : null,
        started: typeof j.started === 'string' ? j.started : null,
        finished: typeof j.finished === 'string' ? j.finished : null,
        head: typeof j.head === 'string' ? j.head : null,
        artifact: typeof j.artifact === 'string' ? j.artifact : undefined,
      };
    } catch {
      // a half-written or foreign file: skip it
    }
  }
  return best;
}

const normPath = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');

export const defaultRegistryPath = (): string => join(homedir(), '.claude', 'project-registry.json');

/**
 * True when a registry entry whose `path` equals the repo root (or the main root of a linked
 * worktree) has an `e2e` key. Fails open: a missing or broken registry gives false, so the
 * `none` verdict stays silent.
 */
export function hasE2e(repoRoot: string, mainRoot: string | null, registryPath: string = defaultRegistryPath()): boolean {
  try {
    const reg = JSON.parse(readFileSync(registryPath, 'utf8').replace(/^\uFEFF/, ''));
    const roots = new Set([normPath(repoRoot), ...(mainRoot ? [normPath(mainRoot)] : [])]);
    return (reg.projects ?? []).some(
      (p: any) => p && typeof p.path === 'string' && roots.has(normPath(p.path)) && p.e2e !== undefined && p.e2e !== null,
    );
  } catch {
    return false;
  }
}

const sidecarAt = (s: Sidecar): number => Date.parse(s.finished ?? s.started ?? '');

/** Clock skew allowed for a timestamp that is slightly in the future. */
const SKEW_MS = MIN;

/** Fresh: from `SKEW_MS` in the future up to `window` old. NaN is never fresh. */
const fresh = (at: number, now: number, window: number): boolean => now - at > -SKEW_MS && now - at < window;

/** A test run that counts as proof: recent, not a ratchet, not failed. */
export function runProves(run: TestRun | null, now: number): boolean {
  return !!run && fresh(run.lastTestRun, now, PROOF_WINDOW_MS) && !isRatchet(run.command) && run.ok !== false;
}

const HEX_HEAD = /^[0-9a-f]{7,40}$/i;

/** The sidecar head is a git sha prefix (7 or more hex characters) of HEAD. */
function headMatches(sidecar: Sidecar, head: string | null): boolean {
  return !!sidecar.head && !!head && HEX_HEAD.test(sidecar.head) && head.toLowerCase().startsWith(sidecar.head.toLowerCase());
}

function sidecarProves(s: Sidecar, head: string | null, now: number): boolean {
  if (s.exit !== 0 || !s.finished) return false;
  return fresh(Date.parse(s.finished), now, PROOF_WINDOW_MS) && headMatches(s, head);
}

const shortCmd = (c: string | undefined): string => (c ?? 'unknown command').replace(/\s+/g, ' ').slice(0, 120);

interface Failure {
  verdict: Verdict;
  /** When the failing evidence was recorded (epoch ms). */
  at: number;
}

/**
 * A failed or unfinished record in the last 30 minutes. A ratchet is never a test run, so a red
 * ratchet is not a failure. A record older than the evidence on the other side is not reported:
 * the sidecar failure needs to be newer than the last test run, and a failed run needs to be newer
 * than a passing sidecar.
 */
function failure(run: TestRun | null, s: Sidecar | null, now: number): Failure | null {
  const counted = run && !isRatchet(run.command) ? run : null;
  const sAt = s ? sidecarAt(s) : NaN;
  const sRecent = !!s && fresh(sAt, now, FAILURE_WINDOW_MS);
  const sidecarIsNewest = !counted || sAt >= counted.lastTestRun;
  if (s && sRecent && sidecarIsNewest && typeof s.exit === 'number' && s.exit !== 0) {
    const message = `last verify exited ${s.exit} (${s.artifact ?? 'no artifact'}): fix and re-run ${VERIFY}`;
    return { verdict: { kind: 'failed', message }, at: sAt };
  }
  const passedSince = !!s && s.exit === 0 && sAt > (counted?.lastTestRun ?? Infinity);
  if (counted && counted.ok === false && fresh(counted.lastTestRun, now, FAILURE_WINDOW_MS) && !passedSince) {
    const message = `last test run failed (${shortCmd(counted.command)}): fix it and re-run it, or run ${VERIFY}`;
    return { verdict: { kind: 'failed', message }, at: counted.lastTestRun };
  }
  if (s && sRecent && sidecarIsNewest && s.exit === null) {
    const message = `last verify (${s.artifact ?? 'no artifact'}) is still running or was killed: let it finish or re-run ${VERIFY}`;
    return { verdict: { kind: 'killed', message }, at: sAt };
  }
  return null;
}

/**
 * The newest evidence wins. A failed or unfinished record that is newer than the newest proof
 * overrides it; older failures never hide a newer proof.
 */
export function judge(i: JudgeInput): Verdict {
  const { run, sidecar, head, now } = i;
  const proofAt = Math.max(
    runProves(run, now) ? run!.lastTestRun : -Infinity,
    sidecar && sidecarProves(sidecar, head, now) ? sidecarAt(sidecar) : -Infinity,
  );
  const bad = failure(run, sidecar, now);
  if (bad && bad.at > proofAt) return bad.verdict;
  if (proofAt > -Infinity) return { kind: 'proven', message: '' };
  if (sidecar && sidecar.exit === 0 && sidecar.head && head && !headMatches(sidecar, head) && fresh(sidecarAt(sidecar), now, FAILURE_WINDOW_MS)) {
    return { kind: 'stale', message: `verify ran on ${sidecar.head}, HEAD is ${head.slice(0, 7)}: re-run ${VERIFY}` };
  }
  if (!i.hasE2e) return { kind: 'proven', message: '' };
  return {
    kind: 'none',
    message: `no test run or verify sidecar in the last 5 minutes: run ${VERIFY} and cite its output`,
  };
}
