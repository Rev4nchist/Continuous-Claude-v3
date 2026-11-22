/**
 * The stricter of main and the branch for review-router.config.json (card coord-cap-override, PR A).
 * The TypeScript twin of scripts/github/config-stricter.mjs. One fixture test (scripts/github/fixtures/stricter-config-cases.json,
 * run by config-stricter-twin.test.ts) fails when the two copies differ. Read the .mjs file for the rule.
 * Known limit: a stale local fork/main is still stricter than trusting the branch alone.
 */
const CONFIG_FILE = 'review-router.config.json';
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const validCap = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const sub = (o: Obj | null | undefined, key: string): Obj | undefined => (o && isObj(o[key]) ? (o[key] as Obj) : undefined);

export interface ConfigView { enforce: boolean; cap: number | null; summaryFail: boolean }

export function viewOf(cfg: unknown): ConfigView {
  const c = isObj(cfg) ? cfg : null;
  const cap = sub(c, 'coderabbit')?.cli_daily_cap_usd;
  return {
    enforce: sub(c, 'checkpoint')?.enforce === true,
    cap: validCap(cap) ? cap : null,
    summaryFail: sub(c, 'pre_pr')?.summary_mode === 'fail',
  };
}

/**
 * The main side of a read that failed: every key is present and none holds its weak value, so the one rule in stricterConfig makes all three strict.
 * (A read that failed is not "no main side": that is null, which enforces but keeps the branch cap and mode.)
 */
export const UNREADABLE_MAIN: Obj = {
  checkpoint: { enforce: 'unreadable' },
  coderabbit: { cli_daily_cap_usd: 'unreadable' },
  pre_pr: { summary_mode: 'unreadable' },
};

/** The main value of a key: set is true when the key is present on main. A block that is present but not an object counts as set with no weak value. */
function mainKey(m: Obj, block: string, key: string): { set: boolean; value: unknown } {
  if (!Object.hasOwn(m, block)) return { set: false, value: undefined };
  const b = m[block];
  if (!isObj(b)) return { set: true, value: undefined };
  return Object.hasOwn(b, key) ? { set: true, value: b[key] } : { set: false, value: undefined };
}

/**
 * A copy of `branch` with the three keys at their stricter value. `main` null means no main side could be read.
 * One rule for the main side: a value that is present but is not the exact weak value counts as the strict value.
 * The weak values are: enforce the boolean false, a cap that is a valid number (a present invalid cap counts as 0), the mode 'note'. Pure.
 */
export function stricterConfig(main: unknown, branch: unknown): Obj {
  const out: Obj = isObj(branch) ? structuredClone(branch) : {};
  const m = isObj(main) ? main : null;
  const block = (name: string): Obj => sub(out, name) ?? {};

  const mainEnforce = m === null ? { set: false, value: undefined } : mainKey(m, 'checkpoint', 'enforce');
  const checkpoint = sub(out, 'checkpoint');
  const branchSets = checkpoint !== undefined && Object.hasOwn(checkpoint, 'enforce');
  const enforce = m === null || (mainEnforce.set && mainEnforce.value !== false) || (branchSets && checkpoint?.enforce !== false);
  out.checkpoint = { ...block('checkpoint'), enforce };

  const mainCap = m === null ? { set: false, value: undefined } : mainKey(m, 'coderabbit', 'cli_daily_cap_usd');
  const caps = [mainCap.set ? (validCap(mainCap.value) ? mainCap.value : 0) : undefined, sub(out, 'coderabbit')?.cli_daily_cap_usd].filter(validCap);
  if (caps.length > 0) out.coderabbit = { ...block('coderabbit'), cli_daily_cap_usd: Math.min(...caps) };

  const mainMode = m === null ? { set: false, value: undefined } : mainKey(m, 'pre_pr', 'summary_mode');
  if ((mainMode.set && mainMode.value !== 'note') || sub(out, 'pre_pr')?.summary_mode === 'fail') out.pre_pr = { ...block('pre_pr'), summary_mode: 'fail' };
  return out;
}

function objectOf(text: string | null | undefined): Obj | null {
  if (typeof text !== 'string') return null;
  try { const v: unknown = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; }
}

type Git = (cwd: string, args: string[]) => { status: number; stdout: string };

// FULL ref names: an abbreviated fork/main can be shadowed by a local branch of that name or by a tag (git picks heads and tags before remotes).
const FORK_REF = 'refs/remotes/fork/main';
const LOCAL_REF = 'refs/heads/main';

/** Does `ref` exist? 'yes' (exit 0), 'no' (exit 1, the quiet answer for a missing ref) or 'error' (any other exit, or git threw). */
function refState(top: string, git: Git, ref: string): 'yes' | 'no' | 'error' {
  try {
    const run = git(top, ['rev-parse', '--verify', '--quiet', ref]);
    return run.status === 0 ? 'yes' : run.status === 1 ? 'no' : 'error';
  } catch { return 'error'; }
}

/** The committed config at `ref` (a ref that exists), or null when git show fails or the text is not a JSON object. Never a fetch. */
function committedConfig(top: string, git: Git, ref: string): Obj | null {
  try {
    const shown = git(top, ['show', `${ref}:${CONFIG_FILE}`]);
    return shown.status === 0 ? objectOf(shown.stdout) : null;
  } catch { return null; }
}

/**
 * The main side of the config for the checkout at `top`: refs/remotes/fork/main (git show, never a fetch), else refs/heads/main, and that
 * fallback ONLY when the fork ref does not exist. Both are committed text. A working-tree file is never read: it holds whatever the checked-out
 * branch edited. A ref that exists but cannot be read, or a git error, gives UNREADABLE_MAIN (strict for all three keys, no fallback).
 * Neither ref exists: null.
 */
export function mainConfigOf(top: string, git: Git): Obj | null {
  const fork = refState(top, git, FORK_REF);
  if (fork === 'error') return UNREADABLE_MAIN;
  if (fork === 'yes') return committedConfig(top, git, FORK_REF) ?? UNREADABLE_MAIN;
  const local = refState(top, git, LOCAL_REF);
  if (local === 'error') return UNREADABLE_MAIN;
  if (local === 'yes') return committedConfig(top, git, LOCAL_REF) ?? UNREADABLE_MAIN;
  return null;
}
