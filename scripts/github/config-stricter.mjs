// The stricter of main and the branch for review-router.config.json (card coord-cap-override, PR A).
// A branch must not loosen a gate by editing its own copy of the config. Three keys take the stricter value:
//   checkpoint.enforce           true wins (a branch value that is not the boolean false counts as true)
//   coderabbit.cli_daily_cap_usd the lower valid number wins (a branch value that is not a finite number of 0 or more is ignored)
//   pre_pr.summary_mode          'fail' wins
// Main side rule: a key that is present on main and is not its exact weak value counts as the strict value (enforce not false: true;
// cap not a valid number: 0; mode not 'note': fail). Every other key keeps the branch value. The main side is a COMMITTED ref, never a
// working-tree file (a working tree holds the branch's own edits): refs/remotes/fork/main first (no fetch), else refs/heads/main, and that
// fallback only when the fork ref does not exist. A ref that exists but cannot be read is strict for all three keys (UNREADABLE_MAIN).
// No ref at all: enforce true, and the branch cap and mode stay.
// Known limit: a stale local fork/main is still stricter than trusting the branch alone.
// The TypeScript twin is .claude/hooks/src/shared/config-stricter.ts. One fixture test (fixtures/stricter-config-cases.json) keeps them equal.
import path from 'node:path';

const CONFIG_FILE = 'review-router.config.json';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const validCap = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/** The facts the stricter rule covers, read from a config: { enforce, cap, summaryFail }. */
export function viewOf(cfg) {
  const cap = cfg?.coderabbit?.cli_daily_cap_usd;
  return {
    enforce: cfg?.checkpoint?.enforce === true,
    cap: validCap(cap) ? cap : null,
    summaryFail: cfg?.pre_pr?.summary_mode === 'fail',
  };
}

/**
 * The main side of a read that failed: every key is present and none holds its weak value, so the one rule below makes all three strict.
 * (A read that failed is not "no main side": that is null, which enforces but keeps the branch cap and mode.)
 */
export const UNREADABLE_MAIN = Object.freeze({
  checkpoint: Object.freeze({ enforce: 'unreadable' }),
  coderabbit: Object.freeze({ cli_daily_cap_usd: 'unreadable' }),
  pre_pr: Object.freeze({ summary_mode: 'unreadable' }),
});

/** The main value of a key: { set } is true when the key is present on main. A block that is present but not an object counts as set with no weak value. */
function mainKey(m, block, key) {
  if (!Object.hasOwn(m, block)) return { set: false, value: undefined };
  if (!isObj(m[block])) return { set: true, value: undefined };
  return Object.hasOwn(m[block], key) ? { set: true, value: m[block][key] } : { set: false, value: undefined };
}

/**
 * A copy of `branch` with the three keys at their stricter value. `main` null means no main side could be read.
 * One rule for the main side: a value that is present but is not the exact weak value counts as the strict value.
 * The weak values are: enforce the boolean false, a cap that is a valid number (a present invalid cap counts as 0), the mode 'note'.
 * Pure: neither input changes.
 */
export function stricterConfig(main, branch) {
  const out = isObj(branch) ? structuredClone(branch) : {};
  const m = isObj(main) ? main : null;
  const block = (name) => (isObj(out[name]) ? out[name] : {});

  const mainEnforce = m === null ? { set: false } : mainKey(m, 'checkpoint', 'enforce');
  const branchSets = isObj(out.checkpoint) && Object.hasOwn(out.checkpoint, 'enforce');
  const enforce = m === null || (mainEnforce.set && mainEnforce.value !== false) || (branchSets && out.checkpoint.enforce !== false);
  out.checkpoint = { ...block('checkpoint'), enforce };

  const mainCap = m === null ? { set: false } : mainKey(m, 'coderabbit', 'cli_daily_cap_usd');
  const caps = [mainCap.set ? (validCap(mainCap.value) ? mainCap.value : 0) : undefined, out.coderabbit?.cli_daily_cap_usd].filter(validCap);
  if (caps.length > 0) out.coderabbit = { ...block('coderabbit'), cli_daily_cap_usd: Math.min(...caps) };

  const mainMode = m === null ? { set: false } : mainKey(m, 'pre_pr', 'summary_mode');
  if ((mainMode.set && mainMode.value !== 'note') || out.pre_pr?.summary_mode === 'fail') out.pre_pr = { ...block('pre_pr'), summary_mode: 'fail' };
  return out;
}

/** The JSON object in `text`, or null (not a string, not JSON, not an object). */
function objectOf(text) {
  if (typeof text !== 'string') return null;
  try { const v = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; }
}

// FULL ref names: an abbreviated fork/main can be shadowed by a local branch of that name or by a tag (git picks heads and tags before remotes).
const FORK_REF = 'refs/remotes/fork/main';
const LOCAL_REF = 'refs/heads/main';

/** Does `ref` exist? 'yes' (exit 0), 'no' (exit 1, the quiet answer for a missing ref) or 'error' (any other exit, or git threw). */
function refState(git, ref) {
  try {
    const run = git(['rev-parse', '--verify', '--quiet', ref]);
    return run.status === 0 ? 'yes' : run.status === 1 ? 'no' : 'error';
  } catch { return 'error'; }
}

/** The committed config at `ref` (a ref that exists), or null when git show fails or the text is not a JSON object. No fetch. */
function committedConfig(git, ref) {
  try {
    const shown = git(['show', `${ref}:${CONFIG_FILE}`]);
    return shown.status === 0 ? objectOf(shown.stdout) : null;
  } catch { return null; }
}

/**
 * The main side: { config, source }. The ref refs/remotes/fork/main first (git show, no fetch), else refs/heads/main, and the fallback happens
 * ONLY when the fork ref does not exist. Both are committed text: a working-tree file is never read, because it holds whatever the checked-out
 * branch edited. A ref that exists but cannot be read (git show fails, bad JSON, not an object) or a git error gives UNREADABLE_MAIN: strict
 * for all three keys, never a fallback to the local main. Neither ref exists: { config: null, source: 'none' }. `git(args)` returns { status, stdout }.
 */
export function readMainConfig({ git }) {
  const fork = refState(git, FORK_REF);
  if (fork === 'error') return { config: UNREADABLE_MAIN, source: 'git-error' };
  if (fork === 'yes') {
    const config = committedConfig(git, FORK_REF);
    return config ? { config, source: 'fork-main' } : { config: UNREADABLE_MAIN, source: 'fork-main-unreadable' };
  }
  const local = refState(git, LOCAL_REF);
  if (local === 'error') return { config: UNREADABLE_MAIN, source: 'git-error' };
  if (local === 'yes') {
    const config = committedConfig(git, LOCAL_REF);
    return config ? { config, source: 'local-main' } : { config: UNREADABLE_MAIN, source: 'local-main-unreadable' };
  }
  return { config: null, source: 'none' };
}

/** The config a run uses: the branch file of `root` made stricter by the main side. Throws when the branch file is missing or not a JSON object. */
export function loadStricterConfig({ root, git, readFile }) {
  const file = path.join(root, CONFIG_FILE);
  const branch = objectOf(readFile(file, 'utf8'));
  if (branch === null) throw new Error(`${file} is missing or is not a JSON object`);
  return stricterConfig(readMainConfig({ git }).config, branch);
}
